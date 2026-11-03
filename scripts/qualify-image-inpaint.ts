// Bounded real-worker qualification for the experimental
// `image-edit-sd21-inpaint` route. Exercises the complete
// Fastify/PostgreSQL/storage/execution path against a caller-supplied loopback
// ComfyUI using only the existing server modules and Fastify `app.inject`.
// It never opens 5173/8787, never starts or stops ComfyUI, and never promotes
// the shipped route: the catalogue is cloned in memory and only this route is
// marked implemented for qualification.
//
// Required environment (values are never printed):
//   TEST_DATABASE_URL   PostgreSQL URL; an isolated schema is created/dropped.
//   COMFY_URL           Loopback ComfyUI origin, e.g. http://127.0.0.1:8188.
//   QUALIFY_SOURCE_PNG  Absolute source PNG fixture.
//   QUALIFY_MASK_PNG    Absolute aligned mask PNG fixture.
//   QUALIFY_EVIDENCE_DIR Absolute dedicated evidence directory.
// Optional environment:
//   QUALIFY_STORAGE_ROOT     Default <evidence>/harness-storage-<run>.
//   QUALIFY_TIMEOUT_MS       Submit-to-success deadline (default 900000).
//   QUALIFY_POLL_MS          Poll interval in ms (default 2000).
//   QUALIFY_COMFY_API_PREFIX "" or "/api" (default "").
//   QUALIFY_PROMPT, QUALIFY_NEGATIVE, QUALIFY_SEED, QUALIFY_STEPS, QUALIFY_DENOISE
//                            Control overrides; server range checks still apply.
// Exit code is 0 only when every exercised check passes. Recovery states one
// real run cannot safely cover are recorded as limitations, never simulated.
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {mkdir,readFile,rm,writeFile} from "node:fs/promises";
import path from "node:path";
import {Pool} from "pg";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {loadServerCatalogue} from "../server/catalogue";
import type {ServerConfig} from "../server/config";
import {migrate} from "../server/db";
import {validatePngBytes} from "../server/image-artifacts-validation";
import {assertWorkerUrl} from "../src/capabilities/policy";
import type {CapabilityBundle} from "../src/capabilities/types";

const CAPABILITY_ID="image-edit-sd21-inpaint";
const ORIGIN="http://localhost:5173";
const LOOPBACK_HOSTS=new Set(["127.0.0.1","localhost","::1","[::1]"]);

class QualificationError extends Error {}
type Check={id:string;status:"passed"|"failed"|"not_exercised";detail:string};
const checks:Check[]=[];
function record(id:string,status:Check["status"],detail:string){checks.push({id,status,detail});}
function fail(detail:string):never{throw new QualificationError(detail);}
function expect(condition:boolean,detail:string):asserts condition{if(!condition)fail(detail);}
function sha256(bytes:Uint8Array){return createHash("sha256").update(bytes).digest("hex");}
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

