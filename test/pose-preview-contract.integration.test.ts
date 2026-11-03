import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {readFile,writeFile,rm} from "node:fs/promises";
import {Readable} from "node:stream";
import path from "node:path";
import {createServer,type Server} from "node:http";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import {posePreviewWorkflow} from "../server/pose-preview-workflow";
import {normalizeMotionInput} from "../server/motion-media";
import {extractPoseSamples} from "../server/pose-preview-media";
import {posePreviewOutputMetadata} from "../server/pose-preview-admission";
import {preparePosePreview} from "../server/pose-preview-preparation";
import {cleanupPosePreviews} from "../server/pose-preview-service";
import {recordStagedArtifactBatch} from "../server/image-artifacts";
import {ExecutionService} from "../server/execution";
import {motionFixtures} from "./motion-fixtures";
import type {ServerConfig} from "../server/config";
import poseFixture from "../src/ds/fixtures/pose-preview.json";

describe.skipIf(!process.env.TEST_DATABASE_URL)("source-bound pose run admission and publication",()=>{
  const schema=`cf_pose_${randomUUID().replaceAll("-","")}`,bundle=posePreviewWorkflow(1),origin="http://localhost:5173",password="Pose-fixture-password-28!";
  let root:Pool,pool:Pool,app:Awaited<ReturnType<typeof buildServer>>,worker:Server,f:Awaited<ReturnType<typeof motionFixtures>>,workspaceId:string,projectId:string,workerId:string,userId:string,cookie:string,source:any,frame:any,previewId:string,posts=0,uploads=0;
  const pending=new Map<string,unknown[]>(),history:Record<string,unknown>={};let output:Buffer;
  const url=(tail:string)=>`/api/v1/workspaces/${workspaceId}/${tail}`;
  async function api(method:"GET"|"POST",tail:string,payload?:Record<string,unknown>){return app.app.inject({method,url:url(tail),headers:{origin,cookie},payload});}
  const request=()=>({projectId,workerId,idempotencyKey:randomUUID(),capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{frame_0:frame.id},controls:{},audioPolicy:"mute"});
  async function asset(name:string,kind:string,type:string,bytes:Buffer,parentId:string|null=null){const saved=await app.store.put(workspaceId,Readable.from(bytes)),id=randomUUID();return(await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",[id,workspaceId,projectId,name,kind,type,saved.key,saved.sha256,saved.bytes,userId,parentId])).rows[0];}
  beforeAll(async()=>{
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    f=await motionFixtures();const boot=await bootstrap(pool,"pose@example.test",password,"Pose QA");workspaceId=boot.workspaceId;userId=(await pool.query("SELECT id FROM users WHERE email='pose@example.test'")).rows[0].id;
    const config:ServerConfig={databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot:f.store.root,masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:32*1024*1024,cookieSecure:false};app=await buildServer(config,pool,{catalogue:[bundle]});await app.app.ready();const login=await app.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"pose@example.test",password}});cookie=String(login.headers["set-cookie"]).split(";")[0];projectId=(await api("POST","projects",{name:"Pose"})).json().id;
    output=await readFile("test/assets/sdpose-map.png");worker=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks),path=new URL(req.url!,"http://test").pathname;res.setHeader("content-type","application/json");if(path==="/api/upload/image"){uploads++;res.end(JSON.stringify({name:/filename="([^"]+)"/.exec(body.toString())?.[1],subfolder:""}));return;}if(path==="/api/prompt"){const request=JSON.parse(body.toString()),id=randomUUID();posts++;pending.set(id,[posts,id,request.prompt,request.extra_data,["save"]]);res.end(JSON.stringify({prompt_id:id}));return;}if(path==="/api/queue"){res.end(JSON.stringify({queue_running:[],queue_pending:[...pending.values()]}));return;}if(path.startsWith("/api/history/")){const id=path.split("/")[3];res.end(JSON.stringify(history[id]?{[id]:history[id]}:{}));return;}if(path==="/api/view"){res.setHeader("content-type","image/png");res.end(output);return;}res.writeHead(404).end("{}");});await new Promise<void>(resolve=>worker.listen(0,"127.0.0.1",resolve));workerId=(await api("POST","workers",{name:"Pose fixture",origin:`http://127.0.0.1:${(worker.address() as {port:number}).port}`,apiPrefix:"/api"})).json().id;
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:bundle.manifest.routes[0].requirements.filter(r=>r.kind==="node").map(r=>r.name),models:["checkpoints/sdpose_wholebody_fp16.safetensors"],credentials:[]}),workerId]);
    source=await asset("Driving","video","video/mp4",await readFile(await f.make("pose-source","testsrc2=size=704x1280:rate=24",1)));const receipt=await normalizeMotionInput(app.store,workspaceId,source.storage_key),samples=await extractPoseSamples(app.store,workspaceId,receipt);frame=await asset("Prepared frame","image","image/png",samples.frames[0].bytes,source.id);previewId=randomUUID();
    await pool.query("INSERT INTO pose_previews(id,workspace_id,project_id,source_asset_id,source_sha256,worker_id,created_by,request_hash,state,normalized_receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'prepared',$9)",[previewId,workspaceId,projectId,source.id,source.sha256,workerId,userId,"fixture",JSON.stringify(receipt)]);
    await pool.query("INSERT INTO pose_preview_frames(workspace_id,preview_id,ordinal,planned_asset_id,asset_id,storage_key,sha256,bytes,frame_index,seconds,width,height) VALUES($1,$2,0,$3,$3,$4,$5,$6,0,0,704,1280)",[workspaceId,previewId,frame.id,frame.storage_key,frame.sha256,frame.bytes]);
  });
  afterAll(async()=>{await app?.app.close();if(worker){worker.closeAllConnections();await new Promise<void>(resolve=>worker.close(()=>resolve()));}await pool?.end();if(root){await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await root.end();}if(f&&path.resolve(f.dir).startsWith(path.resolve((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform")+path.sep))await rm(f.dir,{recursive:true,force:true});});
  it("refuses ordinary uploaded images, client-forged receipts and internal idempotency keys",async()=>{
    expect((await api("GET","catalogue")).json()).toEqual([]);
    const ordinary=await asset("Ordinary","image","image/png",await readFile("test/assets/motion-character.png"));expect((await api("POST","runs",{...request(),inputs:{frame_0:ordinary.id}})).statusCode).toBe(422);expect((await api("POST","runs",{...request(),posePreviewSnapshot:{previewId}})).statusCode).toBe(400);expect((await api("POST","runs",{...request(),idempotencyKey:`pose-preview:${randomUUID()}`})).statusCode).toBe(400);expect(posts).toBe(0);
  });
  it("freezes lineage, replays once and publishes the exact numeric pose with its PNG",async()=>{
    const body=request(),response=await api("POST","runs",body);expect(response.statusCode,response.body).toBe(200);expect((await api("POST","runs",body)).json().id).toBe(response.json().id);const id=response.json().id;await app.execution.tick();const queued=(await api("GET",`runs/${id}`)).json();expect(queued.state,queued.error).toBe("queued");expect(posts).toBe(1);history[queued.remote_id]={prompt:pending.get(queued.remote_id),outputs:{save:{images:[{filename:"pose.png",subfolder:"",type:"output"}]},keypoints:{text:[JSON.stringify([poseFixture.frames[0].pose])]}},status:{completed:true,status_str:"success",messages:[]}};pending.delete(queued.remote_id);await app.execution.tick();const done=(await api("GET",`runs/${id}`)).json();expect(done.state,done.error).toBe("succeeded");expect(done.output_ids).toHaveLength(1);const saved=(await api("GET",`assets/${done.output_ids[0]}`)).json();expect(saved.metadata.posePreview).toMatchObject({previewId,sourceAssetId:source.id,sourceSha256:source.sha256,frameAssetId:frame.id,frameSha256:frame.sha256,frameIndex:0,seconds:0,fps:24,pose:poseFixture.frames[0].pose});expect((await api("GET",`assets/${done.output_ids[0]}/content`)).rawPayload).toEqual(output);await app.execution.tick();expect(posts).toBe(1);
  });
  it("rejects a queued-time source mutation before any worker upload or POST",async()=>{
    const response=await api("POST","runs",request());expect(response.statusCode,response.body).toBe(200);const file=await app.store.file(workspaceId,source.storage_key),original=await readFile(file),before={posts,uploads};try{await writeFile(file,"changed source");await app.execution.tick();const failed=(await api("GET",`runs/${response.json().id}`)).json();expect(failed.state).toBe("failed");expect(failed.error).toContain("driving source changed");expect({posts,uploads}).toEqual(before);}finally{await writeFile(file,original);}
  });
  it("starts and recovers a source-clip request through HTTP, hiding diagnostic library assets",async()=>{
    expect((await api("GET",`pose-preview-requirements?workerId=${workerId}`)).json().state).toBe("ready");
    expect((await api("GET",`pose-preview-requirements?workerId=${randomUUID()}`)).json().state).toBe("unsupported");
    const inventory=(await pool.query("SELECT inventory FROM workers WHERE id=$1",[workerId])).rows[0].inventory;
    try{await pool.query("UPDATE workers SET inventory=$1 WHERE id=$2",[JSON.stringify({...inventory,models:[]}),workerId]);expect((await api("GET",`pose-preview-requirements?workerId=${workerId}`)).json().state).toBe("download_required");}finally{await pool.query("UPDATE workers SET inventory=$1 WHERE id=$2",[JSON.stringify(inventory),workerId]);}
    const body={requestId:randomUUID(),projectId,sourceAssetId:source.id,workerId};
    const created=await api("POST","pose-previews",body);expect(created.statusCode,created.body).toBe(200);expect(created.json().state).toBe("pending");
    expect((await api("POST","pose-previews",body)).json().id).toBe(body.requestId);
    expect((await api("POST","pose-previews",{...body,sourceAssetId:randomUUID()})).statusCode).toBe(409);
    expect((await api("POST","pose-previews",{...body,normalized_receipt:{}})).statusCode).toBe(400);
    const before=posts;await app.posePreviews.tick();const prepared=(await api("GET",`pose-previews/${body.requestId}`)).json();expect(prepared.state,prepared.error).toBe("queued");expect(prepared.frames).toEqual([]);
    await app.execution.tick();const queued=(await api("GET",`runs/${prepared.run_id}`)).json();expect(queued.state,queued.error).toBe("queued");expect(posts).toBe(before+1);
    history[queued.remote_id]={prompt:pending.get(queued.remote_id),outputs:{save:{images:[{filename:"pose.png",subfolder:"",type:"output"}]},keypoints:{text:[JSON.stringify([poseFixture.frames[0].pose])]}},status:{completed:true,status_str:"success",messages:[]}};pending.delete(queued.remote_id);
    await app.execution.tick();await app.posePreviews.tick();const result=(await api("GET",`pose-previews/${body.requestId}`)).json();expect(result.state,result.error).toBe("succeeded");expect(result.frames).toHaveLength(1);expect(result.frames[0]).toMatchObject({sourceAssetId:source.id,frameIndex:0,seconds:0,pose:poseFixture.frames[0].pose});
    const library=(await api("GET",`assets?projectId=${projectId}&limit=200`)).json().items;expect(library.some((asset:any)=>asset.metadata.posePreviewFrame||asset.metadata.posePreview)).toBe(false);
    expect((await api("GET",`assets/${result.frames[0].assetId}`)).statusCode).toBe(200);
    expect((await api("POST","pose-previews",body)).json().run_id).toBe(prepared.run_id);await app.posePreviews.tick();expect(posts).toBe(before+1);
    const file=await app.store.file(workspaceId,source.storage_key),bytes=await readFile(file);try{await writeFile(file,"changed after preview");expect((await api("GET",`pose-previews/${body.requestId}`)).statusCode).toBe(422);}finally{await writeFile(file,bytes);}
  });
  it("cancels before preparation without model submission and enforces creator/workspace access",async()=>{
    const body={requestId:randomUUID(),projectId,sourceAssetId:source.id,workerId},before=posts;expect((await api("POST","pose-previews",body)).statusCode).toBe(200);
    const other={userId:randomUUID(),workspaceId:randomUUID()};await pool.query("INSERT INTO users(id,email,password_hash) SELECT $1,'pose-viewer@example.test',password_hash FROM users WHERE id=$2",[other.userId,userId]);await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Other pose QA')",[other.workspaceId]);await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin'),($3,$2,'viewer')",[other.workspaceId,other.userId,workspaceId]);
    const login=await app.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"pose-viewer@example.test",password}}),viewer=String(login.headers["set-cookie"]).split(";")[0];
    expect((await app.app.inject({method:"POST",url:url("pose-previews"),headers:{origin,cookie:viewer},payload:{...body,requestId:randomUUID()}})).statusCode).toBe(403);
    expect((await app.app.inject({method:"POST",url:url(`pose-previews/${body.requestId}/cancel`),headers:{origin,cookie:viewer}})).statusCode).toBe(403);
    await pool.query("UPDATE memberships SET role='creator' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,other.userId]);
    expect((await app.app.inject({method:"POST",url:url(`pose-previews/${body.requestId}/cancel`),headers:{origin,cookie:viewer}})).statusCode).toBe(403);
    expect((await app.app.inject({method:"GET",url:`/api/v1/workspaces/${other.workspaceId}/pose-previews/${body.requestId}`,headers:{origin,cookie:viewer}})).statusCode).toBe(404);
    expect((await api("POST",`pose-previews/${body.requestId}/cancel`)).json().state).toBe("cancel_requested");await app.posePreviews.tick();expect((await api("GET",`pose-previews/${body.requestId}`)).json().state).toBe("canceled");expect(posts).toBe(before);
  });
  async function completedPoseRun(poses:unknown){
    const response=await api("POST","runs",request());expect(response.statusCode,response.body).toBe(200);const id=response.json().id;await app.execution.tick();const queued=(await api("GET",`runs/${id}`)).json();expect(queued.state,queued.error).toBe("queued");history[queued.remote_id]={prompt:pending.get(queued.remote_id),outputs:{save:{images:[{filename:"pose.png",subfolder:"",type:"output"}]},keypoints:{text:[JSON.stringify(poses)]}},status:{completed:true,status_str:"success",messages:[]}};pending.delete(queued.remote_id);return id;
  }
  it("refuses an image result whose numeric poses have the wrong count",async()=>{
    const id=await completedPoseRun([]);await app.execution.tick();const failed=(await api("GET",`runs/${id}`)).json();expect(failed.state,failed.error).toBe("failed");expect(failed.output_ids).toEqual([]);
  });
  it("refuses publication if the driving source changes after worker completion",async()=>{
    const id=await completedPoseRun([poseFixture.frames[0].pose]),file=await app.store.file(workspaceId,source.storage_key),original=await readFile(file);try{await writeFile(file,"changed after inference");await app.execution.tick();const failed=(await api("GET",`runs/${id}`)).json();expect(failed.state,failed.error).toBe("failed");expect(failed.output_ids).toEqual([]);expect(failed.error).toContain("driving source changed");}finally{await writeFile(file,original);}
  });
  async function pendingPreview(clip=source){
    const id=randomUUID();await pool.query("INSERT INTO pose_previews(id,workspace_id,project_id,source_asset_id,source_sha256,worker_id,created_by,request_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending')",[id,workspaceId,projectId,clip.id,clip.sha256,workerId,userId,randomUUID()]);return id;
  }
  const poseCatalogue=()=>Array.from({length:6},(_,i)=>posePreviewWorkflow(i+1));
  async function discardPendingChild(id:string){await pool.query("UPDATE runs SET state='canceled' WHERE id=(SELECT run_id FROM pose_previews WHERE id=$1) AND state='pending'",[id]);}
  it("resumes journaled preparation after a partial frame write and queues one child",async()=>{
    const clip=await asset("Preparation clip","video","video/mp4",await readFile(await f.make("pose-preparation","testsrc2=size=64x64:rate=24",12))),id=await pendingPreview(clip),put=app.store.put.bind(app.store);let writes=0;
    const interrupted=vi.spyOn(app.store,"put").mockImplementation(async(...args)=>{if(++writes===3)throw Error("simulated process interruption");return put(...args);});
    try{await expect(preparePosePreview(pool,app.store,poseCatalogue(),workspaceId,id)).rejects.toThrow("simulated process interruption");}finally{interrupted.mockRestore();}
    const saved=(await pool.query("SELECT * FROM pose_previews WHERE id=$1",[id])).rows[0],planned=(await pool.query("SELECT * FROM pose_preview_frames WHERE preview_id=$1 ORDER BY ordinal",[id])).rows;
    expect(saved.state).toBe("preparing");expect(saved.normalized_receipt.sourceSha256).toBe(clip.sha256);expect(planned).toHaveLength(6);expect(planned.every(frame=>frame.asset_id===null)).toBe(true);
    // A stale partial belongs to this journaled slot; restart may remove it.
    await writeFile(path.join(app.store.root,workspaceId,`${planned[1].planned_asset_id}.partial`),"partial frame");
    try{
      const resumed=await preparePosePreview(pool,app.store,poseCatalogue(),workspaceId,id);expect(resumed.state).toBe("queued");expect(resumed.runId).toBeTruthy();
      const replay=await preparePosePreview(pool,app.store,poseCatalogue(),workspaceId,id);expect(replay.runId).toBe(resumed.runId);
      const after=(await pool.query("SELECT * FROM pose_preview_frames WHERE preview_id=$1 ORDER BY ordinal",[id])).rows;expect(after.map(frame=>frame.asset_id)).toEqual(planned.map(frame=>frame.planned_asset_id));
      expect((await pool.query("SELECT count(*)::int AS n FROM runs WHERE idempotency_key=$1",[`pose-preview:${id}`])).rows[0].n).toBe(1);
      const run=(await pool.query("SELECT invocation FROM runs WHERE id=$1",[resumed.runId])).rows[0];expect(run.invocation.posePreviewSnapshot.frames.map((frame:any)=>frame.frameIndex)).toEqual([0,2,4,7,9,11]);
      expect((await pool.query("SELECT count(*)::int AS n FROM assets WHERE metadata->'posePreviewFrame'->>'previewId'=$1",[id])).rows[0].n).toBe(6);
    }finally{await discardPendingChild(id);}
  });
  it("does not steal a live session lock or alter another workspace's request",async()=>{
    const id=await pendingPreview(),other=randomUUID(),client=await pool.connect();
    try{
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))",[`pose-preview-prepare:${workspaceId}/${id}`]);
      expect((await preparePosePreview(pool,app.store,poseCatalogue(),workspaceId,id)).state).toBe("busy");
      await expect(preparePosePreview(pool,app.store,poseCatalogue(),other,id)).rejects.toMatchObject({statusCode:404});
      expect((await pool.query("SELECT state FROM pose_previews WHERE id=$1",[id])).rows[0].state).toBe("pending");
    }finally{await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[`pose-preview-prepare:${workspaceId}/${id}`]);client.release();await pool.query("UPDATE pose_previews SET state='canceled' WHERE id=$1 AND state='pending'",[id]);}
  });
  it("fences cancellation after frame I/O before publishing assets or a run",async()=>{
    const id=await pendingPreview(),put=app.store.put.bind(app.store);let writes=0;
    const cancel=vi.spyOn(app.store,"put").mockImplementation(async(...args)=>{const saved=await put(...args);if(++writes===2)await pool.query("UPDATE pose_previews SET state='cancel_requested' WHERE id=$1",[id]);return saved;});
    try{await expect(preparePosePreview(pool,app.store,poseCatalogue(),workspaceId,id)).rejects.toMatchObject({statusCode:409});}finally{cancel.mockRestore();}
    expect((await pool.query("SELECT state,run_id FROM pose_previews WHERE id=$1",[id])).rows[0]).toMatchObject({state:"cancel_requested",run_id:null});
    expect((await pool.query("SELECT count(*)::int AS n FROM assets WHERE metadata->'posePreviewFrame'->>'previewId'=$1",[id])).rows[0].n).toBe(0);
    const slots=(await pool.query("SELECT storage_key FROM pose_preview_frames WHERE preview_id=$1",[id])).rows,receipt=(await pool.query("SELECT normalized_receipt FROM pose_previews WHERE id=$1",[id])).rows[0].normalized_receipt;
    await app.posePreviews.tick();expect((await api("GET",`pose-previews/${id}`)).json().state).toBe("canceled");
    for(const slot of slots)await expect(app.store.file(workspaceId,slot.storage_key)).rejects.toMatchObject({code:"ENOENT"});await expect(app.store.file(workspaceId,receipt.normalizedKey)).rejects.toMatchObject({code:"ENOENT"});expect(await app.store.file(workspaceId,source.storage_key)).toBeTruthy();
  });
  it("recovers an acknowledged-in-database commit whose response was lost without a duplicate run",async()=>{
    const id=await pendingPreview(),client=await pool.connect(),query=client.query.bind(client);let hasRun=false;
    const lost=vi.spyOn(client,"query").mockImplementation((async(...args:unknown[])=>{
      const result=await (query as (...values:unknown[])=>Promise<unknown>)(...args);
      if(typeof args[0]==="string"&&args[0].startsWith("INSERT INTO runs("))hasRun=true;
      if(args[0]==="COMMIT"&&hasRun)throw Error("lost commit acknowledgement");return result;
    }) as typeof client.query);
    try{await expect(preparePosePreview({connect:async()=>client} as unknown as Pool,app.store,poseCatalogue(),workspaceId,id)).rejects.toThrow("lost commit acknowledgement");}finally{lost.mockRestore();}
    try{
      const saved=(await pool.query("SELECT run_id,state FROM pose_previews WHERE id=$1",[id])).rows[0];expect(saved.state).toBe("queued");
      expect((await preparePosePreview(pool,app.store,poseCatalogue(),workspaceId,id)).runId).toBe(saved.run_id);
      expect((await pool.query("SELECT count(*)::int AS n FROM runs WHERE idempotency_key=$1",[`pose-preview:${id}`])).rows[0].n).toBe(1);
    }finally{await discardPendingChild(id);}
  });
  it("cleans a journaled normalization file even when no receipt was acknowledged",async()=>{
    const id=await pendingPreview(),put=app.store.put.bind(app.store);
    const lost=vi.spyOn(app.store,"put").mockImplementation(async(...args)=>{await put(...args);throw Error("interruption after normalized file rename");});
    try{await expect(preparePosePreview(pool,app.store,poseCatalogue(),workspaceId,id)).rejects.toThrow();}finally{lost.mockRestore();}
    const row=(await pool.query("SELECT normalized_receipt,normalization_candidate_id FROM pose_previews WHERE id=$1",[id])).rows[0];expect(row.normalized_receipt).toBeNull();expect(row.normalization_candidate_id).toBeTruthy();const key=`${workspaceId}/${row.normalization_candidate_id}`;expect(await app.store.file(workspaceId,key)).toBeTruthy();
    await api("POST",`pose-previews/${id}/cancel`);await app.posePreviews.tick();expect((await api("GET",`pose-previews/${id}`)).json().state).toBe("canceled");await expect(app.store.file(workspaceId,key)).rejects.toMatchObject({code:"ENOENT"});
  });
  it("never overwrites a changed complete frame while recovering preparation",async()=>{
    const id=await pendingPreview(),put=app.store.put.bind(app.store);let writes=0;
    const fail=vi.spyOn(app.store,"put").mockImplementation(async(...args)=>{const saved=await put(...args);if(++writes===2)throw Error("after frame rename");return saved;});
    try{await expect(preparePosePreview(pool,app.store,poseCatalogue(),workspaceId,id)).rejects.toThrow("after frame rename");}finally{fail.mockRestore();}
    const slot=(await pool.query("SELECT storage_key FROM pose_preview_frames WHERE preview_id=$1",[id])).rows[0],file=await app.store.file(workspaceId,slot.storage_key);await writeFile(file,"changed complete frame");
    await expect(preparePosePreview(pool,app.store,poseCatalogue(),workspaceId,id)).rejects.toMatchObject({statusCode:422});expect(await readFile(file,"utf8")).toBe("changed complete frame");
    expect((await pool.query("SELECT run_id FROM pose_previews WHERE id=$1",[id])).rows[0].run_id).toBeNull();
  });
  it("discards unpublished frame and normalization candidates when preparation fails",async()=>{
    const clip=await asset("Failed preparation clip","video","video/mp4",await readFile(await f.make("pose-failed-preparation","testsrc2=size=64x64:rate=24",12))),id=await pendingPreview(clip),put=app.store.put.bind(app.store);let writes=0;
    const fail=vi.spyOn(app.store,"put").mockImplementation(async(...args)=>{if(++writes===3)throw Error("simulated failed preparation");return put(...args);});
    try{await app.posePreviews.tick();}finally{fail.mockRestore();}
    const saved=(await pool.query("SELECT state,run_id,normalization_candidate_id,normalized_receipt FROM pose_previews WHERE id=$1",[id])).rows[0];
    expect(saved).toMatchObject({state:"failed",run_id:null});
    const slots=(await pool.query("SELECT storage_key FROM pose_preview_frames WHERE preview_id=$1",[id])).rows;
    for(const slot of slots)await expect(app.store.file(workspaceId,slot.storage_key)).rejects.toMatchObject({code:"ENOENT"});
    if(saved.normalization_candidate_id)await expect(app.store.file(workspaceId,`${workspaceId}/${saved.normalization_candidate_id}`)).rejects.toMatchObject({code:"ENOENT"});
    if(saved.normalized_receipt?.normalizedKey)await expect(app.store.file(workspaceId,saved.normalized_receipt.normalizedKey)).rejects.toMatchObject({code:"ENOENT"});
    expect(await app.store.file(workspaceId,clip.storage_key)).toBeTruthy();
  });
  it("retains published pose frames and removes only old unpublished failed previews",async()=>{
    const clip=await asset("Retention clip","video","video/mp4",await readFile(await f.make("pose-retention","testsrc2=size=64x64:rate=24",12)));
    const failed=await pendingPreview(clip),planned=randomUUID();
    await app.store.put(workspaceId,Readable.from(Buffer.from("frame")),planned);
    await pool.query("INSERT INTO pose_preview_frames(workspace_id,preview_id,ordinal,planned_asset_id,storage_key,sha256,bytes,frame_index,seconds,width,height) VALUES($1,$2,0,$3,$4,$5,5,0,0,1,1)",[workspaceId,failed,planned,`${workspaceId}/${planned}`,"a".repeat(64)]);
    await pool.query("UPDATE pose_previews SET state='failed',updated_at=now()-interval '2 days' WHERE id=$1",[failed]);
    expect(await cleanupPosePreviews(pool,app.store)).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM pose_previews WHERE id=$1",[failed])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM pose_preview_frames WHERE preview_id=$1",[failed])).rows[0].n).toBe(0);
    await expect(app.store.file(workspaceId,`${workspaceId}/${planned}`)).rejects.toMatchObject({code:"ENOENT"});
    expect(await app.store.file(workspaceId,clip.storage_key)).toBeTruthy();
    const kept=await pendingPreview(clip),planned2=randomUUID(),published=await asset("Retention published frame","image","image/png",Buffer.from("published frame"),clip.id);
    await pool.query("INSERT INTO pose_preview_frames(workspace_id,preview_id,ordinal,planned_asset_id,asset_id,storage_key,sha256,bytes,frame_index,seconds,width,height) VALUES($1,$2,0,$3,$4,$5,$6,5,0,0,1,1)",[workspaceId,kept,planned2,published.id,`${workspaceId}/${planned2}`,"b".repeat(64)]);
    await pool.query("UPDATE pose_previews SET state='failed',updated_at=now()-interval '2 days' WHERE id=$1",[kept]);
    expect(await cleanupPosePreviews(pool,app.store)).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM pose_previews WHERE id=$1",[kept])).rows[0].n).toBe(1);
    await pool.query("DELETE FROM pose_preview_frames WHERE preview_id=$1",[kept]);await pool.query("DELETE FROM pose_previews WHERE id=$1",[kept]);
  });
  it("recovers validated staged pose bytes after restart without worker history or another submission",async()=>{
    // A background probe can mark the shared worker offline while the suite runs; this test
    // asserts recovery, not probe history, so it re-asserts a reachable worker first.
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:bundle.manifest.routes[0].requirements.filter(r=>r.kind==="node").map(r=>r.name),models:["checkpoints/sdpose_wholebody_fp16.safetensors"],credentials:[]}),workerId]);
    const response=await api("POST","runs",request());expect(response.statusCode,response.body).toBe(200);const id=response.json().id;await app.execution.tick();const run=(await pool.query("SELECT * FROM runs WHERE id=$1",[id])).rows[0],slot=(await pool.query("SELECT * FROM run_artifact_slots WHERE run_id=$1",[id])).rows[0],saved=await app.store.put(workspaceId,Readable.from(output));
    const pose=posePreviewOutputMetadata(bundle.manifest,run.invocation,{keypoints:{text:[JSON.stringify([poseFixture.frames[0].pose])]}})![0];
    await recordStagedArtifactBatch(pool,{workspaceId,projectId,runId:id,createdBy:userId,artifacts:[{slotId:slot.slot_id,assetId:slot.asset_id,role:slot.role,ordinal:slot.ordinal,mediaType:"image",name:"pose.png",contentType:"image/png",storageKey:saved.key,sha256:saved.sha256,bytes:saved.bytes,metadata:{imageValidation:{validationVersion:1,format:"png",width:704,height:1280,hasAlpha:false,semantic:"image"},posePreview:pose},relations:[{assetId:frame.id,role:"source",ordinal:0,metadata:{assetSha256:frame.sha256}}]}]});
    pending.delete(run.remote_id);delete history[run.remote_id];const before=posts;app.execution.close();const restarted=new ExecutionService(pool,app.store,[bundle]);try{await restarted.tick();const done=(await api("GET",`runs/${id}`)).json();expect(done.state,done.error).toBe("succeeded");expect(done.output_ids).toEqual([slot.asset_id]);expect(posts).toBe(before);const result=(await api("GET",`assets/${slot.asset_id}`)).json();expect(result.metadata.posePreview).toEqual(pose);}finally{restarted.close();}
  });
});
