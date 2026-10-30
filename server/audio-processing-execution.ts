import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db";
import type { DiskStore } from "./storage";
import { fileSha256 } from "./masked-media";
import {
  AUDIO_MAX_ATTEMPTS,
  audioMeasurementSchema,
  audioOperationRequestSchema,
  audioOutputKind,
  audioReceiptSchema,
  type AudioReceipt,
} from "./audio-policy";
import {
  AudioProcessingAbortedError,
  AudioProcessingError,
  AudioToolUnavailableError,
  processAudioOperation,
  revalidateAudioCandidate,
  type ProcessedAudioCandidate,
} from "./audio-processing";

export const AUDIO_OPERATION_COLUMNS = "id,project_id,created_by,operation,state,request,video_asset_id,audio_asset_id,output_asset_id,attempt,receipt,error,created_at,updated_at";
const ACTIVE_STATES = ["admitted", "probing", "processing", "validating", "publishing", "cancel_requested"];
const TERMINAL_STATES = ["succeeded", "failed", "canceled"];

const candidateSchema = z.object({
  key: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  outputDurationSeconds: z.number().finite().positive(),
  videoDurationSeconds: z.number().finite().positive(),
  videoTimingDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  videoFrames: z.number().int().nonnegative().nullable(),
  measurement: audioMeasurementSchema.nullable(),
  tools: z.object({ ffmpeg: z.string().min(1), ffprobe: z.string().min(1) }).strict(),
}).strict();

async function setState(client: PoolClient, op: { workspace_id: string; id: string }, state: string, error: string | null = null): Promise<void> {
  await client.query("UPDATE audio_operations SET state=$1,error=$2,updated_at=now() WHERE workspace_id=$3 AND id=$4", [state, error, op.workspace_id, op.id]);
  await client.query("INSERT INTO audio_operation_events(workspace_id,operation_id,state,detail) VALUES($1,$2,$3,$4)", [op.workspace_id, op.id, state, JSON.stringify(error ? { error } : {})]);
}

/**
 * Durable, restart-safe audio execution. Reconciliation is serialized per
 * operation with a PostgreSQL advisory lock; publication inserts exactly one
 * immutable asset under the stable output id chosen at admission.
 */
