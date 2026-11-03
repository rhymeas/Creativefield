import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {Pool} from "pg";
import {createServer,type Server} from "node:http";
import {EventEmitter} from "node:events";
import {randomBytes,randomUUID,createHash} from "node:crypto";
import {mkdtemp,readFile,readdir} from "node:fs/promises";
import {Readable} from "node:stream";
import sharp from "sharp";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import type {ServerConfig} from "../server/config";
import type {CapabilityBundle} from "../src/capabilities/types";
import type {RawQueueItem,HistoryEntry} from "../src/comfy/client";
import {recordStagedArtifactBatch} from "../server/image-artifacts";

const connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("durable local execution with PostgreSQL and HTTP worker",()=>{
  const schema=`cf_exec_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,config:ServerConfig;
  let worker:Server,workerId:string,workspaceId:string,projectId:string,cookie:string,bundle:CapabilityBundle,video:Buffer,image:Buffer;
  const accepted=new Map<string,RawQueueItem>(),history:Record<string,HistoryEntry>={};
  let posts=0,dropNext=false,rejectNext=false,invalidVideo=false,invalidImage=false,imageDisconnect=false,globalInterrupts=0,targetedCancels=0,offline=false,uploadStatus=0;
  const paths:string[]=[];
  function url(tail:string){return `/api/v1/workspaces/${workspaceId}/${tail}`;}
  async function api(method:"GET"|"POST",tail:string,payload?:unknown){return server.app.inject({method,url:url(tail),headers:{origin,cookie},payload:payload as any});}
  function invocation(extra:Record<string,unknown>={}) {return {projectId,workerId,idempotencyKey:randomUUID(),capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{},controls:{prompt:"Fixture scene",seed:13},audioPolicy:"mute",...extra};}
  async function enqueue(extra:Record<string,unknown>={}){const r=await api("POST","runs",invocation(extra));expect(r.statusCode,r.body).toBe(200);return r.json();}
  async function run(id:string){return (await api("GET",`runs/${id}`)).json();}
  function complete(remoteId:string,success=true){
    const tuple=accepted.get(remoteId)!;
    history[remoteId]={prompt:tuple,outputs:Object.fromEntries(tuple[4].map(id=>[id,{images:[{filename:tuple[2][id].class_type==="SaveImage"?"fixture.png":"fixture.mp4",subfolder:"",type:"output"}]}])),status:{completed:true,status_str:success?"success":"error",messages:[]}};
    accepted.delete(remoteId);
  }
  beforeAll(async()=>{
    root=new Pool({connectionString});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    config={databaseUrl:connectionString!,storageRoot:await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/exec-test-"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false};
    workspaceId=(await bootstrap(pool,"execution@example.test","Fixture-password-long-27!","Execution tests")).workspaceId;
    server=await buildServer(config,pool);await server.app.ready();
    const login=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"execution@example.test",password:"Fixture-password-long-27!"}});
    cookie=String(login.headers["set-cookie"]).split(";")[0];
    projectId=(await api("POST","projects",{name:"Execution fixture"})).json().id;
    bundle=server.catalogue.find(b=>b.manifest.category==="t2v")!;
    video=await readFile(new URL("./assets/motion-drive.mp4",import.meta.url));image=await sharp({create:{width:8,height:8,channels:4,background:{r:80,g:120,b:180,alpha:1}}}).png().toBuffer();
    worker=createServer(async(req,res)=>{
      const path=new URL(req.url!,"http://fixture").pathname;paths.push(path);
      if(offline){res.writeHead(503).end();return;}
      res.setHeader("Content-Type","application/json");
      if(path==="/api/upload/image"){
        if(uploadStatus){res.writeHead(uploadStatus).end("upload rejected");return;}
        const data=await new Promise<string>((resolve,reject)=>{let text="";const events=req as unknown as EventEmitter;events.on("data",(chunk:Buffer)=>{text+=chunk.toString("latin1");});events.on("end",()=>resolve(text));events.on("error",reject);});
        const filename=/filename="([^"]+)"/.exec(data)?.[1];res.end(JSON.stringify({name:filename,subfolder:""}));return;
      }
      if(path==="/api/prompt"){
        const data=await new Promise<string>((resolve,reject)=>{let text="";const events=req as unknown as EventEmitter;events.on("data",c=>{text+=c;});events.on("end",()=>resolve(text));events.on("error",reject);});
        posts++;if(rejectNext){rejectNext=false;res.writeHead(400).end(JSON.stringify({error:"rejected"}));return;}
        const body=JSON.parse(data),id=randomUUID();
        accepted.set(id,[posts,id,body.prompt,body.extra_data,Object.keys(body.prompt).filter(k=>["SaveVideo","SaveImage"].includes(body.prompt[k].class_type))]);
        if(dropNext){dropNext=false;res.destroy();return;}
        res.end(JSON.stringify({prompt_id:id}));return;
      }
      if(path==="/api/queue"){res.end(JSON.stringify({queue_running:[],queue_pending:[...accepted.values()]}));return;}
      if(path.startsWith("/api/history")){const id=path.split("/")[3];res.end(JSON.stringify(id?(history[id]?{[id]:history[id]}:{}):history));return;}
      if(path==="/api/view"){
        const filename=new URL(req.url!,"http://fixture").searchParams.get("filename")??"";
        if(filename.endsWith(".png")){
          res.setHeader("Content-Type","image/png");
          if(imageDisconnect){res.flushHeaders();res.write(image.subarray(0,Math.max(1,Math.floor(image.length/2))));setImmediate(()=>res.destroy());return;}
          res.end(invalidImage?Buffer.from("not a png"):image);return;
        }
        res.setHeader("Content-Type","video/mp4");res.end(invalidVideo?Buffer.from("not a video"):video);return;
      }
      if(path.match(/^\/api\/jobs\/[^/]+\/cancel$/)){targetedCancels++;const id=path.split("/")[3];accepted.delete(id);res.end(JSON.stringify({cancelled:true}));return;}
      if(path==="/api/interrupt")globalInterrupts++;
      res.writeHead(404).end("{}");
    });
    await new Promise<void>(resolve=>worker.listen(0,"127.0.0.1",resolve));
    const address=worker.address() as {port:number};
    const added=await api("POST","workers",{name:"Fixture worker",origin:`http://127.0.0.1:${address.port}`,apiPrefix:"/api"});expect(added.statusCode).toBe(200);workerId=added.json().id;
    const requirements=bundle.manifest.routes[0].requirements;
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:requirements.filter(r=>r.kind==="node").map(r=>r.name),models:requirements.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),credentials:[]}),workerId]);
  },30000);
  afterAll(async()=>{await server?.execution.close();await server?.app.close();worker?.closeAllConnections();if(worker)await new Promise<void>(resolve=>worker.close(()=>resolve()));await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}});
  it("deduplicates concurrent submissions and persists a verified artifact",async()=>{
    const request=invocation(),[a,b]=await Promise.all([api("POST","runs",request),api("POST","runs",request)]);
    expect(a.statusCode,a.body).toBe(200);expect(b.statusCode,b.body).toBe(200);expect(a.json().id).toBe(b.json().id);
    expect((await api("POST","runs",{...request,controls:{prompt:"Changed"}})).statusCode).toBe(409);
    const count=posts;await Promise.all([server.execution.tick(),server.execution.tick()]);expect(posts).toBe(count+1);
    const queued=await run(a.json().id);expect(queued.state).toBe("queued");
    const graph=(await api("GET",`runs/${queued.id}/workflow`)).json().graph;
    const binding=bundle.manifest.controls.find(c=>c.id==="prompt")!.binding!;expect(graph[binding.node].inputs[binding.field]).toBe("Fixture scene");
    complete(queued.remote_id);await server.execution.tick();const done=await run(queued.id);expect(done.state).toBe("succeeded");expect(done.output_ids).toHaveLength(1);
    const asset=(await pool.query("SELECT * FROM assets WHERE id=$1",[done.output_ids[0]])).rows[0];expect(asset.metadata.durationSeconds).toBeGreaterThan(0);
    const listed=(await api("GET",`runs?projectId=${projectId}`)).json().find((r:any)=>r.id===done.id);expect(listed.output_content_type).toBe("video/mp4");expect(listed).not.toHaveProperty("invocation");
    expect((await api("GET",`assets/${asset.id}/content`)).rawPayload).toEqual(video);
    const provenance=(await api("GET",`runs/${done.id}/provenance`)).json();expect(provenance.outputs).toHaveLength(1);expect(provenance.outputs[0]).toMatchObject({id:asset.id,project_id:projectId,media_type:"video",sha256:asset.sha256});expect(JSON.stringify(provenance)).not.toContain("storage_key");expect(JSON.stringify(provenance)).not.toContain(config.storageRoot);
    await server.execution.tick();expect((await pool.query("SELECT count(*) FROM assets WHERE id=$1",[asset.id])).rows[0].count).toBe("1");
  });
  it("exports the resolved graph as a secret-free, digest-pinned contract",async()=>{
    const created=await enqueue({controls:{prompt:"Export fixture",seed:31}});
    await server.execution.tick();
    const submitted=await run(created.id);
    if(submitted.remote_id){complete(submitted.remote_id);await server.execution.tick();}
    const response=await api("GET",`runs/${created.id}/workflow`);expect(response.statusCode,response.body).toBe(200);
    const exported=response.json();
    expect(exported).toMatchObject({contractVersion:1,capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local"});
    expect(exported.workflowRevisionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(exported.graphSha256).toBe(createHash("sha256").update(JSON.stringify(exported.graph)).digest("hex"));
    const stored=(await pool.query("SELECT graph FROM runs WHERE id=$1",[created.id])).rows[0].graph;
    expect(exported.graph).toEqual(stored);
    const binding=bundle.manifest.controls.find(c=>c.id==="prompt")!.binding!;
    expect(exported.graph[binding.node].inputs[binding.field]).toBe("Export fixture");
    const text=JSON.stringify(exported);
    expect(text).not.toMatch(/storage_key|database_url|master_key|api[_-]?key|authorization/i);
    expect(text).not.toContain(config.storageRoot);
    const foreignUser=randomUUID(),foreignWorkspace=randomUUID();
    await pool.query("INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users WHERE email=$3",[foreignUser,"export-foreign@example.test","execution@example.test"]);
    await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Foreign export workspace')",[foreignWorkspace]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[foreignWorkspace,foreignUser]);
    const login=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"export-foreign@example.test",password:"Fixture-password-long-27!"}});
    expect(login.statusCode,login.body).toBe(200);
    const otherCookie=String(login.headers["set-cookie"]).split(";")[0];
    const foreign=await server.app.inject({method:"GET",url:url(`runs/${created.id}/workflow`),headers:{origin,cookie:otherCookie}});
    expect([403,404]).toContain(foreign.statusCode);
    expect(foreign.body).not.toContain("graphSha256");
  });
  it("recovers an accepted but disconnected submission after application restart without resubmitting",async()=>{
    const created=await enqueue();dropNext=true;const count=posts;await server.execution.tick();expect((await run(created.id)).state).toBe("submission_unknown");
    await server.execution.close();await server.app.close();server=await buildServer(config,pool);await server.app.ready();
    await server.execution.tick();const recovered=await run(created.id);expect(recovered.remote_id).toBeTruthy();expect(recovered.state).toBe("queued");expect(posts).toBe(count+1);
    complete(recovered.remote_id);await server.execution.tick();expect((await run(created.id)).state).toBe("succeeded");
  });
  it("resolves submission_unknown runs against the worker without resubmitting",async()=>{
    const dropped=await enqueue();dropNext=true;const count=posts;await server.execution.tick();expect((await run(dropped.id)).state).toBe("submission_unknown");
    const discovered=await api("POST",`runs/${dropped.id}/resolve-unknown`);expect(discovered.statusCode,discovered.body).toBe(200);expect(discovered.json()).toMatchObject({state:"queued"});expect(posts).toBe(count+1);
    complete((await run(dropped.id)).remote_id);await server.execution.tick();expect((await run(dropped.id)).state).toBe("succeeded");
    const neverSubmitted=await enqueue();await pool.query("UPDATE runs SET state='submission_unknown',remote_id=NULL,updated_at=now() WHERE id=$1",[neverSubmitted.id]);
    const resolved=await api("POST",`runs/${neverSubmitted.id}/resolve-unknown`);expect(resolved.statusCode,resolved.body).toBe(200);expect(resolved.json()).toEqual({state:"failed"});
    const after=(await run(neverSubmitted.id));expect(after.state).toBe("failed");expect(after.error).toContain("not accepted");
    const stuck=await enqueue();await pool.query("UPDATE runs SET state='submission_unknown',remote_id=NULL,updated_at=now() WHERE id=$1",[stuck.id]);
    offline=true;const refused=await api("POST",`runs/${stuck.id}/resolve-unknown`);offline=false;
    expect(refused.statusCode).toBe(422);expect((await run(stuck.id)).state).toBe("submission_unknown");
    const manual=await api("POST",`runs/${stuck.id}/resolve-unknown`,{resolution:"mark_failed"});
    expect(manual.statusCode,manual.body).toBe(200);expect(manual.json()).toEqual({state:"failed",manual:true});
    const manuallyResolved=await run(stuck.id);expect(manuallyResolved.state).toBe("failed");expect(manuallyResolved.error).toContain("manually marked");
    expect((await api("POST",`runs/${stuck.id}/resolve-unknown`)).statusCode).toBe(409);
  });
  it("cancels pending and queued runs without global interruption",async()=>{
    const before=posts,pending=await enqueue();expect((await api("POST",`runs/${pending.id}/cancel`)).json().state).toBe("canceled");await server.execution.tick();expect(posts).toBe(before);
    const queued=await enqueue();await server.execution.tick();expect((await api("POST",`runs/${queued.id}/cancel`)).json().state).toBe("cancel_requested");await server.execution.tick();expect((await run(queued.id)).state).toBe("canceled");expect(targetedCancels).toBeGreaterThan(0);expect(globalInterrupts).toBe(0);
  });
  it("retains durable state through worker outage and reports rejected or failed work",async()=>{
    rejectNext=true;const rejected=await enqueue();await server.execution.tick();expect((await run(rejected.id)).state).toBe("failed");
    const created=await enqueue();await server.execution.tick();offline=true;await server.execution.tick();expect((await run(created.id)).state).toBe("queued");offline=false;
    complete((await run(created.id)).remote_id,false);await server.execution.tick();expect((await run(created.id)).state).toBe("failed");
  });
  it("recovers an interruption after cancellation response loss and restart",async()=>{
    const created=await enqueue();await server.execution.tick();const queued=await run(created.id);
    await api("POST",`runs/${created.id}/cancel`);
    history[queued.remote_id]={prompt:accepted.get(queued.remote_id),outputs:{},status:{completed:false,status_str:"error",messages:[["execution_interrupted",{}]]}};
    accepted.delete(queued.remote_id);
    await server.execution.close();await server.app.close();server=await buildServer(config,pool);await server.app.ready();
    await server.execution.tick();expect((await run(created.id)).state).toBe("canceled");expect(globalInterrupts).toBe(0);
  });
  it("fails deterministically corrupt outputs without rerunning generation",async()=>{
    const created=await enqueue();await server.execution.tick();complete((await run(created.id)).remote_id);invalidVideo=true;const count=posts;
    const filesBefore=await readdir(`${config.storageRoot}/${workspaceId}`);await server.execution.tick();const current=await run(created.id);expect(current.state).toBe("failed");expect(current.error).toContain("failed validation");expect(await readdir(`${config.storageRoot}/${workspaceId}`)).toEqual(filesBefore);
    invalidVideo=false;await server.execution.tick();expect((await run(created.id)).state).toBe("failed");expect(posts).toBe(count);
  });
  it("resolves an Element asset into ordinary local-run inputs and freezes its provenance",async()=>{
    const elementBundle=server.catalogue.find(candidate=>candidate.manifest.id==="wan22-ti2v-5b"&&candidate.manifest.inputs.some(input=>input.id==="start_image"))!;
    expect(elementBundle).toBeTruthy();
    const requirements=elementBundle.manifest.routes[0].requirements;
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:requirements.filter(r=>r.kind==="node").map(r=>r.name),models:requirements.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),credentials:[]}),workerId]);
    const owner=(await pool.query("SELECT created_by FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,projectId])).rows[0].created_by;
    const assetId=randomUUID(),elementId=randomUUID(),sha="a".repeat(64);
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,NULL,'Shared character','image','image/png',$3,$4,1,$5)",[assetId,workspaceId,`${workspaceId}/${assetId}`,sha,owner]);
    await pool.query("INSERT INTO elements(id,workspace_id,name,kind,created_by) VALUES($1,$2,'Reusable character','character',$3)",[elementId,workspaceId,owner]);
    await pool.query("INSERT INTO element_assets(workspace_id,element_id,asset_id) VALUES($1,$2,$3)",[workspaceId,elementId,assetId]);
    const request=invocation({capabilityId:elementBundle.manifest.id,version:elementBundle.manifest.version,routeId:"local",inputs:{},elementInputs:{start_image:{elementId,assetId}}});
    const admitted=await api("POST","runs",request);expect(admitted.statusCode,admitted.body).toBe(200);
    const stored=(await pool.query("SELECT invocation FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,admitted.json().id])).rows[0].invocation;
    expect(stored.inputs).toEqual({start_image:assetId});
    expect(stored.elementInputSnapshots).toEqual({start_image:{validationVersion:1,inputPort:"start_image",elementId,elementKind:"character",assetId,assetSha256:sha,assetMediaType:"image",assetProjectId:null}});
    expect((await pool.query("SELECT role,asset_id FROM run_inputs WHERE workspace_id=$1 AND run_id=$2",[workspaceId,admitted.json().id])).rows).toEqual([{role:"start_image",asset_id:assetId}]);
    expect((await api("POST","runs",{...request,idempotencyKey:randomUUID(),elementInputSnapshots:stored.elementInputSnapshots})).statusCode).toBe(400);
    expect((await api("POST","runs",{...request,idempotencyKey:randomUUID(),inputs:{start_image:assetId}})).statusCode).toBe(400);
  });
  it("plans, validates and atomically publishes pinned PNG outputs across an import retry",async()=>{
    const imageBundle=server.catalogue.find(candidate=>candidate.manifest.id==="image-edit-sd21-inpaint")!;
    expect(imageBundle.manifest.imageArtifacts).toBeTruthy();
    imageBundle.manifest.routes[0].implementation="implemented";
    const requirements=imageBundle.manifest.routes[0].requirements;
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:requirements.filter(r=>r.kind==="node").map(r=>r.name),models:requirements.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),credentials:[]}),workerId]);
    const owner=(await pool.query("SELECT created_by FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,projectId])).rows[0].created_by;
    const sourceId=randomUUID(),maskId=randomUUID(),source=await server.store.put(workspaceId,Readable.from(image)),mask=await server.store.put(workspaceId,Readable.from(image));
    await pool.query(`INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES
      ($1,$2,$3,'source.png','image','image/png',$4,$5,$6,$7,$8),
      ($9,$2,$3,'mask.png','mask','image/png',$10,$11,$12,$7,$13)`,[
      sourceId,workspaceId,projectId,source.key,source.sha256,source.bytes,owner,JSON.stringify({imageValidation:{validationVersion:1,format:"png",width:8,height:8,hasAlpha:false,semantic:"image"}}),
      maskId,mask.key,mask.sha256,mask.bytes,JSON.stringify({imageValidation:{validationVersion:1,format:"png",width:8,height:8,hasAlpha:false,semantic:"mask"}}),
    ]);
    const admitted=await enqueue({capabilityId:imageBundle.manifest.id,version:imageBundle.manifest.version,routeId:"local",inputs:{source_image:sourceId,edit_mask:maskId},controls:{prompt:"Replace the selected area",negative:"",seed:7,steps:2,denoise:1}});
    const planned=(await pool.query("SELECT state,role,ordinal,media_type FROM run_artifact_slots WHERE workspace_id=$1 AND run_id=$2",[workspaceId,admitted.id])).rows;
    expect(planned).toEqual([{state:"planned",role:"image",ordinal:0,media_type:"image"}]);
    await server.execution.tick();const queued=await run(admitted.id);expect(queued.state).toBe("queued");complete(queued.remote_id);
    imageDisconnect=true;const submissions=posts;await server.execution.tick();expect((await run(admitted.id)).state).toBe("queued");expect(posts).toBe(submissions);
    await server.execution.close();await server.app.close();server=await buildServer(config,pool,{catalogue:server.catalogue});await server.app.ready();imageDisconnect=false;
    await server.execution.tick();const done=await run(admitted.id);expect(done.state).toBe("succeeded");expect(posts).toBe(submissions);expect(done.output_ids).toHaveLength(1);
    const asset=(await pool.query("SELECT * FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,done.output_ids[0]])).rows[0];
    expect(asset).toMatchObject({project_id:projectId,media_type:"image",content_type:"image/png",created_by:owner});
    expect(asset.metadata).toMatchObject({imageValidation:{validationVersion:1,format:"png",width:8,height:8,hasAlpha:false,semantic:"image"},generatedBy:{producerRunId:admitted.id,capabilityId:imageBundle.manifest.id,routeId:"local",operation:"edited-image"}});
    expect((await api("GET",`assets/${asset.id}/content`)).rawPayload).toEqual(image);
    const relations=(await pool.query("SELECT role,ordinal,related_asset_id,metadata FROM asset_relations WHERE workspace_id=$1 AND asset_id=$2 ORDER BY ordinal",[workspaceId,asset.id])).rows;
    expect(relations).toEqual([
      {role:"source",ordinal:0,related_asset_id:sourceId,metadata:{assetSha256:source.sha256}},
      {role:"mask",ordinal:1,related_asset_id:maskId,metadata:{assetSha256:mask.sha256}},
    ]);
    const provenance=(await api("GET",`runs/${admitted.id}/provenance`)).json();expect(JSON.stringify(provenance)).not.toMatch(/storage_key|storageRoot/);expect(provenance.outputs[0].metadata.generatedBy.operation).toBe("edited-image");
    const canceled=await enqueue({capabilityId:imageBundle.manifest.id,version:imageBundle.manifest.version,routeId:"local",inputs:{source_image:sourceId,edit_mask:maskId},controls:{prompt:"Cancel",negative:"",seed:8,steps:2,denoise:1}});
    expect((await api("POST",`runs/${canceled.id}/cancel`)).json().state).toBe("canceled");
    expect((await pool.query("SELECT state FROM run_artifact_slots WHERE workspace_id=$1 AND run_id=$2",[workspaceId,canceled.id])).rows[0].state).toBe("discarded");
    const invalid=await enqueue({capabilityId:imageBundle.manifest.id,version:imageBundle.manifest.version,routeId:"local",inputs:{source_image:sourceId,edit_mask:maskId},controls:{prompt:"Invalid",negative:"",seed:9,steps:2,denoise:1}});
    await server.execution.tick();complete((await run(invalid.id)).remote_id);const filesBefore=await readdir(`${config.storageRoot}/${workspaceId}`);invalidImage=true;
    await server.execution.tick();invalidImage=false;expect((await run(invalid.id)).state).toBe("failed");expect(await readdir(`${config.storageRoot}/${workspaceId}`)).toEqual(filesBefore);
    expect((await pool.query("SELECT state FROM run_artifact_slots WHERE workspace_id=$1 AND run_id=$2",[workspaceId,invalid.id])).rows[0].state).toBe("discarded");
    expect((await pool.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=(SELECT asset_id FROM run_artifact_slots WHERE workspace_id=$1 AND run_id=$2)",[workspaceId,invalid.id])).rowCount).toBe(0);
    const stagedRun=await enqueue({capabilityId:imageBundle.manifest.id,version:imageBundle.manifest.version,routeId:"local",inputs:{source_image:sourceId,edit_mask:maskId},controls:{prompt:"Recover staged",negative:"",seed:10,steps:2,denoise:1}});
    await server.execution.tick();const stagedQueued=await run(stagedRun.id),slot=(await pool.query("SELECT slot_id,asset_id,role,ordinal,media_type FROM run_artifact_slots WHERE workspace_id=$1 AND run_id=$2",[workspaceId,stagedRun.id])).rows[0];
    const stagedBytes=await server.store.put(workspaceId,Readable.from(image));
    await recordStagedArtifactBatch(pool,{workspaceId,projectId,runId:stagedRun.id,createdBy:owner,artifacts:[{slotId:slot.slot_id,assetId:slot.asset_id,role:slot.role,ordinal:slot.ordinal,mediaType:slot.media_type,name:"staged.png",contentType:"image/png",storageKey:stagedBytes.key,sha256:stagedBytes.sha256,bytes:stagedBytes.bytes,metadata:{imageValidation:{validationVersion:1,format:"png",width:8,height:8,hasAlpha:false,semantic:"image"},generatedBy:{producerRunId:stagedRun.id,capabilityId:imageBundle.manifest.id,routeId:"local",operation:"edited-image"}},relations:[{assetId:sourceId,role:"source",ordinal:0,metadata:{assetSha256:source.sha256}},{assetId:maskId,role:"mask",ordinal:1,metadata:{assetSha256:mask.sha256}}]}]});
    accepted.delete(stagedQueued.remote_id);delete history[stagedQueued.remote_id];offline=true;const stagedPosts=posts;
    await server.execution.close();await server.app.close();server=await buildServer(config,pool,{catalogue:server.catalogue});await server.app.ready();await server.execution.tick();offline=false;
    const stagedDone=await run(stagedRun.id);expect(stagedDone.state).toBe("succeeded");expect(stagedDone.output_ids).toEqual([slot.asset_id]);expect(posts).toBe(stagedPosts);
  });
  it("validates SDK video publication and refuses corrupt or ambiguous artifacts without resubmission",async()=>{
    const requirements=bundle.manifest.routes[0].requirements;
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:requirements.filter(r=>r.kind==="node").map(r=>r.name),models:requirements.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),credentials:[]}),workerId]);
    async function sdkCase(outputs:any[],state="queued"){
      const created=await enqueue();await server.execution.tick();const queued=await run(created.id);accepted.delete(queued.remote_id);
      await pool.query("UPDATE runs SET transport='sdk',state=$1 WHERE id=$2",[state,created.id]);
      const frozen=(await pool.query("SELECT * FROM runs WHERE id=$1",[created.id])).rows[0],before=posts;
      await (server.execution as any).ingestSdk(frozen,{id:"fixture-sdk-job",outputs});expect(posts).toBe(before);return run(created.id);
    }
    const output={nodeId:Object.entries(bundle.template??{}).find(([,node])=>node.class_type==="SaveVideo")?.[0],name:"sdk-fixture.mp4",type:"image",contentType:"video/mp4",sizeBytes:video.length,toBytes:async()=>new Uint8Array(video)};
    const done=await sdkCase([output]);expect(done.state).toBe("succeeded");const asset=(await pool.query("SELECT * FROM assets WHERE id=$1",[done.output_ids[0]])).rows[0];expect(asset.media_type).toBe("video");expect(asset.content_type).toBe("video/mp4");expect(asset.metadata.generation).toMatchObject({transport:"sdk",externalJobId:"fixture-sdk-job"});
    expect((await sdkCase([{...output,toBytes:async()=>new Uint8Array([1,2,3])}])).state).toBe("failed");
    expect((await sdkCase([output,{...output,nodeId:"undeclared"}])).state).toBe("failed");
    expect((await sdkCase([{...output,sizeBytes:65*1024*1024}])).state).toBe("failed");
    expect((await sdkCase([output],"cancel_requested")).state).toBe("canceled");
  });
  it("retries transient preparation failures, then stops at the retry budget",async()=>{
    const cameraBundle=server.catalogue.find(candidate=>candidate.manifest.id==="camera")!,requirements=cameraBundle.manifest.routes[0].requirements;
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:requirements.filter(r=>r.kind==="node").map(r=>r.name),models:requirements.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),credentials:[]}),workerId]);
    const owner=(await pool.query("SELECT created_by FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,projectId])).rows[0].created_by;
    const sourceId=randomUUID(),stored=await server.store.put(workspaceId,Readable.from(image));
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,'retry.png','image','image/png',$4,$5,$6,$7,$8)",[sourceId,workspaceId,projectId,stored.key,stored.sha256,stored.bytes,owner,JSON.stringify({imageValidation:{validationVersion:1,format:"png",width:8,height:8,hasAlpha:false,semantic:"image"}})]);
    const request={capabilityId:cameraBundle.manifest.id,version:cameraBundle.manifest.version,routeId:"local",inputs:{start_image:sourceId},controls:{prompt:"Fixture retry",camera_pose:"Pan Right",speed:1}};
    offline=true;const retried=await enqueue(request);
    await server.execution.tick();
    const pending=await run(retried.id);expect(pending.state).toBe("pending");expect(pending.error).toContain("Transient submission preparation failed");
    const retryEvents=(await pool.query("SELECT state,detail FROM run_events WHERE workspace_id=$1 AND run_id=$2 AND state='retry_scheduled'",[workspaceId,retried.id])).rows;
    expect(retryEvents).toHaveLength(1);expect(retryEvents[0].detail).toMatchObject({attempt:1,nextAttempt:2});
    offline=false;await server.execution.tick();const queued=await run(retried.id);expect(queued.state).toBe("queued");
    complete(queued.remote_id);await server.execution.tick();expect((await run(retried.id)).state).toBe("succeeded");

    offline=true;const blocked=await enqueue(request);for(let attempt=0;attempt<3;attempt++)await server.execution.tick();
    const terminal=await run(blocked.id);expect(terminal.state).toBe("failed");expect(terminal.error).toContain("Workflow preparation or media upload failed before submission");
    expect((await pool.query("SELECT count(*)::int AS count FROM run_events WHERE workspace_id=$1 AND run_id=$2 AND state='retry_scheduled'",[workspaceId,blocked.id])).rows[0].count).toBe(2);

    offline=false;uploadStatus=400;const rejected=await enqueue(request);await server.execution.tick();uploadStatus=0;
    expect((await run(rejected.id)).state).toBe("failed");
    expect((await pool.query("SELECT count(*)::int AS count FROM run_events WHERE workspace_id=$1 AND run_id=$2 AND state='retry_scheduled'",[workspaceId,rejected.id])).rows[0].count).toBe(0);

    offline=true;const canceled=await enqueue(request);await server.execution.tick();expect(await api("POST",`runs/${canceled.id}/cancel`).then(r=>r.json())).toMatchObject({state:"canceled"});await server.execution.tick();expect((await run(canceled.id)).state).toBe("canceled");offline=false;
  });
  it("recovers declared two-image publication from matching completed history without another model POST",async()=>{
    const fixture=structuredClone(bundle);fixture.manifest={...fixture.manifest,id:"two-image-publication-fixture",version:"0.1.0",category:"image",inputs:[],controls:[],presets:[],outputs:[{id:"first",label:"First",type:"image",required:true},{id:"second",label:"Second",type:"image",required:true}],routes:[{...fixture.manifest.routes[0],id:"local",workflowId:"two-image-publication-fixture",requirements:[]}]};
    delete fixture.manifest.resolutions;delete fixture.manifest.timing;
    fixture.template={"1":{class_type:"EmptyImage",inputs:{width:8,height:8,batch_size:1,color:0}},"2":{class_type:"SaveImage",inputs:{images:["1",0],filename_prefix:"fixture-first"}},"3":{class_type:"SaveImage",inputs:{images:["1",0],filename_prefix:"fixture-second"}}};
    server.catalogue.push(fixture);
    const pending=await enqueue({capabilityId:fixture.manifest.id,version:fixture.manifest.version,controls:{}});
    await server.execution.tick();const queued=await run(pending.id);complete(queued.remote_id);
    history[queued.remote_id].outputs={"2":{images:[{filename:"fixture-first.png",subfolder:"",type:"output"}]},"3":{images:[{filename:"fixture-second.png",subfolder:"",type:"output"}]}};
    await pool.query("UPDATE runs SET state='failed',error='Worker returned 2 image artifacts; this run accepts at most 1' WHERE id=$1",[pending.id]);
    const wrong=structuredClone(history[queued.remote_id].prompt!);history[queued.remote_id].prompt=structuredClone(wrong);history[queued.remote_id].prompt![2]["1"].inputs.color=1;
    expect((await api("POST",`runs/${pending.id}/retry-publication`,{})).statusCode).toBe(409);
    history[queued.remote_id].prompt=wrong;
    const before=posts,recover=await api("POST",`runs/${pending.id}/retry-publication`,{});expect(recover.statusCode,recover.body).toBe(200);expect(recover.json().generationResubmitted).toBe(false);
    await server.execution.tick();const done=await run(pending.id);expect(done.state).toBe("succeeded");expect(done.output_ids).toHaveLength(2);expect(posts).toBe(before);
    expect((await api("POST",`runs/${pending.id}/retry-publication`,{})).statusCode).toBe(409);
  });
  it("fails closed on unsupported routes, wrong media, stale inventory and unknown controls",async()=>{
    for(const extra of [{routeId:"higgsfield"},{capabilityId:"replace-object"},{controls:{cameraGeometry:"dolly"}},{inputs:{start_image:randomUUID()}}])expect((await api("POST","runs",invocation(extra))).statusCode).toBeGreaterThanOrEqual(400);
    await pool.query("UPDATE workers SET checked_at=now()-interval '6 minutes' WHERE id=$1",[workerId]);expect((await api("POST","runs",invocation())).statusCode).toBe(422);
    expect(paths.every(path=>path.startsWith("/api/"))).toBe(true);
  });
});
