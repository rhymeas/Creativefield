import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { member, HttpError } from "./auth";
import { transaction } from "./db";
import { hashToken, newId } from "./crypto";
import type { DiskStore } from "./storage";
import { canonical } from "./run-submission";
import { fileSha256 } from "./masked-media";
import { audioOperationRequestSchema } from "./audio-policy";
import { audioReadiness } from "./audio-processing-validation";
import { AUDIO_OPERATION_COLUMNS, AudioProcessingService } from "./audio-processing-execution";

const base = "/api/v1/workspaces/:workspaceId";
const ws = z.object({ workspaceId: z.uuid() });
const item = ws.extend({ id: z.uuid() });

export async function audioProcessingRoutes(app: FastifyInstance, pool: Pool, store: DiskStore) {
  const service = new AudioProcessingService(pool, store);
  app.get(`${base}/audio-requirements`, async request => {
    const { workspaceId } = ws.parse(request.params);
    await member(pool, request, workspaceId);
    return audioReadiness();
  });
  app.post(`${base}/audio-operations`, async request => {
    const { workspaceId } = ws.parse(request.params), user = await member(pool, request, workspaceId, "creator");
    const body = audioOperationRequestSchema.parse(request.body);
    const requestHash = hashToken(canonical(body));
    return transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`audio-request:${workspaceId}/${body.idempotencyKey}`]);
      const old = (await client.query(`SELECT ${AUDIO_OPERATION_COLUMNS},request_hash FROM audio_operations WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, body.idempotencyKey])).rows[0];
      if (old) {
        if (old.request_hash !== requestHash) throw new HttpError(409, "Idempotency key was already used for a different audio operation");
        delete old.request_hash;
        return old;
      }
      const readiness = await audioReadiness();
      if (readiness.state !== "ready") throw new HttpError(422, `Audio installation required: ${readiness.missing.join(", ")}. ${readiness.instructions}`);
      if (!(await client.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2", [workspaceId, body.projectId])).rowCount) {
        throw new HttpError(404, "Project not found");
      }
      const video = (await client.query("SELECT id,project_id,media_type,sha256,storage_key FROM assets WHERE workspace_id=$1 AND id=$2", [workspaceId, body.videoAssetId])).rows[0];
      if (!video || video.project_id !== body.projectId || video.media_type !== "video") throw new HttpError(422, "Choose a video asset from this project");
      if (video.sha256 !== body.expectedVideoSha256) throw new HttpError(422, "Video asset hash does not match the expected SHA-256; reload the asset");
      // Verify the bytes on disk at admission, not only the recorded hash.
      if (await fileSha256(await store.file(workspaceId, video.storage_key)).catch(() => "") !== body.expectedVideoSha256) {
        throw new HttpError(422, "Video asset bytes changed or are unavailable; upload it again");
      }
      let audio: { storage_key: string } | undefined;
      if (body.audioAssetId) {
        const row = (await client.query("SELECT id,project_id,media_type,sha256,storage_key FROM assets WHERE workspace_id=$1 AND id=$2", [workspaceId, body.audioAssetId])).rows[0];
        if (!row || row.project_id !== body.projectId || row.media_type !== "audio") throw new HttpError(422, "Choose an audio asset from this project");
        if (row.sha256 !== body.expectedAudioSha256) throw new HttpError(422, "Audio asset hash does not match the expected SHA-256; reload the asset");
        if (await fileSha256(await store.file(workspaceId, row.storage_key)).catch(() => "") !== body.expectedAudioSha256) {
          throw new HttpError(422, "Audio asset bytes changed or are unavailable; upload it again");
        }
        audio = row;
      }
      const id = newId(), outputAssetId = newId();
      const created = (await client.query(
        `INSERT INTO audio_operations(id,workspace_id,project_id,created_by,operation,state,request,request_hash,idempotency_key,video_asset_id,audio_asset_id,output_asset_id)
         VALUES($1,$2,$3,$4,$5,'admitted',$6,$7,$8,$9,$10,$11) RETURNING ${AUDIO_OPERATION_COLUMNS}`,
        [id, workspaceId, body.projectId, user.id, body.operation, JSON.stringify(body), requestHash, body.idempotencyKey, body.videoAssetId, body.audioAssetId ?? null, outputAssetId],
      )).rows[0];
      await client.query("INSERT INTO audio_operation_inputs(workspace_id,operation_id,asset_id,role,expected_sha256) VALUES($1,$2,$3,'video',$4)", [workspaceId, id, body.videoAssetId, body.expectedVideoSha256]);
      if (audio && body.audioAssetId && body.expectedAudioSha256) {
        await client.query("INSERT INTO audio_operation_inputs(workspace_id,operation_id,asset_id,role,expected_sha256) VALUES($1,$2,$3,'audio',$4)", [workspaceId, id, body.audioAssetId, body.expectedAudioSha256]);
      }
      await client.query("INSERT INTO audio_operation_events(workspace_id,operation_id,state) VALUES($1,$2,'admitted')", [workspaceId, id]);
      return created;
    });
  });
  app.get(`${base}/audio-operations/:id`, async request => {
    const { workspaceId, id } = item.parse(request.params);
    await member(pool, request, workspaceId);
    const row = (await pool.query(`SELECT ${AUDIO_OPERATION_COLUMNS} FROM audio_operations WHERE workspace_id=$1 AND id=$2`, [workspaceId, id])).rows[0];
    if (!row) throw new HttpError(404, "Audio operation not found");
    return row;
  });
  app.get(`${base}/audio-operations/:id/events`, async request => {
    const { workspaceId, id } = item.parse(request.params);
    await member(pool, request, workspaceId);
    const { after } = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    return (await pool.query("SELECT seq,state,detail,created_at FROM audio_operation_events WHERE workspace_id=$1 AND operation_id=$2 AND seq>$3 ORDER BY seq LIMIT 200", [workspaceId, id, after])).rows;
  });
  app.post(`${base}/audio-operations/:id/cancel`, async request => {
    const { workspaceId, id } = item.parse(request.params), user = await member(pool, request, workspaceId, "creator");
    const result = await transaction(pool, async client => {
      const op = (await client.query("SELECT * FROM audio_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, id])).rows[0];
      if (!op) throw new HttpError(404, "Audio operation not found");
      if (user.role !== "admin" && op.created_by !== user.id) throw new HttpError(403, "Only the operation owner or an administrator may cancel");
      if (["succeeded", "failed", "canceled"].includes(op.state)) return { state: op.state };
      const state = op.state === "admitted" ? "canceled" : "cancel_requested";
      await client.query("UPDATE audio_operations SET state=$1,updated_at=now() WHERE workspace_id=$2 AND id=$3", [state, workspaceId, id]);
      await client.query("INSERT INTO audio_operation_events(workspace_id,operation_id,state) VALUES($1,$2,$3)", [workspaceId, id, state]);
      return { state };
    });
    service.interrupt(id);
    return result;
  });
  return service;
}
