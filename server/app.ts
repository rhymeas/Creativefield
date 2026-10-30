import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import type { Pool } from "pg";
import { z, ZodError } from "zod";
import type { ServerConfig } from "./config";
import { HttpError, member, principal, ensureLocalUser } from "./auth";
import { generateOpaqueToken, hashToken, hashPassword, verifyPassword, newId, encryptProviderSecret } from "./crypto";
import { guardPool, queryWithRetry, transaction } from "./db";
import { DiskStore } from "./storage";
import { loadServerCatalogue } from "./catalogue";
import { assertIndependentProvider, assertWorkerUrl } from "../src/capabilities/policy";
import { capabilityReadiness } from "../src/capabilities/readiness";
import {probeWorker,WorkerMonitor} from "./workers";
import {storageVolume} from "./setup-storage";
import {loadComfyLibrary} from "./comfy-library";
import {microphoneRoutes} from "./microphone-routes";
import {editorDocumentRoutes} from "./editor-documents";
import { resourceRoutes } from "./resources";
import {maskedMediaRoutes} from "./masked-routes";
import {maskCorrectionRoutes} from "./mask-correction";
import { executionRoutes } from "./execution";
import {serveTeamUi} from "./ui";
import {videoFrameInspectionRoutes} from "./video-frame-inspection";
import {storyboardExecutionRoutes} from "./storyboard-execution";
import {storyboardPlanRoutes} from "./storyboard-plan";
import {aiTextSettings,setActiveTextProvider} from "./ai-text";
import {referencePlanRoutes} from "./reference-plan";
import {referenceDescribeRoutes} from "./reference-describe";
import {referenceInspectionRoutes} from "./comfy-editor";
import {replaceAnchorRoutes} from "./replace-anchors";
import {videoProbeSourceRoutes} from "./video-probe";
import {editPlanRoutes} from "./edit-plan";
import {DirectExecutionService,type ProviderDependencies} from "./providers/execution";
import {productionDirectRegistry} from "./providers/registry";
import type {CapabilityBundle} from "../src/capabilities/types";
import {videoExtensionRoutes} from "./video-extension-routes";
import {posePreviewRoutes} from "./pose-preview-routes";
import {characterRoutes} from "./characters";
import {placementDraftRoutes} from "./placement-drafts";
import {voiceRecordRoutes} from "./voice-records";
import {systemVoiceRoutes} from "./system-voice-routes";
import type {SystemVoiceEngine} from "./system-voice";
import {loadWorkspaceCatalogue,workflowImportRoutes} from "./workflow-imports";
import {audioProcessingRoutes} from "./audio-processing-routes";
import {marketingRoutes} from "./marketing/routes";
import {motionClipCheckRoutes} from "./motion-clip-check";
import {replaceClipCheckRoutes} from "./replace-clip-check";
import {cloudAccountFor} from "./cloud-account";
import {ROUTER_MODELS} from '../src/capabilities/router-models';
import {cloudReadiness} from "./cloud-readiness";
import {chatgptImageRoutes} from './chatgpt-images';
import type {ChatgptNative} from './chatgpt-native';
import {ExportProfileError,exportProfile,exportReadiness,exportVideo,type ExportResult} from "./export-profiles";
import {managedLocalComfyOrigin,startLocalComfy,type LocalComfyStarter} from "./local-comfy-start";

export const workspaceParam = z.object({ workspaceId: z.uuid() });
export const idParam = workspaceParam.extend({ id: z.uuid() });
const email = z.email().max(254).transform(s => s.trim().toLowerCase());
const password = z.string().min(12).max(256);
const name = z.string().trim().min(1).max(120);
const role = z.enum(["admin", "creator", "viewer"]);
const base = "/api/v1/workspaces/:workspaceId";

