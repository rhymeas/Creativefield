import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import path from "node:path";
import { buildServer } from "../server/app";
import { bootstrap } from "../server/auth";
import { migrate } from "../server/db";
import { hashToken, newId } from "../server/crypto";
import type { ServerConfig } from "../server/config";
import { AudioProcessingService } from "../server/audio-processing-execution";

const execute = promisify(execFile), connectionString = process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("audio processing durable execution", () => {
  const schema = `cf_audio_${randomUUID().replaceAll("-", "")}`, origin = "http://localhost:5173";
  let root: Pool, pool: Pool, server: Awaited<ReturnType<typeof buildServer>>, config: ServerConfig;
  let workspaceId: string, projectId: string, otherProjectId: string, cookie: string, viewer: string, creator2: string, foreignWs: string, foreignCookie: string, scratch: string;
  let videoAsset: any, audioAsset: any, foreignProjectAsset: any, adminId: string;
  const api = (method: "GET" | "POST", tail: string, payload?: unknown, session = cookie, workspace = workspaceId) =>
    server.app.inject({ method, url: `/api/v1/workspaces/${workspace}/${tail}`, headers: { origin, cookie: session }, payload: payload as any });
  const get = async (id: string, session = cookie, workspace = workspaceId) => (await api("GET", `audio-operations/${id}`, undefined, session, workspace)).json();
  async function session(role: string, workspace = workspaceId) {
    const id = randomUUID(), token = randomBytes(32).toString("hex");
    await pool.query("INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users LIMIT 1", [id, `${id}@fixture.test`]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), id]);
    return `cf_session=${token}`;
  }
  async function addAsset(file: string, mediaType: "video" | "audio", contentType: string, project = projectId) {
    const saved = await server.store.put(workspaceId, createReadStream(file));
    const id = newId();
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [id, workspaceId, project, path.basename(file), mediaType, contentType, saved.key, saved.sha256, saved.bytes, adminId]);
    return { id, sha256: saved.sha256 };
  }
  const replaceBody = (extra: any = {}) => ({
    projectId, idempotencyKey: randomUUID(), operation: "replace",
    videoAssetId: videoAsset.id, expectedVideoSha256: videoAsset.sha256, videoStreamIndex: 0,
    audioAssetId: audioAsset.id, expectedAudioSha256: audioAsset.sha256, audioStreamIndex: 0,
    shortAudio: "pad_silence", longAudio: "trim", ...extra,
  });
  async function restart() {
    await Promise.all([server.execution.close(), server.storyboards.close(), server.audioProcessing.close(), server.workerMonitor.close()]);
    await server.app.close();
    server = await buildServer(config, pool);
    await server.app.ready();
  }
  beforeAll(async () => {
    root = new Pool({ connectionString }); await root.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` }); await migrate(pool); await migrate(pool);
    scratch = await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/audio-db-test-");
    config = { databaseUrl: connectionString!, storageRoot: scratch, masterKey: randomBytes(32), publicOrigin: origin, host: "127.0.0.1", port: 8787, sessionTtlHours: 1, inviteTtlHours: 1, maxUploadBytes: 16 * 1024 * 1024, cookieSecure: false };
    const boot = await bootstrap(pool, "audio@fixture.test", "Fixture-password-long-27!", "Audio");
    workspaceId = boot.workspaceId; adminId = boot.userId;
    server = await buildServer(config, pool); await server.app.ready();
    cookie = await session("admin"); viewer = await session("viewer"); creator2 = await session("creator");
    foreignWs = randomUUID(); await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Foreign')", [foreignWs]); foreignCookie = await session("admin", foreignWs);
    projectId = (await api("POST", "projects", { name: "Audio test" })).json().id;
    otherProjectId = (await api("POST", "projects", { name: "Other" })).json().id;
    const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
    await execute(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=red:s=160x96:r=16:d=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", `${scratch}/video.mp4`], { windowsHide: true });
    await execute(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=2", "-c:a", "pcm_s16le", "-ac", "2", `${scratch}/tone.wav`], { windowsHide: true });
    videoAsset = await addAsset(`${scratch}/video.mp4`, "video", "video/mp4");
    audioAsset = await addAsset(`${scratch}/tone.wav`, "audio", "audio/wav");
    foreignProjectAsset = await addAsset(`${scratch}/tone.wav`, "audio", "audio/wav", otherProjectId);
  }, 60000);
  afterAll(async () => {
    if (server) { await Promise.all([server.execution.close(), server.storyboards.close(), server.audioProcessing.close()]); await server.app.close(); }
    await pool?.end(); if (root) { await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); }
  });

  it("publishes one immutable asset with a server receipt and survives restart", async () => {
    const created = await api("POST", "audio-operations", replaceBody());
    expect(created.statusCode, created.body).toBe(200);
    const op = created.json();
    await server.audioProcessing.tick();
    const done = await get(op.id);
    expect(done.state, done.error).toBe("succeeded");
    expect(done.receipt?.outputAssetId).toBe(done.output_asset_id);
    expect(done.receipt?.contract).toBe("audio_policy_v1");
    const asset = (await pool.query("SELECT * FROM assets WHERE id=$1", [done.output_asset_id])).rows[0];
    expect(asset.metadata.audioOperation.outputSha256).toBe(asset.sha256);
    const events = (await api("GET", `audio-operations/${op.id}/events`)).json();
    expect(events.map((e: any) => e.state)).toEqual(["admitted", "processing", "publishing", "succeeded"]);
    await restart(); await server.audioProcessing.tick();
    expect((await pool.query("SELECT count(*)::int n FROM assets WHERE id=$1", [done.output_asset_id])).rows[0].n).toBe(1);
    expect((await get(op.id)).state).toBe("succeeded");
  }, 60000);
  it("replays idempotently, conflicts on a different request, and runs once under concurrent services", async () => {
    const body = replaceBody();
    const [a, b] = await Promise.all([api("POST", "audio-operations", body), api("POST", "audio-operations", body)]);
    expect(a.json().id).toBe(b.json().id);
    expect((await api("POST", "audio-operations", { ...body, audioGainDb: -3 })).statusCode).toBe(409);
    const second = new AudioProcessingService(pool, server.store);
    await Promise.all([server.audioProcessing.tick(), second.tick()]);
    const done = await get(a.json().id);
    expect(done.state, done.error).toBe("succeeded");
    expect((await pool.query("SELECT count(*)::int n FROM assets WHERE id=$1", [done.output_asset_id])).rows[0].n).toBe(1);
  }, 60000);
  it("denies viewers, foreign workspaces, cross-project inputs and stale hashes", async () => {
    expect((await api("POST", "audio-operations", replaceBody(), viewer)).statusCode).toBe(403);
    expect((await api("POST", "audio-operations", replaceBody(), foreignCookie, foreignWs)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await api("POST", "audio-operations", replaceBody({ audioAssetId: foreignProjectAsset.id, expectedAudioSha256: foreignProjectAsset.sha256 }))).statusCode).toBe(422);
    expect((await api("POST", "audio-operations", replaceBody({ expectedVideoSha256: "0".repeat(64) }))).statusCode).toBe(422);
    expect((await api("POST", "audio-operations", { ...replaceBody(), receipt: {} })).statusCode).toBe(400);
  });
  it("cancels before execution with no published output and enforces owner-only cancel", async () => {
    const created = (await api("POST", "audio-operations", replaceBody())).json();
    expect((await api("POST", `audio-operations/${created.id}/cancel`, undefined, creator2)).statusCode).toBe(403);
    expect((await api("POST", `audio-operations/${created.id}/cancel`)).json().state).toBe("canceled");
    await server.audioProcessing.tick();
    const done = await get(created.id);
    expect(done.state).toBe("canceled");
    expect((await pool.query("SELECT count(*)::int n FROM assets WHERE id=$1", [done.output_asset_id])).rows[0].n).toBe(0);
    expect(await readdir(`${scratch}/.audio-processing`).catch(() => [])).toEqual([]);
  }, 30000);
  it("never publishes after cancellation wins the publication race", async () => {
    const created = (await api("POST", "audio-operations", replaceBody())).json();
    const ticking = server.audioProcessing.tick();
    await api("POST", `audio-operations/${created.id}/cancel`);
    await ticking; await server.audioProcessing.tick();
    const done = await get(created.id);
    const assets = (await pool.query("SELECT count(*)::int n FROM assets WHERE id=$1", [done.output_asset_id])).rows[0].n;
    // Exactly one of the two race outcomes, never a partial publish.
    expect(done.state === "canceled" ? assets : done.state).toBe(done.state === "canceled" ? 0 : "succeeded");
    if (done.state === "succeeded") expect(assets).toBe(1);
  }, 60000);
  it("keeps shutdown interruption recoverable and resumes it after restart", async () => {
    const created = (await api("POST", "audio-operations", replaceBody())).json();
    const ticking = server.audioProcessing.tick();
    let active = "";
    for (let tries = 0; tries < 200; tries++) {
      active = (await get(created.id)).state;
      if (active === "processing") break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(active).toBe("processing");
    await server.audioProcessing.close(); await ticking;
    expect((await get(created.id)).state).toBe("processing");
    await restart(); await server.audioProcessing.tick();
    expect((await get(created.id)).state).toBe("succeeded");
  }, 60000);
  it("revalidates and reuses a persisted candidate after restart instead of duplicating", async () => {
    const created = (await api("POST", "audio-operations", replaceBody())).json();
    await server.audioProcessing.tick();
    expect((await get(created.id)).state).toBe("succeeded");
    // Simulate a crash after candidate persistence but before publication on a fresh operation:
    const second = (await api("POST", "audio-operations", replaceBody())).json();
    const firstCandidate = (await pool.query("SELECT candidate FROM audio_operations WHERE id=$1", [created.id])).rows[0].candidate;
    // Persist a distinct unpublished copy. Reusing the first operation's
    // published storage key would violate the asset storage-key invariant and
    // would not model a real crash between staging and publication.
    const staged = await server.store.put(workspaceId, createReadStream(await server.store.file(workspaceId, firstCandidate.key)));
    const stagedCandidate = { ...firstCandidate, key: staged.key, sha256: staged.sha256, bytes: staged.bytes };
    await pool.query("UPDATE audio_operations SET state='publishing',candidate=$1 WHERE id=$2", [JSON.stringify(stagedCandidate), second.id]);
    await restart(); await server.audioProcessing.tick();
    const done = await get(second.id);
    expect(done.state, done.error).toBe("succeeded");
    expect((await pool.query("SELECT count(*)::int n FROM assets WHERE id=$1", [done.output_asset_id])).rows[0].n).toBe(1);
  }, 60000);
});
