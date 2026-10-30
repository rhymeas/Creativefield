import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { HttpError, member } from "./auth";
import { newId } from "./crypto";
import { transaction } from "./db";
import {
  scriptRevisionErrors,
  voiceElementErrors,
  type ScriptRevisionV1,
  type VoiceElementRevisionV1,
} from "../src/team/audio/voice-contracts";

// AUD-01b: persistence for script and voice-element provenance records.
// Records are append-only. Nothing here synthesizes, renders or qualifies
// a voice route; voice takes and performance plans stay contract-only
// until a TTS route is separately qualified.

const base = "/api/v1/workspaces/:workspaceId/projects/:projectId";
const projectParams = z.object({ workspaceId: z.uuid(), projectId: z.uuid() }).strict();
const recordParams = projectParams.extend({ recordId: z.uuid() }).strict();

const scriptBody = z.object({
  language: z.string().trim().min(1).max(35),
  lines: z.array(z.object({
    speakerCharacterId: z.uuid(),
    text: z.string().trim().min(1).max(10000),
    deliveryNote: z.string().trim().max(500).optional(),
  }).strict()).min(1).max(200),
}).strict();

const voiceElementBody = z.object({
  engine: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(120),
  sourceType: z.enum(["recorded", "uploaded", "generated"]),
  sourceHashes: z.array(z.string().trim().min(1).max(128)).min(1).max(32),
  consentAttested: z.literal(true),
}).strict();

async function requireProject(pool: Pool, workspaceId: string, projectId: string) {
  if (!(await pool.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2", [workspaceId, projectId])).rowCount)
    throw new HttpError(404, "Project not found");
}

export async function voiceRecordRoutes(app: FastifyInstance, pool: Pool) {
  app.post(`${base}/script-revisions`, async request => {
    const { workspaceId, projectId } = projectParams.parse(request.params);
    const user = await member(pool, request, workspaceId, "creator");
    const body = scriptBody.parse(request.body);
    return transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`script/${workspaceId}/${projectId}`]);
      if (!(await client.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2", [workspaceId, projectId])).rowCount)
        throw new HttpError(404, "Project not found");
      const speakerIds = [...new Set(body.lines.map(line => line.speakerCharacterId))];
      const known = (await client.query(
        "SELECT id FROM character_records WHERE workspace_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",
        [workspaceId, projectId, speakerIds],
      )).rows as { id: string }[];
      if (known.length !== speakerIds.length) {
        const missing = speakerIds.filter(id => !known.some(row => row.id === id));
        throw new HttpError(422, `Script speaker is not a character in this project: ${missing[0]}`);
      }
      const revision = Number(((await client.query(
        "SELECT COALESCE(MAX(revision),0)+1 AS next FROM script_revisions WHERE workspace_id=$1 AND project_id=$2",
        [workspaceId, projectId],
      )).rows[0] as { next: number | string }).next);
      const record: ScriptRevisionV1 = {
        kind: "script_revision_v1", id: newId(), projectId, revision,
        language: body.language, lines: body.lines,
        createdBy: user.id, createdAt: new Date().toISOString(),
      };
      const errors = scriptRevisionErrors(record);
      if (errors.length) throw new HttpError(422, errors[0]);
      await client.query(
        "INSERT INTO script_revisions(id,workspace_id,project_id,revision,language,record,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [record.id, workspaceId, projectId, revision, record.language, JSON.stringify(record), user.id, record.createdAt],
      );
      return record;
    });
  });

  app.get(`${base}/script-revisions`, async request => {
    const { workspaceId, projectId } = projectParams.parse(request.params);
    await member(pool, request, workspaceId);
    await requireProject(pool, workspaceId, projectId);
    return (await pool.query(
      "SELECT record FROM script_revisions WHERE workspace_id=$1 AND project_id=$2 ORDER BY revision DESC",
      [workspaceId, projectId],
    )).rows.map(row => (row as { record: ScriptRevisionV1 }).record);
  });

  app.get(`${base}/script-revisions/:recordId`, async request => {
    const { workspaceId, projectId, recordId } = recordParams.parse(request.params);
    await member(pool, request, workspaceId);
    const row = (await pool.query(
      "SELECT record FROM script_revisions WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
      [workspaceId, projectId, recordId],
    )).rows[0] as { record: ScriptRevisionV1 } | undefined;
    if (!row) throw new HttpError(404, "Script revision not found");
    return row.record;
  });

  app.post(`${base}/voice-element-revisions`, async request => {
    const { workspaceId, projectId } = projectParams.parse(request.params);
    const user = await member(pool, request, workspaceId, "creator");
    const body = voiceElementBody.parse(request.body);
    return transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`voice-element/${workspaceId}/${projectId}`]);
      if (!(await client.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2", [workspaceId, projectId])).rowCount)
        throw new HttpError(404, "Project not found");
      const revision = Number(((await client.query(
        "SELECT COALESCE(MAX(revision),0)+1 AS next FROM voice_element_revisions WHERE workspace_id=$1 AND project_id=$2",
        [workspaceId, projectId],
      )).rows[0] as { next: number | string }).next);
      const record: VoiceElementRevisionV1 = {
        kind: "voice_element_revision_v1", id: newId(), projectId, revision,
        engine: body.engine, model: body.model, sourceType: body.sourceType,
        sourceHashes: body.sourceHashes, consentAttested: true,
        createdBy: user.id, createdAt: new Date().toISOString(),
      };
      const errors = voiceElementErrors(record);
      if (errors.length) throw new HttpError(422, errors[0]);
      await client.query(
        "INSERT INTO voice_element_revisions(id,workspace_id,project_id,revision,engine,model,record,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [record.id, workspaceId, projectId, revision, record.engine, record.model, JSON.stringify(record), user.id, record.createdAt],
      );
      return record;
    });
  });

  app.get(`${base}/voice-element-revisions`, async request => {
    const { workspaceId, projectId } = projectParams.parse(request.params);
    await member(pool, request, workspaceId);
    await requireProject(pool, workspaceId, projectId);
    return (await pool.query(
      "SELECT record FROM voice_element_revisions WHERE workspace_id=$1 AND project_id=$2 ORDER BY revision DESC",
      [workspaceId, projectId],
    )).rows.map(row => (row as { record: VoiceElementRevisionV1 }).record);
  });

  app.get(`${base}/voice-element-revisions/:recordId`, async request => {
    const { workspaceId, projectId, recordId } = recordParams.parse(request.params);
    await member(pool, request, workspaceId);
    const row = (await pool.query(
      "SELECT record FROM voice_element_revisions WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
      [workspaceId, projectId, recordId],
    )).rows[0] as { record: VoiceElementRevisionV1 } | undefined;
    if (!row) throw new HttpError(404, "Voice element revision not found");
    return row.record;
  });
}