export async function buildServer(config: ServerConfig, pool: Pool, dependencies:ProviderDependencies&{catalogue?:CapabilityBundle[];systemVoice?:SystemVoiceEngine;chatgptNative?:ChatgptNative;localComfyStarter?:LocalComfyStarter}={}) {
  guardPool(pool);
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const store = new DiskStore(config.storageRoot, config.maxUploadBytes);
  const catalogue = dependencies.catalogue??await loadServerCatalogue();
  const registry=dependencies.registry??productionDirectRegistry;
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4 } });
  await maskedMediaRoutes(app,pool,store);
  await maskCorrectionRoutes(app,pool,store);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "Invalid request", fields: error.issues.map(i => i.path.join(".")) });
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message });
    const code = (error as { code?: string }).code;
    if (code === "23505") return reply.code(409).send({ error: "This record already exists" });
    if (code === "23503") return reply.code(404).send({ error: "Related workspace record was not found" });
    if (code?.startsWith("FST_")) return reply.code(400).send({ error: "Invalid or oversized request" });
    return reply.code(500).send({ error: "The server could not complete this request" });
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin !== config.publicOrigin) throw new HttpError(403, "Request origin is not allowed");
  });
  app.get("/api/v1/health", async () => { await queryWithRetry(pool, "SELECT 1"); return { status: "ready", mode: "team", storage: "disk", database: "postgresql" }; });

  const attempts = new Map<string, { count: number; until: number }>();
  function throttle(ip: string) {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    const item = attempts.get(ip) ?? { count: 0, until: now + 60000 };
    if (++item.count > 15 || attempts.size > 2000) throw new HttpError(429, "Too many sign-in attempts; retry shortly");
    attempts.set(ip, item);
  }
  app.post("/api/v1/auth/login", async (request, reply) => {
    throttle(request.ip);
    const input = z.object({ email, password: z.string().min(1).max(256) }).strict().parse(request.body);
    const result = await pool.query("SELECT id,email,password_hash FROM users WHERE email=$1", [input.email]);
    const user = result.rows[0];
    if (!user || !await verifyPassword(input.password, user.password_hash)) throw new HttpError(401, "Email or password is incorrect");
    const token = generateOpaqueToken();
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+($3 * interval '1 hour'))", [hashToken(token), user.id, config.sessionTtlHours]);
    reply.setCookie("cf_session", token, { path: "/", httpOnly: true, sameSite: "strict", secure: config.cookieSecure, maxAge: config.sessionTtlHours * 3600 });
    return { id: user.id, email: user.email };
  });
  app.post("/api/v1/auth/logout", async (request, reply) => {
    if (request.cookies.cf_session) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hashToken(request.cookies.cf_session)]);
    reply.clearCookie("cf_session", { path: "/" }); return { signedOut: true };
  });
  app.get("/api/v1/auth/me", async (request, reply) => {
    try { const user = await principal(pool, request); return config.localSingleUser ? { ...user, localSingleUser: true } : user; }
    catch (error) {
      if (!config.localSingleUser || !(error instanceof HttpError) || error.statusCode !== 401) throw error;
      const user = await ensureLocalUser(pool);
      const token = generateOpaqueToken();
      await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+($3 * interval '1 hour'))", [hashToken(token), user.id, config.sessionTtlHours]);
      reply.setCookie("cf_session", token, { path: "/", httpOnly: true, sameSite: "strict", secure: config.cookieSecure, maxAge: config.sessionTtlHours * 3600 });
      return { ...user, localSingleUser: true };
    }
  });
  app.get("/api/v1/workspaces", async request => {
    const user = await principal(pool, request);
    return (await pool.query("SELECT w.id,w.name,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at", [user.id])).rows;
  });
  app.get(`${base}/members`, async request => {
    const { workspaceId } = workspaceParam.parse(request.params); await member(pool, request, workspaceId, "admin");
    return (await pool.query("SELECT u.id,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1", [workspaceId])).rows;
  });
  app.post(`${base}/invitations`, async request => {
    const { workspaceId } = workspaceParam.parse(request.params), user = await member(pool, request, workspaceId, "admin");
    const input = z.object({ email, role }).strict().parse(request.body), token = generateOpaqueToken(), id = newId();
    await pool.query("INSERT INTO invitations(id,workspace_id,email,role,token_hash,expires_at,created_by) VALUES($1,$2,$3,$4,$5,now()+($6 * interval '1 hour'),$7)", [id,workspaceId,input.email,input.role,hashToken(token),config.inviteTtlHours,user.id]);
    return { id, token, expiresInHours: config.inviteTtlHours };
  });
  app.get(`${base}/invitations`,async request=>{const {workspaceId}=workspaceParam.parse(request.params);await member(pool,request,workspaceId,"admin");return(await pool.query("SELECT id,email,role,expires_at,used_at FROM invitations WHERE workspace_id=$1 ORDER BY expires_at DESC LIMIT 100",[workspaceId])).rows;});
  app.delete(`${base}/invitations/:id`,async request=>{const {workspaceId,id}=idParam.parse(request.params);await member(pool,request,workspaceId,"admin");await pool.query("UPDATE invitations SET used_at=now() WHERE workspace_id=$1 AND id=$2 AND used_at IS NULL",[workspaceId,id]);return {revoked:true};});
  app.post("/api/v1/invitations/accept", async request => {
    throttle(request.ip);
    const input = z.object({ token: z.string().min(20).max(128), password }).strict().parse(request.body);
    return transaction(pool, async client => {
      const invite = (await client.query("SELECT * FROM invitations WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE", [hashToken(input.token)])).rows[0];
      if (!invite) throw new HttpError(400, "Invitation is invalid or expired");
      let user = (await client.query("SELECT id,password_hash FROM users WHERE email=$1", [invite.email])).rows[0];
      if (user) { if (!await verifyPassword(input.password, user.password_hash)) throw new HttpError(401, "Use your existing account password"); }
      else {
        user = { id: newId() };
        await client.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)", [user.id,invite.email,await hashPassword(input.password)]);
      }
      // Existing membership is never escalated implicitly by accepting an old invite.
      await client.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [invite.workspace_id,user.id,invite.role]);
      await client.query("UPDATE invitations SET used_at=now() WHERE id=$1", [invite.id]);
      return { accepted: true, workspaceId: invite.workspace_id };
    });
  });

  app.get(`${base}/catalogue`, async request => {
    const { workspaceId } = workspaceParam.parse(request.params); await member(pool, request, workspaceId);
    return (await loadWorkspaceCatalogue(pool,catalogue,workspaceId)).filter(b=>!b.manifest.posePreviewContract).map(b => b.manifest);
  });
  app.get(`${base}/workers`, async request => {
    const { workspaceId } = workspaceParam.parse(request.params); await member(pool, request, workspaceId);
    /* Name then id, never the storage order: probing a worker rewrites its row, and without an
       ORDER BY the list came back in a different order after a probe, so the worker cards swapped
       places between two visits of the same screen. */
    return (await pool.query("SELECT id,name,origin,kind,enabled,checked_at,inventory FROM workers WHERE workspace_id=$1 ORDER BY name,id", [workspaceId])).rows.map(worker=>({
      ...worker,
      can_start:config.localSingleUser&&worker.kind==="local"&&worker.enabled&&managedLocalComfyOrigin(worker.origin),
    }));
  });
  app.post(`${base}/workers`, async request => {
    const { workspaceId } = workspaceParam.parse(request.params); await member(pool, request, workspaceId, "admin");
    /* A zod rejection says "Invalid request" plus a field name, which leaves a person guessing what a
       valid worker address looks like — so this one sentence replaces it. */
    const parsed = z.object({ name, origin: z.string(), kind: z.enum(["local", "cloud"]).default("local"), apiPrefix: z.enum(["", "/api"]).default("/api") }).strict().safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "Use a worker name and an independent HTTP(S) origin, for example http://127.0.0.1:8188");
    const input = parsed.data;
    let origin: string; try { origin = assertWorkerUrl(input.origin).origin; } catch { throw new HttpError(400, "Use an independent HTTP(S) worker origin without credentials or path"); }
    if (input.kind === "cloud") {
      /* The cloud key is sent to this address, so it may only be Comfy Cloud itself. */
      if (origin !== "https://cloud.comfy.org" || input.apiPrefix !== "/api") throw new HttpError(400, "Comfy Cloud workers use https://cloud.comfy.org with the /api prefix");
      if (!config.comfyCloudApiKey) throw new HttpError(400, "Set COMFY_CLOUD_API_KEY or COMFY_CLOUD_API_KEY_FILE before adding a Comfy Cloud worker");
    }
    return (await pool.query("INSERT INTO workers(id,workspace_id,name,origin,kind,api_prefix) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,origin,kind", [newId(),workspaceId,input.name,origin,input.kind,input.apiPrefix])).rows[0];
  });
  app.delete(`${base}/workers/:id`, async request => {
    const { workspaceId,id } = idParam.parse(request.params); await member(pool, request, workspaceId, "admin");
    const removed = await pool.query("DELETE FROM workers WHERE workspace_id=$1 AND id=$2 RETURNING id", [workspaceId, id]);
    if (!removed.rowCount) throw new HttpError(404, "Worker not found");
    return { removed: id };
  });
  app.post(`${base}/workers/:id/probe`, async request => {
    const { workspaceId,id } = idParam.parse(request.params); await member(pool, request, workspaceId, "admin");
    const worker = (await pool.query("SELECT * FROM workers WHERE workspace_id=$1 AND id=$2", [workspaceId,id])).rows[0];
    if (!worker) throw new HttpError(404, "Worker not found");
    const inventory=await probeWorker(pool,catalogue,worker);
    /* A cloud worker is judged on the pack's own cloud route when it has one, as the team view
       does, and on its key's plan: an account that may not submit leaves every cloud pack
       unrunnable, so that list says the plan in one sentence instead of a node list. */
    const cloud=worker.kind==="cloud";
    return { inventory, capabilities: catalogue.map(b => {
      const route=cloud?b.manifest.routes.find(r => r.execution==="comfy_cloud"):undefined;
      return { id: b.manifest.id, readiness: route?cloudReadiness(b.manifest,route.id,inventory):capabilityReadiness(b.manifest,"local",inventory) };
    }) };
  });
  app.post(`${base}/workers/:id/start`, async request => {
    const { workspaceId,id } = idParam.parse(request.params); await member(pool, request, workspaceId, "admin");
    if (!config.localSingleUser) throw new HttpError(403, "Only this computer's local workspace may start ComfyUI.");
    const worker = (await pool.query("SELECT id,origin,kind,enabled,inventory FROM workers WHERE workspace_id=$1 AND id=$2", [workspaceId,id])).rows[0];
    if (!worker) throw new HttpError(404, "Worker not found");
    if (!worker.enabled || worker.kind !== "local" || !managedLocalComfyOrigin(worker.origin)) throw new HttpError(409, "This worker is not the managed local ComfyUI worker. Open worker settings to fix its address.");
    if (worker.inventory?.online === true) return { state: "already_online" };
    try {
      return await (dependencies.localComfyStarter ?? startLocalComfy)(worker.origin);
    } catch (error) {
      throw new HttpError(503, error instanceof Error ? error.message : "ComfyUI could not be started on this computer.");
    }
  });
  /* Who is behind the Comfy Cloud key: the Comfy account's own name, email, workspace and
     credits, beside the local one. Read-only — no job and no credits — and the key stays here. */
  app.get(`${base}/cloud-account`, async request => {
    const { workspaceId } = workspaceParam.parse(request.params); await member(pool, request, workspaceId);
    return cloudAccountFor(pool, workspaceId, config.comfyCloudApiKey);
  });
  app.get(`${base}/workers/:id/library`, async request => {
    const { workspaceId,id } = idParam.parse(request.params); await member(pool, request, workspaceId);
    const worker = (await pool.query("SELECT id,name,origin,api_prefix FROM workers WHERE workspace_id=$1 AND id=$2", [workspaceId,id])).rows[0];
    if (!worker) throw new HttpError(404, "Worker not found");
    const library=await loadComfyLibrary(worker);
    if(config.localSingleUser){
      const local=["127.0.0.1","localhost","[::1]"].includes(new URL(worker.origin).hostname);
      const [app,models]=await Promise.all([storageVolume(config.storageRoot),local?storageVolume(config.modelRoot):Promise.resolve(null)]);
      library.storage={app,models};
    }
    return library;
  });
  app.get(`${base}/provider-connections`, async request => {
    const { workspaceId } = workspaceParam.parse(request.params); await member(pool, request, workspaceId, "admin");
    return (await pool.query("SELECT id,provider_id,updated_at FROM provider_connections WHERE workspace_id=$1", [workspaceId])).rows;
  });
  app.get(`${base}/router-models`,async request=>{
    const {workspaceId}=workspaceParam.parse(request.params);await member(pool,request,workspaceId);
    const connected=!!(await pool.query('SELECT id FROM provider_connections WHERE workspace_id=$1 AND provider_id=$2',[workspaceId,'comfy-router'])).rowCount;
    return {connected,credentialValidation:'not_checked',models:ROUTER_MODELS};
  });
  app.post(`${base}/provider-connections`, async request => {
    const { workspaceId } = workspaceParam.parse(request.params); await member(pool, request, workspaceId, "admin");
    const input = z.object({ providerId: z.string().max(80), secret: z.string().min(1).max(8192) }).strict().parse(request.body);
    try { assertIndependentProvider(input.providerId); if (input.providerId === "comfy-local") throw new Error(); } catch { throw new HttpError(400, "Provider is not approved for hosted execution"); }
    if(input.providerId==='comfy-router'&&(!/^comfyui-[^\s]+$/.test(input.secret)||input.secret!==input.secret.trim()))throw new HttpError(400,'Enter a Comfy workspace API key beginning with comfyui-');
    const ciphertext = encryptProviderSecret(input.secret, config.masterKey, { workspaceId, providerId: input.providerId });
    return (await pool.query("INSERT INTO provider_connections(id,workspace_id,provider_id,encrypted_secret) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,provider_id) DO UPDATE SET encrypted_secret=EXCLUDED.encrypted_secret,credential_revision=provider_connections.credential_revision+1,updated_at=now() RETURNING id,provider_id,updated_at", [newId(),workspaceId,input.providerId,ciphertext])).rows[0];
  });
  app.delete(`${base}/provider-connections/:id`, async request => {
    const { workspaceId,id } = idParam.parse(request.params); await member(pool, request, workspaceId, "admin");
    await pool.query("DELETE FROM provider_connections WHERE workspace_id=$1 AND id=$2", [workspaceId,id]); return { removed: true };
  });
  /* Where this workspace's AI text runs. Only providers that can work on this machine are listed, and no key is ever read out. */
  app.get(`${base}/ai-text`, async request => {
    const { workspaceId } = workspaceParam.parse(request.params); await member(pool, request, workspaceId, "admin");
    return aiTextSettings(pool, workspaceId);
  });
  app.post(`${base}/ai-text`, async request => {
    const { workspaceId } = workspaceParam.parse(request.params); await member(pool, request, workspaceId, "admin");
    const input = z.object({ providerId: z.enum(["local-comfy","openai-compatible","chatgpt"]) }).strict().parse(request.body);
    const settings = await aiTextSettings(pool, workspaceId);
    if (!settings.providers.some(provider => provider.id === input.providerId && provider.state === "ready")) throw new HttpError(409, "That text provider cannot run here yet");
    await setActiveTextProvider(pool, workspaceId, input.providerId);
    return aiTextSettings(pool, workspaceId);
  });
  await resourceRoutes(app, pool, store);
  /* A finished film as a social-ready file. The dimensions, frame rate, codec and mute policy come
     from export-profiles.ts, so a request cannot widen the delivery contract. */
  const exportBody=z.object({profileId:z.enum(["mp4-h264-720p24","mp4-h264-1080p24"])}).strict();
  const exportColumns="id,project_id,name,media_type,content_type,sha256,bytes,parent_id,created_at,metadata";
  app.post(`${base}/assets/:id/exports`, async request => {
    const {workspaceId,id}=idParam.parse(request.params);
    const user=await member(pool,request,workspaceId,"creator");
    const {profileId}=exportBody.parse(request.body);
    const source=(await pool.query("SELECT id,project_id,name,media_type,storage_key FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rows[0];
    if(!source)throw new HttpError(404,"Asset not found");
    if(source.media_type!=="video")throw new HttpError(400,"Only videos can be made into a downloadable MP4");
    const profile=exportProfile(profileId);
    if((await exportReadiness(profileId)).state!=="ready")throw new HttpError(503,"This team server needs FFmpeg with libx264 and FFprobe to make an MP4");
    let exported:ExportResult;
    try{
      exported=await exportVideo(store,workspaceId,source.storage_key,profileId,new AbortController().signal);
    }catch(error){
      if(error instanceof ExportProfileError)throw new HttpError(422,error.message);
      throw error;
    }
    const assetId=newId(),label=profile.width===1920?"1080p MP4":"720p MP4";
    try{
      return (await pool.query(`INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'video','video/mp4',$5,$6,$7,$8,$9,$10) RETURNING ${exportColumns}`,[assetId,workspaceId,source.project_id,`${String(source.name).slice(0,200)} (${label})`,exported.key,exported.sha256,exported.bytes,user.id,source.id,JSON.stringify({export:exported.metadata})])).rows[0];
    }catch(error){
      // A lost COMMIT acknowledgement can leave the row behind; when the row is
      // confirmed absent the published bytes have no owner, so remove them.
      const saved=await pool.query(`SELECT ${exportColumns} FROM assets WHERE workspace_id=$1 AND id=$2`,[workspaceId,assetId]).then(result=>result.rows[0]).catch(()=>undefined);
      if(saved)return saved;
      const absent=await pool.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,assetId]).then(result=>!result.rowCount).catch(()=>false);
      if(absent)await store.remove(workspaceId,exported.key).catch(()=>{});
      throw error;
    }
  });
  await microphoneRoutes(app,pool,store);
  await editorDocumentRoutes(app,pool);
  await characterRoutes(app, pool);
  await placementDraftRoutes(app, pool);
  await voiceRecordRoutes(app, pool);
  await systemVoiceRoutes(app,pool,store,dependencies.systemVoice);
  const marketing=await marketingRoutes(app,pool,store);
  app.addHook("onClose",()=>marketing.close());
  app.get(`${base}/provider-readiness`,async request=>{
    const {workspaceId}=workspaceParam.parse(request.params);await member(pool,request,workspaceId);
    const query=z.object({capabilityId:z.string().max(120),routeId:z.string().max(80)}).strict().parse(request.query);
    const manifest=catalogue.find(b=>b.manifest.id===query.capabilityId)?.manifest,entry=manifest?registry.resolve(manifest,query.routeId):null;
    if(!entry)return {state:"unsupported",reasons:["No qualified direct provider adapter is available for this route."],missing:[]};
    const credential=(await pool.query("SELECT id FROM provider_connections WHERE workspace_id=$1 AND provider_id=$2",[workspaceId,entry.binding.provider])).rowCount;
    return {state:credential?"ready":"credentials_required",reasons:credential?[]:["Workspace provider credentials are required."],missing:[],credentialValidation:"not_checked"};
  });
  const chatgptImages=await chatgptImageRoutes(app,pool,store,dependencies.chatgptNative);
  const execution = await executionRoutes(app,pool,store,catalogue,registry,(workspace,id)=>chatgptImages.cancel(workspace,id));
  const directExecution=new DirectExecutionService(pool,store,config.masterKey,{...dependencies,registry});
  app.addHook("onClose",()=>directExecution.close());
  await videoFrameInspectionRoutes(app,pool,store);
  const storyboards=await storyboardExecutionRoutes(app,pool,store,catalogue);
  await storyboardPlanRoutes(app,pool);
  await referencePlanRoutes(app,pool);
  await referenceDescribeRoutes(app,pool,store);
  await referenceInspectionRoutes(app,pool);
  await replaceAnchorRoutes(app,pool,store,catalogue);
  await videoProbeSourceRoutes(app,pool,store);
  await editPlanRoutes(app,pool);
  const videoExtensions=await videoExtensionRoutes(app,pool,store,catalogue);
  const posePreviews=await posePreviewRoutes(app,pool,store,catalogue);
  const audioProcessing=await audioProcessingRoutes(app,pool,store);
  await workflowImportRoutes(app,pool);
  await motionClipCheckRoutes(app,pool,store);
  await replaceClipCheckRoutes(app,pool,store);
  app.get(`${base}/node-editor`,async request=>{
    const {workspaceId}=workspaceParam.parse(request.params);await member(pool,request,workspaceId,"creator");
    if(!config.nodeEditorOrigin)throw new HttpError(503,"The isolated node-editor origin is not configured");
    return {url:`${config.nodeEditorOrigin}/comfy/${workspaceId}/`};
  });
  // Bookmarked legacy URLs may redirect, but never execute worker scripts on
  // the authenticated app origin. Absolute worker aliases are not served here.
  const editorRedirect=async(request:import("fastify").FastifyRequest,reply:import("fastify").FastifyReply)=>{
    const {workspaceId}=workspaceParam.parse(request.params);await member(pool,request,workspaceId,"creator");
    if(!config.nodeEditorOrigin)throw new HttpError(503,"The isolated node-editor origin is not configured");
    return reply.redirect(`${config.nodeEditorOrigin}${request.raw.url}`);
  };
  app.get("/comfy/:workspaceId",editorRedirect);
  app.get("/comfy/:workspaceId/*",editorRedirect);
  if(config.serveUi)await serveTeamUi(app,config.uiRoot!,config.nodeEditorOrigin);
  return { app, store, catalogue, execution,directExecution,chatgptImages,storyboards,videoExtensions,posePreviews,audioProcessing,marketing,workerMonitor:new WorkerMonitor(pool,catalogue) };
}