export class AudioProcessingService {
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private aborts = new Map<string, AbortController>();
  constructor(readonly pool: Pool, readonly store: DiskStore) {}

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.reconcile().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const controller of this.aborts.values()) controller.abort();
    await this.inFlight;
  }
  interrupt(id: string): void { this.aborts.get(id)?.abort(); }

  private async reconcile(): Promise<void> {
    const operations = (await this.pool.query("SELECT id FROM audio_operations WHERE state=ANY($1::text[]) ORDER BY created_at", [ACTIVE_STATES])).rows;
    for (const { id } of operations) {
      if (this.stopped) break;
      const lock = await this.pool.connect();
      try {
        const acquired = (await lock.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired", [`audio-operation:${id}`])).rows[0].acquired;
        if (!acquired) continue;
        try { await this.advance(id); } catch { /* Durable state remains for the next reconciliation. */ }
        finally { await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`audio-operation:${id}`]); }
      } finally { lock.release(); }
    }
  }

  private async cleanupCandidate(op: any, key: string | undefined): Promise<void> {
    if (!key) return;
    // A COMMIT acknowledgement can be lost. Re-read the stable output id
    // before removing bytes that may already be published. An uncertain DB
    // read retains bytes for later reconciliation; absence must be proven.
    let published: { storage_key?: string } | undefined, operation: { state?: string } | undefined;
    try {
      published = (await this.pool.query("SELECT storage_key FROM assets WHERE workspace_id=$1 AND id=$2", [op.workspace_id, op.output_asset_id])).rows[0];
      operation = (await this.pool.query("SELECT state FROM audio_operations WHERE workspace_id=$1 AND id=$2", [op.workspace_id, op.id])).rows[0];
    } catch { return; }
    if (published?.storage_key === key) return;
    if (!operation || operation.state === "succeeded") return;
    await this.store.remove(op.workspace_id, key).catch(() => {});
  }

  private async finalizeCanceled(op: any): Promise<void> {
    let candidateKey: string | undefined;
    await transaction(this.pool, async client => {
      const current = (await client.query("SELECT state,candidate FROM audio_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [op.workspace_id, op.id])).rows[0];
      if (!current || TERMINAL_STATES.includes(current.state)) return;
      const candidate = candidateSchema.safeParse(current.candidate);
      if (candidate.success) candidateKey = candidate.data.key;
      await client.query("UPDATE audio_operations SET candidate=NULL WHERE workspace_id=$1 AND id=$2", [op.workspace_id, op.id]);
      await setState(client, op, "canceled");
    });
    if (candidateKey) await this.cleanupCandidate(op, candidateKey);
  }

  private async fail(op: any, message: string): Promise<void> {
    let candidateKey: string | undefined;
    await transaction(this.pool, async client => {
      const current = (await client.query("SELECT state,candidate FROM audio_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [op.workspace_id, op.id])).rows[0];
      if (!current || TERMINAL_STATES.includes(current.state)) return;
      const candidate = candidateSchema.safeParse(current.candidate);
      if (candidate.success) candidateKey = candidate.data.key;
      await client.query("UPDATE audio_operations SET candidate=NULL WHERE workspace_id=$1 AND id=$2", [op.workspace_id, op.id]);
      if (current.state === "cancel_requested") await setState(client, op, "canceled");
      else await setState(client, op, "failed", message);
    });
    if (candidateKey) await this.cleanupCandidate(op, candidateKey);
  }

  private async retryOrFail(op: any, message: string): Promise<void> {
    if (Number(op.attempt) >= AUDIO_MAX_ATTEMPTS) { await this.fail(op, message); return; }
    await transaction(this.pool, async client => {
      const current = (await client.query("SELECT state FROM audio_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [op.workspace_id, op.id])).rows[0];
      if (!current || TERMINAL_STATES.includes(current.state)) return;
      if (current.state === "cancel_requested") await setState(client, op, "canceled");
      else await setState(client, op, "admitted", `${message} Reconciliation will retry.`);
    });
  }

  private async advance(id: string): Promise<void> {
    const op = (await this.pool.query("SELECT * FROM audio_operations WHERE id=$1", [id])).rows[0];
    if (!op || TERMINAL_STATES.includes(op.state)) return;
    if (op.state === "cancel_requested") { await this.finalizeCanceled(op); return; }

    const parsedRequest = audioOperationRequestSchema.safeParse(op.request);
    if (!parsedRequest.success) { await this.fail(op, "Persisted audio request is invalid"); return; }
    const request = parsedRequest.data;

    // Re-verify pinned inputs immediately before execution: same project,
    // recorded hash, and bytes on disk must all still agree.
    const inputs = (await this.pool.query(
      "SELECT i.role,i.expected_sha256,a.id,a.project_id,a.sha256,a.storage_key,a.media_type FROM audio_operation_inputs i JOIN assets a ON a.workspace_id=i.workspace_id AND a.id=i.asset_id WHERE i.workspace_id=$1 AND i.operation_id=$2",
      [op.workspace_id, op.id],
    )).rows;
    const video = inputs.find((input: any) => input.role === "video");
    const audio = inputs.find((input: any) => input.role === "audio");
    let videoFile: string, audioFile: string | undefined;
    try {
      if (!video || video.project_id !== op.project_id || video.media_type !== "video" || video.sha256 !== video.expected_sha256) throw new Error("video");
      videoFile = await this.store.file(op.workspace_id, video.storage_key);
      if (await fileSha256(videoFile) !== video.expected_sha256) throw new Error("video");
      if (request.audioAssetId) {
        if (!audio || audio.project_id !== op.project_id || audio.media_type !== "audio" || audio.sha256 !== audio.expected_sha256) throw new Error("audio");
        audioFile = await this.store.file(op.workspace_id, audio.storage_key);
        if (await fileSha256(audioFile) !== audio.expected_sha256) throw new Error("audio");
      }
    } catch {
      await this.fail(op, "Pinned audio-operation inputs changed or are unavailable before execution");
      return;
    }

    const controller = new AbortController();
    this.aborts.set(id, controller);
    // A second server can receive cancellation; observe durable state too.
    const timer = setInterval(() => {
      void this.pool.query("SELECT state FROM audio_operations WHERE id=$1", [id])
        .then(result => { if (["cancel_requested", "canceled"].includes(result.rows[0]?.state)) controller.abort(); })
        .catch(() => {});
    }, 500);
    let processed: ProcessedAudioCandidate | undefined;
    try {
      const storedCandidate = candidateSchema.safeParse(op.candidate);
      if (storedCandidate.success) {
        try {
          const candidateFile = await this.store.file(op.workspace_id, storedCandidate.data.key);
          if (await fileSha256(candidateFile) !== storedCandidate.data.sha256) throw new AudioProcessingError("Stage candidate bytes changed");
          const summary = await revalidateAudioCandidate({ request, videoFile, audioFile, candidateFile, signal: controller.signal });
          processed = { key: storedCandidate.data.key, sha256: storedCandidate.data.sha256, bytes: storedCandidate.data.bytes, ...summary };
        } catch (error) {
          if (error instanceof AudioProcessingAbortedError || controller.signal.aborted) throw error;
          // Stale stage artifact: remove its bytes and rerun the stage.
          await this.cleanupCandidate(op, storedCandidate.data.key);
          await this.pool.query("UPDATE audio_operations SET candidate=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2", [op.workspace_id, op.id]);
        }
      }
      if (!processed) {
        await transaction(this.pool, async client => {
          const current = (await client.query("SELECT state FROM audio_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [op.workspace_id, op.id])).rows[0];
          if (!current || TERMINAL_STATES.includes(current.state) || current.state === "cancel_requested") return;
          await client.query("UPDATE audio_operations SET attempt=attempt+1 WHERE workspace_id=$1 AND id=$2", [op.workspace_id, op.id]);
          await setState(client, op, "processing");
        });
        const state = (await this.pool.query("SELECT state FROM audio_operations WHERE workspace_id=$1 AND id=$2", [op.workspace_id, op.id])).rows[0]?.state;
        if (state !== "processing") { if (state === "cancel_requested") await this.finalizeCanceled(op); return; }
        op.attempt = Number(op.attempt) + 1;
        processed = await processAudioOperation({ store: this.store, workspaceId: op.workspace_id, request, videoFile, audioFile, signal: controller.signal });
        if (this.stopped) { await this.cleanupCandidate(op, processed.key); return; }
        // Persist the validated stage candidate before the publication
        // transaction so a restart can revalidate and reuse it.
        const persisted = await transaction(this.pool, async client => {
          const current = (await client.query("SELECT state FROM audio_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [op.workspace_id, op.id])).rows[0];
          if (!current || TERMINAL_STATES.includes(current.state)) return "done" as const;
          if (current.state === "cancel_requested") { await setState(client, op, "canceled"); return "canceled" as const; }
          await client.query("UPDATE audio_operations SET candidate=$1 WHERE workspace_id=$2 AND id=$3", [JSON.stringify(candidateSchema.parse(processed)), op.workspace_id, op.id]);
          await setState(client, op, "publishing");
          return "publishing" as const;
        });
        if (persisted !== "publishing") {
          if (persisted === "canceled") await this.cleanupCandidate(op, processed.key);
          return;
        }
        if (this.stopped) return;
      }

      const kind = audioOutputKind(request.operation);
      const receipt: AudioReceipt = audioReceiptSchema.parse({
        version: 1,
        contract: "audio_policy_v1",
        operationId: op.id,
        operation: request.operation,
        projectId: op.project_id,
        videoAssetId: op.video_asset_id,
        videoSha256: request.expectedVideoSha256,
        audioAssetId: op.audio_asset_id ?? null,
        audioSha256: request.expectedAudioSha256 ?? null,
        outputAssetId: op.output_asset_id,
        outputSha256: processed.sha256,
        outputMediaType: kind.mediaType,
        outputContentType: kind.contentType,
        videoDurationSeconds: processed.videoDurationSeconds,
        outputDurationSeconds: processed.outputDurationSeconds,
        videoTimingDigest: processed.videoTimingDigest,
        videoFrames: processed.videoFrames,
        measurement: processed.measurement,
        loudnessMode: "measure_only",
        tools: processed.tools,
        validatedAt: new Date().toISOString(),
      });
      const result = await transaction(this.pool, async client => {
        const current = (await client.query("SELECT state FROM audio_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [op.workspace_id, op.id])).rows[0];
        if (!current) throw new AudioProcessingError("Audio operation is unavailable");
        if (current.state === "succeeded") return "published" as const;
        if (current.state === "cancel_requested") { await setState(client, op, "canceled"); return "canceled" as const; }
        if (TERMINAL_STATES.includes(current.state)) return "canceled" as const;
        await client.query(
          "INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [op.output_asset_id, op.workspace_id, op.project_id, `audio-${request.operation}-${op.id}.${kind.extension}`, kind.mediaType, kind.contentType, processed!.key, processed!.sha256, processed!.bytes, op.created_by, op.video_asset_id, JSON.stringify({ audioOperation: receipt })],
        );
        await client.query("UPDATE audio_operations SET receipt=$1 WHERE workspace_id=$2 AND id=$3", [JSON.stringify(receipt), op.workspace_id, op.id]);
        await setState(client, op, "succeeded");
        return "published" as const;
      });
      if (result === "canceled") await this.cleanupCandidate(op, processed.key);
      else {
        // Another instance may have published a different candidate first.
        const existing = (await this.pool.query("SELECT storage_key,sha256 FROM assets WHERE workspace_id=$1 AND id=$2", [op.workspace_id, op.output_asset_id])).rows[0];
        if (!existing || existing.storage_key !== processed.key || existing.sha256 !== processed.sha256) {
          await this.store.remove(op.workspace_id, processed.key).catch(() => {});
        }
      }
    } catch (error) {
      // Uncertain COMMIT: re-read stable operation/output identities before
      // removing bytes or deciding to retry.
      const published = await this.pool.query(
        "SELECT o.state,a.storage_key,a.sha256 FROM audio_operations o LEFT JOIN assets a ON a.workspace_id=o.workspace_id AND a.id=o.output_asset_id WHERE o.workspace_id=$1 AND o.id=$2",
        [op.workspace_id, op.id],
      ).then(result => result.rows[0]).catch(() => undefined);
      if (published?.state === "succeeded" && published.storage_key) {
        if (processed && published.storage_key !== processed.key) await this.store.remove(op.workspace_id, processed.key).catch(() => {});
        return;
      }
      // Shutdown interruption is recoverable, not a user cancellation. The
      // operation remains active for the next process to reconcile.
      if (this.stopped) return;
      if (error instanceof AudioProcessingAbortedError || controller.signal.aborted || published?.state === "cancel_requested") {
        if (processed) await this.cleanupCandidate(op, processed.key);
        await this.finalizeCanceled(op);
        return;
      }
      if (error instanceof AudioProcessingError) {
        if (processed) await this.cleanupCandidate(op, processed.key);
        await this.fail(op, error.message);
        return;
      }
      // Transient: keep a persisted candidate for revalidation on the next
      // tick; remove only bytes no durable row references.
      if (processed) {
        const referenced = candidateSchema.safeParse(published ? (await this.pool.query("SELECT candidate FROM audio_operations WHERE workspace_id=$1 AND id=$2", [op.workspace_id, op.id]).catch(() => ({ rows: [] }))).rows[0]?.candidate : undefined);
        if (!referenced.success || referenced.data.key !== processed.key) await this.cleanupCandidate(op, processed.key);
      }
      await this.retryOrFail(op, error instanceof AudioToolUnavailableError
        ? "FFmpeg/FFprobe is temporarily unavailable for audio processing."
        : "Audio processing failed before publication; check media tools and storage.");
    } finally {
      clearInterval(timer);
      this.aborts.delete(id);
    }
  }
}
