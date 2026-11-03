/** One isolated app/SDK continuation trial; shipped catalogue remains unchanged. */
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {copyFile,mkdir,readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {buildServer} from "../server/app";
import {loadServerCatalogue} from "../server/catalogue";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import {inspectVideoSource} from "../server/video-extension-media";
import type {ServerConfig} from "../server/config";

process.loadEnvFile(".comfyfield/app.env");
process.env.COMFY_SDK_BASE_URL="http://127.0.0.1:8189";
process.env.COMFY_SDK_WORKER_ORIGIN="http://127.0.0.1:8188";
function requiredInput(name:string){const value=process.env[name]?.trim();if(!value)throw new Error("Set "+name+" to an input file.");return value;}
const source=process.env.QUALIFY_SOURCE_VIDEO;if(!source)throw new Error("Set QUALIFY_SOURCE_VIDEO.");
if(!process.env.QUALIFY_EVIDENCE_DIR)throw new Error("Set QUALIFY_EVIDENCE_DIR to a dedicated evidence directory.");
const out=path.resolve(process.env.QUALIFY_EVIDENCE_DIR);
await mkdir(out,{recursive:true});
const native=JSON.parse(await readFile(requiredInput("QUALIFY_NATIVE_RECEIPT"),"utf8"));
if(native.status!=="succeeded")throw new Error("Native envelope qualification missing.");
const catalogue=await loadServerCatalogue(),bundle=catalogue.find(item=>item.manifest.id==="video-edit")!;
bundle.template=JSON.parse(await readFile(requiredInput("QUALIFY_TEMPLATE_JSON"),"utf8"));
bundle.manifest.coverage.local="implemented";bundle.manifest.routes[0].implementation="implemented";
const model=bundle.manifest.routes[0].requirements.find(item=>item.kind==="model"&&item.location==="diffusion_models")!;
model.name=native.modelName;
const queue=await fetch("http://127.0.0.1:8188/queue").then(r=>r.json());if(queue.queue_running.length||queue.queue_pending.length)throw new Error("Worker occupied; no trial submitted.");
const schema=`cf_forward_${randomUUID().replaceAll("-","")}`,root=new Pool({connectionString:process.env.DATABASE_URL});
await root.query(`CREATE SCHEMA ${schema}`);
const pool=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
let server:Awaited<ReturnType<typeof buildServer>>|undefined;
const receipt:any={status:"starting",nativePromptId:native.promptId,startedAt:new Date().toISOString(),catalogue:"in-memory qualification clone only"};
const save=()=>writeFile(path.join(out,"receipt.json"),JSON.stringify(receipt,null,2));
async function close(){if(server){await Promise.all([server.execution.close(),server.directExecution.close(),server.storyboards.close(),server.videoExtensions.close(),server.workerMonitor.close()]);await server.app.close();server=undefined;}}
let ownJobId:string|undefined;
try{
  await migrate(pool);const password=`Fixture-${randomUUID()}!a1`,origin="http://localhost:5173";
  const {workspaceId}=await bootstrap(pool,"forward@example.test",password,"Forward qualification");
  const config:ServerConfig={databaseUrl:process.env.DATABASE_URL!,storageRoot:path.join(out,"store"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:0,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:64*1024*1024,cookieSecure:false};
  const build=async()=>{server=await buildServer(config,pool,{catalogue});await server.app.ready();};await build();
  const login=await server!.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"forward@example.test",password}}),cookie=String(login.headers["set-cookie"]).split(";")[0];
  const api=async(method:"GET"|"POST",tail:string,payload?:unknown)=>{const response=await server!.app.inject({method,url:`/api/v1/workspaces/${workspaceId}/${tail}`,headers:{origin,cookie},payload:payload as any});if(response.statusCode!==200)throw new Error(`App ${method} ${tail}: ${response.statusCode} ${response.json().error}`);return response.json();};
  const project=await api("POST","projects",{name:"Forward qualification"}),worker=await api("POST","workers",{name:"Local qualification worker",origin:"http://127.0.0.1:8188",apiPrefix:""});
  const probe=await api("POST",`workers/${worker.id}/probe`);if(probe.capabilities.find((c:any)=>c.id==="video-edit")?.readiness.state!=="ready")throw new Error("Qualification worker is not ready.");
  const saved=await server!.store.put(workspaceId,createReadStream(source)),assetId=randomUUID(),owner=(await pool.query("SELECT created_by FROM projects WHERE id=$1",[project.id])).rows[0].created_by;
  await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'source.mp4','video','video/mp4',$4,$5,$6,$7)",[assetId,workspaceId,project.id,saved.key,saved.sha256,saved.bytes,owner]);
  const body={projectId:project.id,sourceAssetId:assetId,workerId:worker.id,idempotencyKey:randomUUID(),startFrame:0,endFrameExclusive:16,extensionFrames:8,overlapFrames:5,audioPolicy:"mute",controls:{prompt:native.controls.prompt}};
  const first=await api("POST","video-extensions",body);ownJobId=first.id;receipt.jobId=first.id;receipt.plan=first.plan;receipt.duplicateId=(await api("POST","video-extensions",body)).id;if(receipt.duplicateId!==first.id)throw new Error("Duplicate job created.");
  await server!.videoExtensions.tick();await server!.execution.tick();
  // Restart the app services after enqueueing; durable state must own the child.
  await close();await build();receipt.restartedAfterEnqueue=true;await save();
  const deadline=Date.now()+900000;
  while(Date.now()<deadline){
    await server!.execution.tick();await server!.videoExtensions.tick();
    const job=await api("GET",`video-extensions/${first.id}`);receipt.state=job.state;receipt.stages=job.stages;await save();
    if(job.state==="succeeded"){
      const output=(await pool.query("SELECT * FROM assets WHERE id=$1",[job.output_asset_id])).rows[0];
      const file=await server!.store.file(workspaceId,output.storage_key);await copyFile(file,path.join(out,"extended.mp4"));
      receipt.output=await inspectVideoSource(file,{sourceAssetId:output.id,projectId:project.id});receipt.outputMetadata=output.metadata;
      receipt.child=(await pool.query("SELECT id,state,transport,remote_id,invocation FROM runs WHERE id=$1",[job.stages.find((s:any)=>s.kind==="generate").child_run_id])).rows[0];
      if(receipt.output.frameCount!==24||receipt.output.width!==832||receipt.output.height!==480||receipt.output.hasAudio||receipt.child.transport!=="sdk")throw new Error("App output/transport envelope mismatch.");
      receipt.status="succeeded";receipt.completedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:receipt.status,jobId:first.id,childRun:receipt.child.id,frames:receipt.output.frameCount,transport:receipt.child.transport}));break;
    }
    if(["failed","canceled","stitch_failed"].includes(job.state))throw new Error(`Job ${job.state}: ${job.error}`);
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  if(receipt.status!=="succeeded")throw new Error("Qualification timed out.");
}catch(e){receipt.status="failed";receipt.error=e instanceof Error?e.message:"Unknown qualification failure";await save();throw e;}
finally{
  // Do not drop an active job/schema and strand a child on the real worker.
  const active=ownJobId?(await pool.query("SELECT state FROM video_extension_jobs WHERE id=$1",[ownJobId])).rows[0]:null;
  await close();await pool.end();
  if(!active||["succeeded","failed","canceled","stitch_failed"].includes(active.state))await root.query(`DROP SCHEMA ${schema} CASCADE`);
  else{receipt.retainedSchema=schema;await save();}
  await root.end();
}
