import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {encodeMonoWav} from "../src/team/audio/microphone";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../server/app";
import { bootstrap } from "../server/auth";
import { hashPassword } from "../server/crypto";
import { migrate } from "../server/db";
import type { ServerConfig } from "../server/config";
import {windowsSystemVoice,type SystemVoiceEngine} from "../server/system-voice";
import {writeFile} from "node:fs/promises";

const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)("voice provenance records against real PostgreSQL", () => {
  const schema = `cf_voice_${randomUUID().replaceAll("-", "")}`;
  const origin = "http://localhost:5173";
  const password = "Fixture-only-password-527!";
  let root: Pool;
  let pool: Pool;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId: string;
  let ownerId: string;
  let adminCookie: string;
  let viewerCookie: string;
  let foreignCookie: string;
  let projectId: string;
  let voiceCalls=0;
  const realVoice=process.env.COMFYFIELD_REAL_SYSTEM_VOICE==="1";
  const voiceEngine:SystemVoiceEngine={voices:()=>realVoice?windowsSystemVoice.voices():Promise.resolve([{name:"Fixture local voice",culture:"en-US"}]),synthesize:async(input,tempRoot)=>{voiceCalls++;return realVoice?windowsSystemVoice.synthesize(input,tempRoot):{bytes:Buffer.from(await encodeMonoWav([new Float32Array(24000).fill(.1)],24000).blob.arrayBuffer()),marks:[{ticks:1000000,start:0,length:3,text:"The"},{ticks:3000000,start:4,length:7,text:"lantern"}],visemes:[{ticks:0,durationTicks:10000000,id:0}]};}};
  let characterId: string;
  let storageRoot: string;

  const url = (path: string, project = projectId, workspace = workspaceId) =>
    `/api/v1/workspaces/${workspace}/projects/${project}/${path}`;

  function request(method: "GET" | "POST", path: string, payload?: unknown, cookie = adminCookie) {
    return server.app.inject({ method, url: path, headers: { origin, cookie }, payload: payload as Record<string, unknown> });
  }

  async function login(email: string) {
    const response = await server.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin }, payload: { email, password } });
    expect(response.statusCode).toBe(200);
    return String(response.headers["set-cookie"]).split(";")[0];
  }

  beforeAll(async () => {
    root = new Pool({ connectionString });
    await root.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    await migrate(pool);
    const scratchRoot = process.env.COMFYFIELD_TEST_TEMP_ROOT ?? tmpdir();
    await mkdir(scratchRoot, { recursive: true });
    storageRoot = await mkdtemp(join(scratchRoot, "comfyfield-voice-"));
    const config: ServerConfig = {
      databaseUrl: connectionString!, storageRoot, masterKey: randomBytes(32),
      publicOrigin: origin, host: "127.0.0.1", port: 8787, sessionTtlHours: 1,
      inviteTtlHours: 1, maxUploadBytes: 1024 * 1024, cookieSecure: false,
    };
    const owner = await bootstrap(pool, "admin@example.test", password, "Voice Studio");
    ownerId = owner.userId;
    workspaceId = owner.workspaceId;
    const viewerId = randomUUID();
    const foreignUserId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3),($4,$5,$6)",
      [viewerId, "viewer@example.test", await hashPassword(password), foreignUserId, "foreign@example.test", await hashPassword(password)]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')", [workspaceId, viewerId]);
    await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Foreign Studio')", [foreignWorkspaceId]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [foreignWorkspaceId, foreignUserId]);

    server = await buildServer(config, pool,{systemVoice:voiceEngine});
    await server.app.ready();
    adminCookie = await login("admin@example.test");
    viewerCookie = await login("viewer@example.test");
    foreignCookie = await login("foreign@example.test");

    projectId = (await request("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Voices" })).json().id;
    const assetId = randomUUID();
    await pool.query(
      `INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata)
       VALUES($1,$2,$3,'ref.png','image','image/png',$4,$5,11,$6,'{}')`,
      [assetId, workspaceId, projectId, `${workspaceId}/${assetId}`, "a".repeat(64), ownerId],
    );
    const character = await request("POST", url("characters"), { idempotencyKey: "voice-char-1", name: "Nara", referenceAssetIds: [assetId] });
    expect(character.statusCode).toBe(200);
    characterId = character.json().id;
  }, 30000);

  afterAll(async () => {
    await server?.app.close();
    await pool?.end();
    if (root) { await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); }
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  it("creates an explicitly requested local system voice once with reusable WAV provenance",async()=>{
    const available=await request("GET",url("system-voice"));expect(available.statusCode,available.body).toBe(200);const voice=available.json().voices[0]?.name;expect(voice).toBeTruthy();
    const body={requestId:randomUUID(),text:"The lantern glows beside the river.",voice,delivery:"calm"},before=voiceCalls;
    expect((await request("POST",url("system-voice"),body,viewerCookie)).statusCode).toBe(403);expect((await request("POST",url("system-voice"),body,foreignCookie)).statusCode).toBe(403);
    expect((await request("POST",url("system-voice"),{...body,voice:"Not installed"})).statusCode).toBe(422);
    expect((await request("POST",url("system-voice"),{...body,text:"x".repeat(401)})).statusCode).toBe(400);
    expect((await request("POST",url("system-voice"),{...body,delivery:"arbitrary command"})).statusCode).toBe(400);
    const created=await request("POST",url("system-voice"),body);expect(created.statusCode,created.body).toBe(200);const asset=created.json();
    expect(asset).toMatchObject({id:body.requestId,project_id:projectId,media_type:"audio",content_type:"audio/wav",metadata:{sampleRate:realVoice?16000:24000,systemVoice:{engine:"windows-system-speech",voice,rate:-2,text:body.text}}});
    expect(asset.metadata.systemVoice.playback.audioSha256).toBe(asset.sha256);expect(asset.metadata.systemVoice.playback.words.length).toBeGreaterThan(0);expect(asset.metadata.systemVoice.playback.peaks).toHaveLength(96);
    expect(asset.metadata.systemVoice.playback.visemeSource).toBe("windows-viseme-reached-v1");expect(asset.metadata.systemVoice.playback.visemes.length).toBeGreaterThan(0);
    expect((await request("POST",url("system-voice"),body)).json()).toEqual(asset);expect(voiceCalls).toBe(before+1);
    expect((await request("POST",url("system-voice"),{...body,text:"Changed text"})).statusCode).toBe(409);
    const download=await request("GET",`/api/v1/workspaces/${workspaceId}/assets/${asset.id}/content`);expect(download.statusCode).toBe(200);expect(download.rawPayload.toString("ascii",0,4)).toBe("RIFF");
    if(realVoice){const target=(process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/ComfyField/system-voice-visemes-real";await writeFile(target+".wav",download.rawPayload);await writeFile(target+".json",JSON.stringify({asset,bytes:download.rawPayload.length,voiceCalls},null,2));}
  });
  it("persists append-only script revisions with server-assigned numbering", async () => {
    const body = { language: "en", lines: [{ speakerCharacterId: characterId, text: "Hello from the studio." }] };
    const first = await request("POST", url("script-revisions"), body);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ kind: "script_revision_v1", revision: 1, projectId, language: "en" });
    expect(first.json().lines[0].text).toBe("Hello from the studio.");

    const second = await request("POST", url("script-revisions"), { language: "de", lines: [{ speakerCharacterId: characterId, text: "Hallo.", deliveryNote: "warm" }] });
    expect(second.json().revision).toBe(2);

    const list = await request("GET", url("script-revisions"), undefined, viewerCookie);
    expect(list.statusCode).toBe(200);
    expect(list.json().map((row: { revision: number }) => row.revision)).toEqual([2, 1]);

    const one = await request("GET", url(`script-revisions/${first.json().id}`));
    expect(one.json().id).toBe(first.json().id);

    await expect(pool.query("UPDATE script_revisions SET language='fr' WHERE id=$1", [first.json().id])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM script_revisions WHERE id=$1", [first.json().id])).rejects.toThrow(/append-only/);
  });

  it("rejects unknown speakers, viewer writes and foreign workspaces", async () => {
    const unknown = await request("POST", url("script-revisions"), { language: "en", lines: [{ speakerCharacterId: randomUUID(), text: "Hi." }] });
    expect(unknown.statusCode).toBe(422);
    const viewerWrite = await request("POST", url("script-revisions"), { language: "en", lines: [{ speakerCharacterId: characterId, text: "Hi." }] }, viewerCookie);
    expect(viewerWrite.statusCode).toBe(403);
    const foreign = await request("GET", url("script-revisions"), undefined, foreignCookie);
    expect([403, 404]).toContain(foreign.statusCode);
    const missingProject = await request("GET", url("script-revisions", randomUUID()));
    expect(missingProject.statusCode).toBe(404);
  });

  it("persists consent-attested voice elements and refuses unattested ones", async () => {
    const created = await request("POST", url("voice-element-revisions"), {
      engine: "local-tts", model: "unqualified-fixture", sourceType: "recorded",
      sourceHashes: ["b".repeat(64)], consentAttested: true,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ kind: "voice_element_revision_v1", revision: 1, consentAttested: true });

    const unattested = await request("POST", url("voice-element-revisions"), {
      engine: "local-tts", model: "unqualified-fixture", sourceType: "recorded",
      sourceHashes: ["b".repeat(64)], consentAttested: false,
    });
    expect(unattested.statusCode).toBe(400);

    const list = await request("GET", url("voice-element-revisions"), undefined, viewerCookie);
    expect(list.json()).toHaveLength(1);
    await expect(pool.query("UPDATE voice_element_revisions SET engine='x' WHERE id=$1", [created.json().id])).rejects.toThrow(/append-only/);
  });
  it("persists a consented validated microphone take idempotently and keeps access scoped",async()=>{
    const key=randomUUID(),wav=Buffer.from(await encodeMonoWav([new Float32Array(4800).fill(.1)],48000).blob.arrayBuffer()),boundary="microphone-test-boundary";
    const multipart=(bytes=wav,script="A local table read.")=>Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="script"\r\n\r\n${script}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="take.wav"\r\nContent-Type: audio/wav\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const upload=(cookie=adminCookie,consent="true",bytes=wav,script="A local table read.")=>server.app.inject({method:"POST",url:url(`microphone-takes?idempotencyKey=${key}&consent=${consent}`),headers:{origin,cookie,"content-type":`multipart/form-data; boundary=${boundary}`},payload:multipart(bytes,script)});
    const first=await upload();expect(first.statusCode,first.body).toBe(200);expect(first.json().record).toMatchObject({frames:4800,sampleRate:48000,durationSeconds:.1,consent:{microphone:true,attestedBy:ownerId},script:"A local table read."});
    const again=await upload();expect(again.json()).toMatchObject({id:first.json().id,asset_id:first.json().asset_id,repeated:true});
    expect((await upload(adminCookie,"true",wav,"Different text")).statusCode).toBe(409);
    expect((await upload(adminCookie,"false")).statusCode).toBe(400);expect((await upload(viewerCookie)).statusCode).toBe(403);expect((await upload(foreignCookie)).statusCode).toBe(403);
    expect((await upload(adminCookie,"true",Buffer.from("invalid"))).statusCode).toBe(422);
    const list=await request("GET",url("microphone-takes"),undefined,viewerCookie);expect(list.json()).toHaveLength(1);expect(list.json()[0].asset_id).toBe(first.json().asset_id);
    expect((await request("GET",url("microphone-takes"),undefined,foreignCookie)).statusCode).toBe(403);
    const asset=(await pool.query("SELECT metadata FROM assets WHERE id=$1",[first.json().asset_id])).rows[0];expect(asset.metadata.microphoneTake.sha256).toBe(first.json().record.sha256);
    await expect(pool.query("UPDATE microphone_takes SET record='{}' WHERE id=$1",[first.json().id])).rejects.toThrow(/append-only/);
  });

});