type HarnessConfig={
  databaseUrl:string;comfyOrigin:string;apiPrefix:""|"/api";
  sourcePng:string;maskPng:string;evidenceDir:string;storageRoot:string;storageExplicit:boolean;
  timeoutMs:number;pollMs:number;
  overrides:{prompt?:string;negative?:string;seed?:number;steps?:number;denoise?:number};
};
function requiredEnv(name:string):string{
  const value=process.env[name]?.trim();
  if(!value)fail(`Missing required environment variable ${name}`);
  return value;
}
function gPath(name:string,value:string):string{
  if(!path.isAbsolute(value))fail(name+" must be an absolute path");
  return path.resolve(value);
}
function boundedInt(name:string,fallback:number,min:number,max:number):number{
  const raw=process.env[name]?.trim();
  if(raw===undefined||raw==="")return fallback;
  if(!/^\d+$/.test(raw))fail(`${name} must be an integer between ${min} and ${max}`);
  const value=Number(raw);
  if(!Number.isSafeInteger(value)||value<min||value>max)fail(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
function optionalNumber(name:string):number|undefined{
  const raw=process.env[name]?.trim();
  if(raw===undefined||raw==="")return undefined;
  const value=Number(raw);
  if(!Number.isFinite(value))fail(`${name} must be a finite number`);
  return value;
}
function parseConfig():HarnessConfig{
  let comfy:URL;
  try{comfy=assertWorkerUrl(requiredEnv("COMFY_URL"));}catch{fail("COMFY_URL must be an HTTP(S) origin without credentials, path, query or fragment");}
  if(!LOOPBACK_HOSTS.has(comfy.hostname))fail("COMFY_URL must target a loopback ComfyUI origin only");
  const apiPrefixRaw=process.env.QUALIFY_COMFY_API_PREFIX?.trim()??"";
  if(apiPrefixRaw!==""&&apiPrefixRaw!=="/api")fail('QUALIFY_COMFY_API_PREFIX must be "" or "/api"');
  const evidenceDir=gPath("QUALIFY_EVIDENCE_DIR",requiredEnv("QUALIFY_EVIDENCE_DIR"));
  const storageExplicit=!!process.env.QUALIFY_STORAGE_ROOT?.trim();
  const seed=optionalNumber("QUALIFY_SEED"),steps=optionalNumber("QUALIFY_STEPS");
  if(seed!==undefined&&!Number.isSafeInteger(seed))fail("QUALIFY_SEED must be an integer");
  if(steps!==undefined&&!Number.isSafeInteger(steps))fail("QUALIFY_STEPS must be an integer");
  return {
    databaseUrl:requiredEnv("TEST_DATABASE_URL"),
    comfyOrigin:comfy.origin,apiPrefix:apiPrefixRaw,
    sourcePng:gPath("QUALIFY_SOURCE_PNG",requiredEnv("QUALIFY_SOURCE_PNG")),
    maskPng:gPath("QUALIFY_MASK_PNG",requiredEnv("QUALIFY_MASK_PNG")),
    evidenceDir,
    storageRoot:storageExplicit?gPath("QUALIFY_STORAGE_ROOT",process.env.QUALIFY_STORAGE_ROOT!.trim()):path.join(evidenceDir,`harness-storage-${randomUUID()}`),
    storageExplicit,
    timeoutMs:boundedInt("QUALIFY_TIMEOUT_MS",900000,60000,1800000),
    pollMs:boundedInt("QUALIFY_POLL_MS",2000,250,10000),
    overrides:{
      ...(process.env.QUALIFY_PROMPT!==undefined?{prompt:process.env.QUALIFY_PROMPT}:{}),
      ...(process.env.QUALIFY_NEGATIVE!==undefined?{negative:process.env.QUALIFY_NEGATIVE}:{}),
      ...(seed!==undefined?{seed}:{}),...(steps!==undefined?{steps}:{}),
      ...(optionalNumber("QUALIFY_DENOISE")!==undefined?{denoise:optionalNumber("QUALIFY_DENOISE")!}:{}),
    },
  };
}

type BuiltServer=Awaited<ReturnType<typeof buildServer>>;
const evidence:Record<string,unknown>={checks,limitations:[
  "submission_unknown recovery was not exercised: inducing a lost submission response against the real worker is not safe or deterministic in this harness.",
  "Staged-artifact publication recovery was not exercised unless the run happened to publish from staged state; the normal path publishes from worker history.",
  "Upload validation proves a decoded PNG and semantic role, not grayscale mask pixel content; no grayscale enforcement is claimed.",
  "Manifest output dimension limits are safety ceilings, not qualified GPU capacity.",
  "No image-quality or prompt-adherence claim is made.",
]};
let exitCode=0;
let admin:Pool|undefined,pool:Pool|undefined,server:BuiltServer|undefined;
let schema="",storageRoot="",evidenceDir="",runId="",outputBytes:Buffer|undefined,storageExplicit=false;

async function closeServer(){
  if(!server)return;const current=server;server=undefined;
  await current.execution.close().catch(()=>{});await current.app.close().catch(()=>{});
}
async function main(){
  const cfg=parseConfig();evidenceDir=cfg.evidenceDir;storageRoot=cfg.storageRoot;storageExplicit=cfg.storageExplicit;
  evidence.capabilityId=CAPABILITY_ID;evidence.comfyOrigin=cfg.comfyOrigin;evidence.node=process.version;
  evidence.database="isolated PostgreSQL schema (credentials omitted)";evidence.storage="isolated storage (path omitted)";
  record("config.loopback_only","passed","COMFY_URL is a loopback origin; no ports are opened by this harness");
  const shipped=await loadServerCatalogue();
  const shippedBundle=shipped.find(b=>b.manifest.id===CAPABILITY_ID);
  expect(!!shippedBundle?.manifest.imageInputContract&&!!shippedBundle.manifest.imageArtifacts,"Shipped manifest must declare imageInputContract and imageArtifacts");
  const contract=shippedBundle!.manifest.imageInputContract!;
  const route=shippedBundle!.manifest.routes.find(r=>r.execution==="local_comfy");
  expect(!!route,"Shipped manifest must declare a local_comfy route");
  evidence.shipped={version:shippedBundle!.manifest.version,routeId:route.id,implementation:route.implementation,coverageLocal:shippedBundle!.manifest.coverage.local,imageInputContract:contract};
  const catalogue:CapabilityBundle[]=shipped.map(b=>{
    if(b.manifest.id!==CAPABILITY_ID)return b;
    const clone=structuredClone(b);
    for(const r of clone.manifest.routes)if(r.id===route.id)r.implementation="implemented";
    return clone;
  });
  evidence.catalogueClone={capabilityId:CAPABILITY_ID,routeId:route.id,qualifiedImplementation:"implemented",note:"In-memory clone only; shipped manifest files are not mutated"};
  const [sourceBytes,maskBytes]=await Promise.all([readFile(cfg.sourcePng),readFile(cfg.maskPng)]);
  const [sourcePng,maskPng]=await Promise.all([validatePngBytes(sourceBytes),validatePngBytes(maskBytes)]);
  record("fixtures.valid_png","passed",`source ${sourcePng.width}x${sourcePng.height}, mask ${maskPng.width}x${maskPng.height}`);
  expect(sourcePng.width===maskPng.width&&sourcePng.height===maskPng.height,"Fixture source and mask must have identical dimensions");
  expect(sourcePng.width%contract.dimensionMultiple===0&&sourcePng.height%contract.dimensionMultiple===0,`Fixture dimensions must be divisible by ${contract.dimensionMultiple}`);
  record("fixtures.aligned","passed",`${sourcePng.width}x${sourcePng.height} divisible by ${contract.dimensionMultiple}`);
  const sourceSha=sha256(sourceBytes),maskSha=sha256(maskBytes);
  evidence.inputs={width:sourcePng.width,height:sourcePng.height,sourceSha256:sourceSha,maskSha256:maskSha};

  schema=`cf_qualify_${randomUUID().replaceAll("-","")}`;
  admin=new Pool({connectionString:cfg.databaseUrl});await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new Pool({connectionString:cfg.databaseUrl,options:`-c search_path=${schema}`});await migrate(pool);
  const password=`Qualify-${randomBytes(18).toString("base64")}!a1`;
  const {workspaceId}=await bootstrap(pool,"qualify@example.test",password,"SD21 qualification");
  await mkdir(cfg.storageRoot,{recursive:true});
  const config:ServerConfig={databaseUrl:cfg.databaseUrl,storageRoot:cfg.storageRoot,masterKey:randomBytes(32),publicOrigin:ORIGIN,host:"127.0.0.1",port:0,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:64*1024*1024,cookieSecure:false};
  const build=async()=>{const built=await buildServer(config,pool!,{catalogue});await built.app.ready();return built;};
  server=await build();
  const login=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin:ORIGIN},payload:{email:"qualify@example.test",password}});
  expect(login.statusCode===200,`Login failed with ${login.statusCode}`);
  const cookie=String(login.headers["set-cookie"]).split(";")[0];
  const ws=(tail:string)=>`/api/v1/workspaces/${workspaceId}/${tail}`;
  const api=async(method:"GET"|"POST",tail:string,payload?:unknown)=>{
    const res=await server!.app.inject({method,url:ws(tail),headers:{origin:ORIGIN,cookie},payload:payload as any});
    return res;
  };
  const upload=async(tail:string,filename:string,bytes:Buffer,expectedSemantic:string,expectedSha:string)=>{
    const boundary=`cf-qualify-${randomUUID()}`;
    const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res=await server!.app.inject({method:"POST",url:ws(tail),headers:{origin:ORIGIN,cookie,"content-type":`multipart/form-data; boundary=${boundary}`},payload});
    expect(res.statusCode===200,`Upload ${filename} failed with ${res.statusCode}`);
    const asset=res.json();
    expect(asset.sha256===expectedSha&&asset.metadata?.imageValidation?.semantic===expectedSemantic&&asset.metadata.imageValidation.width===sourcePng.width&&asset.metadata.imageValidation.height===sourcePng.height,`Upload ${filename} did not produce the expected server validation receipt`);
    return asset as {id:string;sha256:string};
  };
  const project=await api("POST","projects",{name:"SD21 qualification"});
  expect(project.statusCode===200,"Project creation failed");const projectId=project.json().id as string;
  const workerRes=await api("POST","workers",{name:"Qualification worker",origin:cfg.comfyOrigin,apiPrefix:cfg.apiPrefix});
  expect(workerRes.statusCode===200,"Worker registration failed");const workerId=workerRes.json().id as string;
  const probe=await api("POST",`workers/${workerId}/probe`);
  expect(probe.statusCode===200,"Worker probe failed");
  const readiness=probe.json().capabilities?.find((c:any)=>c.id===CAPABILITY_ID)?.readiness;
  evidence.worker={online:probe.json().inventory?.online===true,readinessState:readiness?.state,missing:(readiness?.missing??[]).map((r:any)=>r.name)};
  expect(probe.json().inventory?.online===true&&readiness?.state==="ready",`Worker is not ready for ${CAPABILITY_ID}: ${readiness?.state??"unknown"} (${(readiness?.reasons??[]).join(" ")})`);
  record("worker.ready","passed","Real worker probed through the API and route readiness is ready");
  const sourceAsset=await upload(`assets?projectId=${projectId}`,"qualify-source.png",sourceBytes,"image",sourceSha);
  const maskAsset=await upload(`assets?projectId=${projectId}&kind=mask`,"qualify-mask.png",maskBytes,"mask",maskSha);
  record("upload.receipts","passed","Source and mask uploaded through the real API with matching validation receipts");
  const controls:Record<string,unknown>={...Object.fromEntries(shippedBundle!.manifest.controls.filter(c=>!c.disabledReason&&c.default!==undefined).map(c=>[c.id,c.default])),...cfg.overrides};
  const submitted=await api("POST","runs",{projectId,workerId,idempotencyKey:`qualify-${randomUUID()}`,capabilityId:CAPABILITY_ID,version:shippedBundle!.manifest.version,routeId:route.id,inputs:{[contract.sourceInput]:sourceAsset.id,[contract.maskInput]:maskAsset.id},controls,audioPolicy:"mute"});
  expect(submitted.statusCode===200,`Run submission failed with ${submitted.statusCode}: ${submitted.json()?.error??""}`);
  runId=submitted.json().id;evidence.runId=runId;
  const stored=(await pool.query("SELECT invocation FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,runId])).rows[0]?.invocation;
  expect(stored?.imageInputSnapshot?.sourceAssetId===sourceAsset.id&&stored.imageInputSnapshot.maskAssetId===maskAsset.id&&stored.imageInputSnapshot.sourceSha256===sourceSha&&stored.imageInputSnapshot.maskSha256===maskSha&&stored.imageInputSnapshot.width===sourcePng.width&&stored.imageInputSnapshot.height===sourcePng.height&&stored.imageInputSnapshot.dimensionMultiple===contract.dimensionMultiple,"Frozen imageInputSnapshot does not match the uploaded aligned pair");
  record("admission.snapshot","passed","Run admitted with a frozen aligned-image receipt matching ids, hashes, dimensions and multiple");
  const getRun=async()=>(await api("GET",`runs/${runId}`)).json();
  const deadline=Date.now()+cfg.timeoutMs,observedStates:string[]=[];
  const noteState=(s:string)=>{if(observedStates.at(-1)!==s)observedStates.push(s);};
  await server.execution.tick();
  let current=await getRun();noteState(current.state);
  expect(["queued","running","submission_unknown"].includes(current.state),`Expected submitted run after first tick, saw ${current.state}${current.error?`: ${current.error}`:""}`);
  const remoteBefore=current.remote_id??null,stateBeforeRestart=current.state;
  record("execution.submitted","passed",`First tick submitted the run (${stateBeforeRestart})`);
  await closeServer();server=await build();
  current=await getRun();noteState(current.state);
  const submittingEvents=Number((await pool.query("SELECT count(*)::int AS n FROM run_events WHERE workspace_id=$1 AND run_id=$2 AND state='submitting'",[workspaceId,runId])).rows[0].n);
  expect((remoteBefore===null||current.remote_id===remoteBefore)&&submittingEvents===1,"Application restart resubmitted the run");
  evidence.restart={mode:`mid_run:${stateBeforeRestart}`,submittingEvents,remoteIdPreserved:remoteBefore!==null};
  record("restart.no_resubmission","passed",`Restarted during ${stateBeforeRestart}; exactly one submitting event and remote identity preserved`);
  while(!["succeeded","failed","canceled"].includes(current.state)){
    expect(Date.now()<deadline,`Timed out after ${cfg.timeoutMs}ms in state ${current.state}`);
    await server.execution.tick();current=await getRun();noteState(current.state);
    if(!["succeeded","failed","canceled"].includes(current.state))await sleep(cfg.pollMs);
  }
  evidence.observedStates=observedStates;
  expect(current.state==="succeeded",`Run ended ${current.state}${current.error?`: ${current.error}`:""}`);
  record("execution.succeeded","passed",`States: ${observedStates.join(" -> ")}`);
  expect(Array.isArray(current.output_ids)&&current.output_ids.length===1,"Run must publish exactly one output");
  const outputId=current.output_ids[0] as string;
  const detail=(await api("GET",`assets/${outputId}`)).json();
  expect(detail.media_type==="image"&&detail.content_type==="image/png"&&detail.project_id===projectId,"Published output is not a project PNG image");
  expect(detail.provenance?.imageValidation?.semantic==="image"&&detail.provenance.imageValidation.width===sourcePng.width&&detail.provenance.imageValidation.height===sourcePng.height,"Published output dimensions do not match the source");
  const relations=[...(detail.relations??[])].sort((a:any,b:any)=>a.ordinal-b.ordinal);
  expect(relations.length===2&&relations[0].role==="source"&&relations[0].ordinal===0&&relations[0].asset_id===sourceAsset.id&&relations[0].metadata?.assetSha256===sourceSha&&relations[1].role==="mask"&&relations[1].ordinal===1&&relations[1].asset_id===maskAsset.id&&relations[1].metadata?.assetSha256===maskSha,"Ordered source/mask relations or hashes do not match");
  record("output.relations","passed","Exactly one PNG with ordered source(0)/mask(1) relations and matching hashes");
  const download=await api("GET",`assets/${outputId}/content`);
  expect(download.statusCode===200,"Published output download failed");
  outputBytes=download.rawPayload;
  const decoded=await validatePngBytes(outputBytes);
  expect(decoded.width===sourcePng.width&&decoded.height===sourcePng.height&&sha256(outputBytes)===detail.sha256,"Downloaded output failed PNG/hash verification");
  evidence.output={assetId:outputId,width:decoded.width,height:decoded.height,sha256:detail.sha256,bytes:outputBytes.byteLength};
  record("output.download_valid","passed","Downloaded output decodes as a bounded PNG and matches the asset hash");
  const slots=(await pool.query("SELECT state FROM run_artifact_slots WHERE workspace_id=$1 AND run_id=$2",[workspaceId,runId])).rows;
  expect(slots.length===1&&slots[0].state==="published","Expected exactly one published artifact slot");
  const provenanceRes=await api("GET",`runs/${runId}/provenance`);
  expect(provenanceRes.statusCode===200,"Provenance lookup failed");
  const provenanceText=provenanceRes.body;
  expect(!/storage_key|cf_session|TEST_DATABASE_URL/i.test(provenanceText)&&!provenanceText.includes(cfg.storageRoot),"Provenance leaked private storage or credential material");
  const provenance=provenanceRes.json();
  evidence.provenance={workflowHash:provenance.workflowHash,modelRequirements:provenance.modelRequirements,inputs:provenance.inputs,generatedBy:provenance.outputs?.[0]?.metadata?.generatedBy};
  record("provenance.sanitized","passed","Sanitized provenance captured without storage keys, cookies or database credentials");
  await pool.query("UPDATE workers SET enabled=false WHERE workspace_id=$1 AND id=$2",[workspaceId,workerId]);
  await server.execution.tick();
  const afterDisable=await api("GET",`assets/${outputId}/content`);
  expect(afterDisable.statusCode===200&&sha256(afterDisable.rawPayload)===detail.sha256&&(await getRun()).state==="succeeded","Published asset is not readable with the worker disabled");
  record("availability.worker_disabled","passed","Published asset remains readable with the worker disabled in the workspace; ComfyUI itself was not stopped by this harness");
  evidence.recoveryCoverage={midRunRestart:"exercised",submission_unknown:"not_exercised",stagedPublication:"not_exercised"};
  evidence.result="passed";
}
try{await main();}
catch(error){
  exitCode=1;evidence.result="failed";
  // Messages here are harness/server-generated and must never carry credentials.
  evidence.failure=error instanceof Error?error.message:"Unknown qualification failure";
  record("qualification.failed","failed",String(evidence.failure));
}
finally{
  const cleanup={schemaDropped:false,storageRemoved:false,appAndDbClosed:false};
  try{await closeServer();}catch{/* recorded below */}
  try{await pool?.end();}catch{/* admin cleanup continues */}
  try{if(admin&&schema){await admin.query(`DROP SCHEMA ${schema} CASCADE`);cleanup.schemaDropped=true;}}catch{exitCode=1;evidence.failure=`${evidence.failure??"Cleanup failed"}; isolated schema cleanup failed`;}
  try{await admin?.end();cleanup.appAndDbClosed=true;}catch{/* process exit follows */}
  try{
    const resolved=path.resolve(storageRoot),evidenceResolved=path.resolve(evidenceDir);
    if(storageRoot&&evidenceDir&&!storageExplicit&&path.dirname(resolved)===evidenceResolved&&path.basename(resolved).startsWith("harness-storage-")){await rm(resolved,{recursive:true,force:true});cleanup.storageRemoved=true;}
    else if(storageRoot)evidence.storageNote="Explicit QUALIFY_STORAGE_ROOT retained for caller inspection";
  }catch{evidence.storageNote="Isolated storage removal failed; inspect the evidence directory";}
  evidence.cleanup=cleanup;
  try{
    if(!evidenceDir)throw new Error("QUALIFY_EVIDENCE_DIR was not configured.");
    await mkdir(evidenceDir,{recursive:true});
    if(outputBytes&&runId)await writeFile(path.join(evidenceDir,`output-${runId}.png`),outputBytes);
    const name=`image-inpaint-qualification-${runId||randomUUID()}.json`;
    await writeFile(path.join(evidenceDir,name),`${JSON.stringify(evidence,null,2)}\n`,"utf8");
    console.log(`${evidence.result==="passed"?"PASS":"FAIL"} ${CAPABILITY_ID} qualification; evidence: ${name}`);
    if(evidence.failure)console.log(`Failure: ${evidence.failure}`);
  }catch{exitCode=1;console.log(`FAIL ${CAPABILITY_ID} qualification; evidence could not be written`);}
}
process.exit(exitCode);
