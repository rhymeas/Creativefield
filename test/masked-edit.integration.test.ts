import {beforeAll,beforeEach,afterAll,describe,it,expect} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {readFile,writeFile,unlink,mkdtemp} from "node:fs/promises";
import {createServer,type Server} from "node:http";
import {EventEmitter} from "node:events";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import {loadServerCatalogue} from "../server/catalogue";
import {hashPassword} from "../server/crypto";
import type {CapabilityBundle} from "../src/capabilities/types";
import type {ServerConfig} from "../server/config";
import {maskFixtures} from "./masked-fixtures";
import {fileSha256} from "../server/masked-media";

describe.skipIf(!process.env.TEST_DATABASE_URL)("source-linked masked edit admission and durable execution",()=>{
  const schema=`cf_mask_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173",password="Fixture-password-28-long!";
  let root:Pool,pool:Pool,app:Awaited<ReturnType<typeof buildServer>>,config:ServerConfig,catalogue:CapabilityBundle[],bundle:CapabilityBundle,trackingBundle:CapabilityBundle,sam31Bundle:CapabilityBundle,depthBundle:CapabilityBundle;
  let workspaceId:string,projectId:string,workerId:string,cookie:string,viewer:string,foreign:string,source:any,mask:any,f:Awaited<ReturnType<typeof maskFixtures>>,worker:Server,posts=0,uploads=0,output:Buffer;
  const queue=new Map<string,any>(),history:Record<string,any>={};
  const workerOutputs=new Map<string,Buffer>();
  beforeEach(async()=>{
    // This suite keeps one local fixture worker for many FFmpeg cases. Refresh
    // its admission receipt per case rather than letting a busy full run age
    // the original receipt past the production five-minute freshness limit.
    expect(worker.listening).toBe(true);
    await pool.query("UPDATE workers SET checked_at=now() WHERE id=$1",[workerId]);
  });
  const url=(tail:string)=>`/api/v1/workspaces/${workspaceId}/${tail}`;
  async function api(method:"GET"|"POST",tail:string,payload?:any,auth=cookie){return app.app.inject({method,url:url(tail),headers:{origin,cookie:auth},payload});}
  async function upload(tail:string,file:string,auth=cookie){
    const boundary=`mask${randomUUID()}`,payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.mp4"\r\nContent-Type: video/mp4\r\n\r\n`),await readFile(file),Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return app.app.inject({method:"POST",url:url(tail),headers:{origin,cookie:auth,"content-type":`multipart/form-data; boundary=${boundary}`},payload});
  }
  async function login(email:string){const response=await app.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email,password}});expect(response.statusCode,response.body).toBe(200);return String(response.headers["set-cookie"]).split(";")[0];}
  function invocation(extra:Record<string,unknown>={}){return {projectId,workerId,idempotencyKey:randomUUID(),capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:source.id,edit_mask:mask.id},controls:{prompt:"A blue vase",seed:543,strength:1},audioPolicy:"mute",...extra};}
  function trackingInvocation(extra:Record<string,unknown>={}){return {projectId,workerId,idempotencyKey:randomUUID(),capabilityId:trackingBundle.manifest.id,version:trackingBundle.manifest.version,routeId:"local",inputs:{source_video:source.id},controls:{},audioPolicy:"mute",tracking:{frameIndex:0,objectIndex:1,points:[{x:48,y:32,kind:"include"},{x:8,y:8,kind:"exclude"}]},...extra};}
  async function enqueue(extra:Record<string,unknown>={}){const r=await api("POST","runs",invocation(extra));expect(r.statusCode,r.body).toBe(200);return r.json();}
  async function enqueueTracking(extra:Record<string,unknown>={}){const r=await api("POST","runs",trackingInvocation(extra));expect(r.statusCode,r.body).toBe(200);return r.json();}
  async function run(id:string){return(await api("GET",`runs/${id}`)).json();}
  function complete(remoteId:string,bytes=output){
    const tuple=queue.get(remoteId),graph=tuple?.[2] as Record<string,{class_type?:string}>;
    const outputs=Object.fromEntries(Object.entries(graph).filter(([,node])=>node.class_type==="SaveVideo").map(([node])=>{
      const filename=`${remoteId}-${node}.mp4`;workerOutputs.set(filename,bytes);
      return [node,{images:[{filename,subfolder:"",type:"output"}]}];
    }));
    history[remoteId]={prompt:tuple,outputs,status:{completed:true,status_str:"success",messages:[]}};queue.delete(remoteId);
  }
  beforeAll(async()=>{
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    config={databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot:await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/mask-test-"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false};
    workspaceId=(await bootstrap(pool,"mask@example.test",password,"Mask QA")).workspaceId;
    const foreignId=randomUUID(),foreignWs=randomUUID();
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",[foreignId,"foreign-mask@example.test",await hashPassword(password)]);
    await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Other workspace')",[foreignWs]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[foreignWs,foreignId]);
    const viewerId=randomUUID();await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",[viewerId,"viewer-mask@example.test",await hashPassword(password)]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[workspaceId,viewerId]);
    catalogue=await loadServerCatalogue();bundle=catalogue.find(b=>b.manifest.id==="wan21-vace-masked-edit")!;trackingBundle=catalogue.find(b=>b.manifest.id==="sam21-video-mask")!;sam31Bundle=catalogue.find(b=>b.manifest.id==="sam31-video-mask")!;
    depthBundle=catalogue.find(b=>b.manifest.id==="vace-depth-restyle")!;
    bundle.manifest.routes[0].implementation="implemented";bundle.manifest.coverage.local="implemented";
    trackingBundle.manifest.routes[0].implementation="implemented";trackingBundle.manifest.coverage.local="implemented";
    sam31Bundle.manifest.routes[0].implementation="implemented";sam31Bundle.manifest.coverage.local="implemented";
    app=await buildServer(config,pool,{catalogue});await app.app.ready();cookie=await login("mask@example.test");viewer=await login("viewer-mask@example.test");foreign=await login("foreign-mask@example.test");
    projectId=(await api("POST","projects",{name:"Mask QA"})).json().id;f=await maskFixtures();output=await readFile(f.source);
    worker=createServer(async(req,res)=>{
      const chunks:Buffer[]=[];await new Promise<void>((resolve,reject)=>{const events=req as EventEmitter;events.on("data",c=>chunks.push(c));events.on("end",resolve);events.on("error",reject);});
      const body=Buffer.concat(chunks),path=new URL(req.url!,"http://test").pathname;res.setHeader("content-type","application/json");
      if(path==="/api/upload/image"){uploads++;res.end(JSON.stringify({name:/filename="([^"]+)"/.exec(body.toString())?.[1],subfolder:""}));return;}
      if(path==="/api/prompt"){const input=JSON.parse(body.toString()),id=randomUUID();posts++;queue.set(id,[posts,id,input.prompt,input.extra_data,["21"]]);res.end(JSON.stringify({prompt_id:id}));return;}
      if(path==="/api/queue"){res.end(JSON.stringify({queue_running:[],queue_pending:[...queue.values()]}));return;}
      if(path.startsWith("/api/history")){const id=path.split("/")[3];res.end(JSON.stringify(id?(history[id]?{[id]:history[id]}:{}):history));return;}
      if(path==="/api/view"){const filename=new URL(req.url!,"http://test").searchParams.get("filename")??"";res.setHeader("content-type","video/mp4");res.end(workerOutputs.get(filename)??output);return;}
      res.writeHead(404).end("{}");
    });
    await new Promise<void>(resolve=>worker.listen(0,"127.0.0.1",resolve));
    workerId=(await api("POST","workers",{name:"Mask QA worker",origin:`http://127.0.0.1:${(worker.address() as {port:number}).port}`,apiPrefix:"/api"})).json().id;
    const requirements=[...bundle.manifest.routes[0].requirements,...trackingBundle.manifest.routes[0].requirements,...sam31Bundle.manifest.routes[0].requirements,...depthBundle.manifest.routes[0].requirements,...catalogue.find(b=>b.manifest.id==="sam31-video-point-mask")!.manifest.routes[0].requirements];
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:[...new Set(requirements.filter(r=>r.kind==="node").map(r=>r.name))],models:[...new Set(requirements.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`))],credentials:[]}),workerId]);
  },30000);
  afterAll(async()=>{await app?.execution.close();await app?.app.close();worker?.closeAllConnections();if(worker)await new Promise<void>(resolve=>worker.close(()=>resolve()));await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}});
  it("creates a server-validated semantic mask linked to its exact source",async()=>{
    const s=await upload(`assets?projectId=${projectId}`,f.source);expect(s.statusCode,s.body).toBe(200);source=s.json();
    const m=await upload(`assets/${source.id}/mask-sequence`,f.mask);expect(m.statusCode,m.body).toBe(200);mask=m.json();
    expect(mask).toMatchObject({media_type:"mask",content_type:"video/mp4",project_id:projectId,parent_id:source.id});
    expect(mask.metadata.maskSequence).toMatchObject({sourceAssetId:source.id,sourceSha256:source.sha256,maskSha256:mask.sha256,frames:17});
  });
  it("saves reviewed manual frame corrections once without mutating the original or queueing inference",async()=>{
    const beforePosts=posts,beforeUploads=uploads,body={requestId:randomUUID(),expectedSha256:mask.sha256,patches:[{start:1,end:2,x:0,y:0,width:8,height:8,mode:"add"},{start:2,end:2,x:32,y:16,width:8,height:8,mode:"subtract"}]};
    const target=`assets/${mask.id}/mask-corrections`;
    expect((await api("POST",target,body,viewer)).statusCode).toBe(403);expect((await api("POST",target,body,foreign)).statusCode).toBe(403);
    expect((await api("POST",target,{...body,expectedSha256:"0".repeat(64)})).statusCode).toBe(409);
    expect((await api("POST",target,{...body,patches:[{...body.patches[0],end:17}]})).statusCode).toBe(422);
    const saved=await api("POST",target,body);expect(saved.statusCode,saved.body).toBe(200);const corrected=saved.json();
    expect(corrected).toMatchObject({id:body.requestId,parent_id:source.id,media_type:"mask"});expect(corrected.metadata.sourceLinkedMask).toBeUndefined();
    expect(corrected.metadata.maskCorrection).toMatchObject({sourceMaskId:mask.id,sourceMaskSha256:mask.sha256,patches:body.patches});
    expect(corrected.metadata.maskCoverage.frames.slice(0,4).map((f:any)=>f.selectedPixels)).toEqual([4096,4160,4096,4096]);
    expect((await api("POST",target,body)).json()).toEqual(corrected);
    expect((await api("POST",target,{...body,patches:[{...body.patches[0],end:3}]})).statusCode).toBe(409);
    expect((await api("GET",`assets/${mask.id}`)).json().sha256).toBe(mask.sha256);expect(posts).toBe(beforePosts);expect(uploads).toBe(beforeUploads);
    const admitted=await api("POST","runs",invocation({inputs:{source_video:source.id,edit_mask:corrected.id}}));expect(admitted.statusCode,admitted.body).toBe(200);await api("POST",`runs/${admitted.json().id}/cancel`);
  });
  it("admits a SAM 3.1 text prompt as server-owned tracking intent",async()=>{
    const request={projectId,workerId,idempotencyKey:randomUUID(),capabilityId:sam31Bundle.manifest.id,version:sam31Bundle.manifest.version,routeId:"local",inputs:{source_video:source.id},controls:{threshold:0.35},audioPolicy:"mute",tracking:{prompt:"jacket"}};
    const created=await api("POST","runs",request);expect(created.statusCode,created.body).toBe(200);
    await app.execution.tick();
    const queued=await run(created.json().id);expect(queued.state).toBe("queued");
    const graph=(await api("GET",`runs/${queued.id}/workflow`)).json().graph;
    expect(graph["4"].inputs.text).toBe("jacket");
    expect(graph["5"].inputs.detection_threshold).toBe(0.35);
    expect(queued.invocation.trackingSnapshot).toMatchObject({trackingMode:"prompt",prompt:"jacket",sourceAssetId:source.id});
    expect(queued.invocation.trackingSnapshot.points).toBeUndefined();
    expect((await api("POST","runs",{...request,idempotencyKey:randomUUID(),controls:{prompt:"other"}})).statusCode).toBe(400);
    expect((await api("POST","runs",{...request,idempotencyKey:randomUUID(),tracking:{prompt:"jacket",points:[]}})).statusCode).toBe(400);
    expect((await api("POST","runs",{...request,idempotencyKey:randomUUID(),tracking:{frameIndex:0,objectIndex:1,points:[{x:10,y:10,kind:"include"}]}})).statusCode).toBe(400);
    await api("POST",`runs/${queued.id}/cancel`);
  });
  it("freezes both mask admissions, deduplicates repeated assets and publishes one combined artifact",async()=>{
    const dual=catalogue.find(b=>b.manifest.id==="wan21-vace-two-region-edit")!,route=dual.manifest.routes[0],previous=route.implementation;route.implementation="implemented";
    try{
      const request=invocation({capabilityId:dual.manifest.id,version:dual.manifest.version,inputs:{source_video:source.id,edit_mask:mask.id,edit_mask_2:mask.id},controls:{prompt:"blue jacket",prompt_2:"yellow background"}});
      const response=await api("POST","runs",request);expect(response.statusCode,response.body).toBe(200);expect((await api("POST","runs",request)).json().id).toBe(response.json().id);
      const before=uploads;await app.execution.tick();const queued=await run(response.json().id);expect(queued.state).toBe("queued");expect(uploads-before).toBe(2);
      expect(queued.invocation.additionalMaskSnapshots.edit_mask_2.media).toEqual(queued.invocation.mediaSnapshot);
      const graph=(await api("GET",`runs/${queued.id}/workflow`)).json().graph;expect(graph["6"].inputs.file).toBe(graph["30"].inputs.file);expect(graph["10"].inputs.text).toBe("blue jacket");expect(graph["36"].inputs.text).toBe("yellow background");
      complete(queued.remote_id);await app.execution.tick();const done=await run(queued.id);expect(done.state).toBe("succeeded");expect(done.output_ids).toHaveLength(1);await app.execution.tick();expect((await run(done.id)).output_ids).toEqual(done.output_ids);
      expect((await api("GET",`runs/${done.id}/provenance`)).json().invocation.additionalMaskSnapshots.edit_mask_2.media.sourceSha256).toBe(source.sha256);
      expect((await api("POST","runs",{...request,idempotencyKey:randomUUID(),additionalMaskSnapshots:{}})).statusCode).toBe(400);
      expect((await api("POST","runs",{...request,idempotencyKey:randomUUID(),controls:{prompt:"blue jacket",prompt_2:""}})).statusCode).toBe(422);
    }finally{route.implementation=previous;}
  });
  it("rejects a wrong-source second mask and changed second-mask bytes before uploads",async()=>{
    const dual=catalogue.find(b=>b.manifest.id==="wan21-vace-two-region-edit")!,route=dual.manifest.routes[0],previous=route.implementation;route.implementation="implemented";
    const second=(await upload(`assets/${source.id}/mask-sequence`,f.mask)).json(),otherSource=(await upload(`assets?projectId=${projectId}`,f.source)).json(),wrongSourceMask=(await upload(`assets/${otherSource.id}/mask-sequence`,f.mask)).json();
    const request=invocation({capabilityId:dual.manifest.id,version:dual.manifest.version,inputs:{source_video:source.id,edit_mask:mask.id,edit_mask_2:second.id},controls:{prompt:"blue jacket",prompt_2:"yellow backdrop"}});
    const key=(await pool.query("SELECT storage_key FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,second.id])).rows[0].storage_key,filename=await app.store.file(workspaceId,key),original=await readFile(filename);
    try{
      expect((await api("POST","runs",{...request,inputs:{...request.inputs,edit_mask_2:wrongSourceMask.id}})).statusCode).toBe(422);
      expect((await api("POST","runs",{...request,inputs:{...request.inputs,edit_mask_2:source.id}})).statusCode).toBe(400);
      const accepted=await api("POST","runs",request);expect(accepted.statusCode,accepted.body).toBe(200);await writeFile(filename,"changed second mask");const before={posts,uploads};await app.execution.tick();const failed=await run(accepted.json().id);expect(failed.state).toBe("failed");expect(failed.error).toContain("changed before execution");expect({posts,uploads}).toEqual(before);await app.execution.tick();expect({posts,uploads}).toEqual(before);
    }finally{await writeFile(filename,original);route.implementation=previous;}
  });
  it("tracks SAM 3.1 points once, pins canonical coordinates and requires mask review",async()=>{
    const points=catalogue.find(b=>b.manifest.id==="sam31-video-point-mask")!;
    const request=trackingInvocation({capabilityId:points.manifest.id,version:points.manifest.version});
    const first=await api("POST","runs",request);expect(first.statusCode,first.body).toBe(200);
    const duplicate=await api("POST","runs",request);expect(duplicate.json().id).toBe(first.json().id);
    await app.execution.tick();const queued=await run(first.json().id);expect(queued.state).toBe("queued");
    const graph=(await api("GET",`runs/${queued.id}/workflow`)).json().graph;
    expect(graph["10"].inputs).toMatchObject({positive_coords:'[{"x":48,"y":32}]',negative_coords:'[{"x":8,"y":8}]'});
    expect(graph["5"].inputs.initial_mask).toEqual(["10",0]);
    expect(queued.invocation.trackingSnapshot).toMatchObject({trackingMode:"points",sourceAssetId:source.id,points:request.tracking.points});
    for(const tracking of [{prompt:"jacket"},{frameIndex:1,objectIndex:1,points:request.tracking.points}])expect((await api("POST","runs",{...request,idempotencyKey:randomUUID(),tracking})).statusCode).toBe(400);
    expect((await api("POST","runs",{...request,idempotencyKey:randomUUID(),tracking:{frameIndex:0,objectIndex:1,points:[{x:9999,y:9999,kind:"include"}]}})).statusCode).toBe(400);
    complete(queued.remote_id,await readFile(f.mask));await app.execution.tick();
    const finished=await run(queued.id);expect(finished.state).toBe("succeeded");
    const tracked=(await api("GET",`assets/${finished.output_ids[0]}`)).json();
    expect(tracked.metadata).toMatchObject({maskReview:{state:"pending"},sourceLinkedMask:{workflowId:points.manifest.id,requiredCheckpoint:"sam3.1_multiplex_fp16.safetensors",sourceAssetId:source.id}});
    expect(tracked.metadata.maskCoverage).toMatchObject({version:1,maskSha256:tracked.sha256,width:160,height:96});expect(tracked.metadata.maskCoverage.frames).toHaveLength(17);expect(tracked.metadata.maskCoverage.frames[0]).toEqual({selectedPixels:4096,bounds:{left:32,top:16,width:64,height:64}});
    expect((await api("POST","runs",invocation({inputs:{source_video:source.id,edit_mask:tracked.id}}))).statusCode).toBe(422);
    const review=await api("POST",`assets/${tracked.id}/mask-review`,{decision:"approve",expectedSha256:tracked.sha256});expect(review.statusCode,review.body).toBe(200);
    expect((await api("GET",`assets/${tracked.id}`)).json().metadata.maskCoverage).toEqual(tracked.metadata.maskCoverage);
    const approved=await api("POST","runs",invocation({inputs:{source_video:source.id,edit_mask:tracked.id}}));expect(approved.statusCode,approved.body).toBe(200);
    await api("POST",`runs/${approved.json().id}/cancel`);
  });
  it("requires independent second-region approval and freezes its exact review",async()=>{
    const dual=catalogue.find(b=>b.manifest.id==="wan21-vace-two-region-edit")!,route=dual.manifest.routes[0],previous=route.implementation;route.implementation="implemented";
    let restore:{id:string;metadata:any}|undefined;
    try{
      const track=await enqueueTracking();await app.execution.tick();const queued=await run(track.id);complete(queued.remote_id,await readFile(f.mask));await app.execution.tick();const tracked=(await run(track.id)).output_ids[0],pending=(await api("GET",`assets/${tracked}`)).json();
      const request=invocation({capabilityId:dual.manifest.id,version:dual.manifest.version,inputs:{source_video:source.id,edit_mask:mask.id,edit_mask_2:tracked},controls:{prompt:"blue jacket",prompt_2:"yellow backdrop"}});
      expect((await api("POST","runs",request)).statusCode).toBe(422);const review=await api("POST",`assets/${tracked}/mask-review`,{decision:"approve",expectedSha256:pending.sha256});expect(review.statusCode,review.body).toBe(200);
      const accepted=await api("POST","runs",request);expect(accepted.statusCode,accepted.body).toBe(200);const detail=await run(accepted.json().id);expect(detail.invocation.additionalMaskSnapshots.edit_mask_2.review).toMatchObject({maskAssetId:tracked,sourceAssetId:source.id,decision:"approved"});
      restore={id:tracked,metadata:(await pool.query("SELECT metadata FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,tracked])).rows[0].metadata};await pool.query("UPDATE assets SET metadata=jsonb_set(metadata,'{maskReview,state}','\"rejected\"') WHERE workspace_id=$1 AND id=$2",[workspaceId,tracked]);
      const before={posts,uploads};await app.execution.tick();const failed=await run(accepted.json().id);expect(failed.state).toBe("failed");expect(failed.error).toContain("approval changed");expect({posts,uploads}).toEqual(before);
    }finally{if(restore)await pool.query("UPDATE assets SET metadata=$3 WHERE workspace_id=$1 AND id=$2",[workspaceId,restore.id,JSON.stringify(restore.metadata)]);route.implementation=previous;}
  });
  it("requires explicit review of a source-linked background mask before masked editing",async()=>{
    const background=catalogue.find(item=>item.manifest.id==="sam31-video-background-mask")!;
    const request={projectId,workerId,idempotencyKey:randomUUID(),capabilityId:background.manifest.id,version:background.manifest.version,routeId:"local",inputs:{source_video:source.id},controls:{threshold:.35},audioPolicy:"mute",tracking:{prompt:"the foreground person"}};
    const accepted=await api("POST","runs",request);expect(accepted.statusCode,accepted.body).toBe(200);
    expect((await api("POST","runs",request)).json().id).toBe(accepted.json().id);
    await app.execution.tick();const queued=await run(accepted.json().id);
    const graph=(await api("GET",`runs/${queued.id}/workflow`)).json().graph;
    expect(graph["10"]).toEqual({class_type:"InvertMask",inputs:{mask:["6",0]}});
    complete(queued.remote_id,await readFile(f.mask));await app.execution.tick();
    const done=await run(queued.id);expect(done.state).toBe("succeeded");
    const result=(await api("GET",`assets/${done.output_ids[0]}`)).json();
    expect(result.metadata.sourceLinkedMask.workflowId).toBe(background.manifest.id);
    expect(result.metadata.maskReview.state).toBe("pending");
    const edit=invocation({inputs:{source_video:source.id,edit_mask:result.id}});
    expect((await api("POST","runs",edit)).statusCode).toBe(422);
    expect((await api("POST",`assets/${result.id}/mask-review`,{decision:"approve",expectedSha256:result.sha256})).statusCode).toBe(200);
    const edited=await api("POST","runs",edit);expect(edited.statusCode,edited.body).toBe(200);
    await api("POST",`runs/${edited.json().id}/cancel`);
  });
  it("fails lost-subject background output permanently without publishing a mask or resubmitting",async()=>{
    const background=catalogue.find(item=>item.manifest.id==="sam31-video-background-mask")!;
    const accepted=await api("POST","runs",{projectId,workerId,idempotencyKey:randomUUID(),capabilityId:background.manifest.id,version:background.manifest.version,routeId:"local",inputs:{source_video:source.id},controls:{threshold:.35},audioPolicy:"mute",tracking:{prompt:"person"}});
    expect(accepted.statusCode,accepted.body).toBe(200);await app.execution.tick();const queued=await run(accepted.json().id);
    const white=await f.make("background-lost-subject","color=c=white:s=160x96:r=16");
    complete(queued.remote_id,await readFile(white));await app.execution.tick();
    const failed=await run(queued.id);expect(failed.state).toBe("failed");expect(failed.output_ids).toEqual([]);expect(failed.error).toMatch(/No protected subject/);
    const submitted=posts;await app.execution.tick();expect(posts).toBe(submitted);expect((await run(queued.id)).state).toBe("failed");
  });
  it("normalizes ordinary 30 FPS camera footage and runs it against the 16 FPS envelope",async()=>{
    const cameraSource=await f.make("camera-30-source","testsrc2=s=160x96:r=30",30);
    const cameraMask=await f.make("camera-30-mask","color=c=black:s=160x96:r=30,drawbox=x=32:y=16:w=64:h=64:color=white:t=fill",30);
    const sourceResponse=await upload(`assets?projectId=${projectId}`,cameraSource);expect(sourceResponse.statusCode,sourceResponse.body).toBe(200);
    const cameraAsset=sourceResponse.json();
    const maskResponse=await upload(`assets/${cameraAsset.id}/mask-sequence`,cameraMask);expect(maskResponse.statusCode,maskResponse.body).toBe(200);
    const normalizedMask=maskResponse.json();
    expect(normalizedMask.metadata.maskSequence).toMatchObject({sourceAssetId:cameraAsset.id,sourceSha256:cameraAsset.sha256,maskSha256:normalizedMask.sha256,width:160,height:96,fps:16,frames:17});
    expect(normalizedMask.metadata.maskNormalization).toMatchObject({contract:"mask_normalization_v1",originalSourceAssetId:cameraAsset.id,originalSourceSha256:cameraAsset.sha256,originalMaskSha256:await fileSha256(cameraMask),normalizedMaskAssetId:normalizedMask.id,normalizedMaskSha256:normalizedMask.sha256,width:160,height:96,fps:16,frames:17});
    const normalizedSource=(await api("GET",`assets/${normalizedMask.metadata.maskNormalization.normalizedSourceAssetId}`)).json();
    expect(normalizedSource).toMatchObject({media_type:"video",parent_id:cameraAsset.id,project_id:projectId,sha256:normalizedMask.metadata.maskNormalization.normalizedSourceSha256});
    const beforeAdmissionPosts=posts,beforeAdmissionUploads=uploads;
    const queued=await api("POST","runs",invocation({inputs:{source_video:cameraAsset.id,edit_mask:normalizedMask.id}}));expect(queued.statusCode,queued.body).toBe(200);
    // Admission must not start an overlay render for a crop that these masks cannot use.
    expect(posts).toBe(beforeAdmissionPosts);expect(uploads).toBe(beforeAdmissionUploads);
    await app.execution.tick();
    const submitted=await run(queued.json().id);expect(submitted.state).toBe("queued");
    complete(submitted.remote_id);
    await app.execution.tick();
    const done=await run(queued.json().id);expect(done.state).toBe("succeeded");
    const provenance=(await api("GET",`runs/${done.id}/provenance`)).json();
    expect(provenance.invocation.mediaSnapshot).toMatchObject({sourceAssetId:normalizedSource.id,sourceSha256:normalizedSource.sha256,maskSha256:normalizedMask.sha256,width:160,height:96,frames:17,fps:16});
    expect(provenance.invocation.maskNormalization).toMatchObject({originalSourceAssetId:cameraAsset.id,normalizedSourceAssetId:normalizedSource.id});
    expect(provenance.invocation.inputs).toMatchObject({source_video:normalizedSource.id,edit_mask:normalizedMask.id});
    expect(provenance.inputs.map((asset:any)=>asset.id)).toContain(normalizedSource.id);
    expect(provenance.inputs.map((asset:any)=>asset.id)).not.toContain(cameraAsset.id);
    const artifact=(await api("GET",`assets/${done.output_ids[0]}`)).json();expect(artifact.metadata).toMatchObject({frames:17,width:160,height:96,hasAudio:false});
    const correction=await api("POST",`assets/${normalizedMask.id}/mask-corrections`,{requestId:randomUUID(),expectedSha256:normalizedMask.sha256,patches:[{start:1,end:1,x:1,y:3,width:7,height:5,mode:"add"}]});expect(correction.statusCode,correction.body).toBe(200);
    const edited=correction.json();expect(edited.metadata.maskCoverage.frames[1].selectedPixels).toBe(4096+35);
    expect(edited.metadata.maskNormalization).toMatchObject({originalSourceAssetId:cameraAsset.id,normalizedSourceAssetId:normalizedSource.id,normalizedMaskAssetId:edited.id,normalizedMaskSha256:edited.sha256});
    const correctedRun=await api("POST","runs",invocation({inputs:{source_video:cameraAsset.id,edit_mask:edited.id}}));expect(correctedRun.statusCode,correctedRun.body).toBe(200);await api("POST",`runs/${correctedRun.json().id}/cancel`);
  },180000);
  it("shares byte-identical normalized sources while preserving both original mask receipts",async()=>{
    const first=(await pool.query("SELECT id,metadata FROM assets WHERE workspace_id=$1 AND project_id=$2 AND media_type='mask' AND metadata ? 'maskNormalization' ORDER BY created_at DESC LIMIT 1",[workspaceId,projectId])).rows[0],original=first.metadata.maskNormalization.originalSourceAssetId;
    const secondResponse=await upload(`assets/${original}/mask-sequence`,`${f.dir}/camera-30-mask.mp4`);expect(secondResponse.statusCode,secondResponse.body).toBe(200);const second=secondResponse.json();expect(second.metadata.maskNormalization.normalizedSourceAssetId).not.toBe(first.metadata.maskNormalization.normalizedSourceAssetId);
    const dual=catalogue.find(b=>b.manifest.id==="wan21-vace-two-region-edit")!,route=dual.manifest.routes[0],previous=route.implementation;route.implementation="implemented";
    try{const accepted=await api("POST","runs",invocation({capabilityId:dual.manifest.id,version:dual.manifest.version,inputs:{source_video:original,edit_mask:first.id,edit_mask_2:second.id},controls:{prompt:"blue jacket",prompt_2:"yellow backdrop"}}));expect(accepted.statusCode,accepted.body).toBe(200);
      const detail=await run(accepted.json().id),snapshot=detail.invocation.additionalMaskSnapshots.edit_mask_2;expect(snapshot.media.sourceAssetId).toBe(detail.invocation.mediaSnapshot.sourceAssetId);expect(snapshot.normalization.normalizedSourceAssetId).toBe(second.metadata.maskNormalization.normalizedSourceAssetId);expect(snapshot.normalization.originalSourceAssetId).toBe(original);
      await app.execution.tick();const queued=await run(detail.id);expect(queued.state).toBe("queued");complete(queued.remote_id);await app.execution.tick();expect((await run(detail.id)).state).toBe("succeeded");
    }finally{route.implementation=previous;}
  });
  it("enforces roles and rejects generic-video masks, forged metadata and source mismatch",async()=>{
    expect((await upload(`assets/${source.id}/mask-sequence`,f.mask,viewer)).statusCode).toBe(403);
    expect((await upload(`assets/${source.id}/mask-sequence`,f.mask,foreign)).statusCode).toBe(403);
    expect((await upload(`assets/${randomUUID()}/mask-sequence`,f.mask)).statusCode).toBe(404);
    expect((await upload("assets?kind=mask",f.mask)).statusCode).toBe(400);
    expect((await upload("assets?metadata=forged",f.mask)).statusCode).toBe(400);
    const ordinary=(await upload(`assets?projectId=${projectId}`,f.mask)).json();
    expect((await api("POST","runs",invocation({inputs:{source_video:source.id,edit_mask:ordinary.id}}))).statusCode).toBe(400);
    const other=(await upload(`assets?projectId=${projectId}`,f.source)).json();
    expect((await api("POST","runs",invocation({inputs:{source_video:other.id,edit_mask:mask.id}}))).statusCode).toBe(422);
    expect((await api("POST","runs",invocation({mediaSnapshot:mask.metadata.maskSequence}))).statusCode).toBe(400);
    expect((await api("POST","runs",invocation({controls:{width:832}}))).statusCode).toBe(400);
  });
  it("deduplicates, pins parameters, recovers after restart and publishes only matching outputs",async()=>{
    const request=invocation(),a=await api("POST","runs",request),b=await api("POST","runs",request);expect(a.statusCode,a.body).toBe(200);expect(b.json().id).toBe(a.json().id);
    await app.execution.tick();const queued=await run(a.json().id);expect(queued.state).toBe("queued");const count=posts;
    const graph=(await api("GET",`runs/${queued.id}/workflow`)).json().graph;expect(graph["15"].inputs.control_masks).toEqual(["8",0]);expect(graph["17"].inputs.seed).toBe(543);
    complete(queued.remote_id);
    await app.execution.close();await app.app.close();app=await buildServer(config,pool,{catalogue});await app.app.ready();await app.execution.tick();
    const done=await run(queued.id);expect(done.state).toBe("succeeded");expect(posts).toBe(count);
    const artifact=(await api("GET",`assets/${done.output_ids[0]}`)).json();expect(artifact.metadata).toMatchObject({frames:17,width:160,height:96,hasAudio:false});
    const provenance=(await api("GET",`runs/${done.id}/provenance`)).json();expect(provenance.invocation.mediaSnapshot).toEqual(mask.metadata.maskSequence);expect(provenance.modelRequirements).toHaveLength(3);expect(provenance.inputs.map((a:any)=>a.sha256)).toContain(source.sha256);expect(JSON.stringify(provenance)).not.toContain(config.storageRoot);
  });
  it("treats a deterministic corrupt output as terminal instead of retrying it",async()=>{
    const queued=await enqueue();await app.execution.tick();const submitted=await run(queued.id);
    const wrong=await f.make("wrong-output","color=c=blue:s=160x96:r=16",21);complete(submitted.remote_id,await readFile(wrong));
    await app.execution.tick();const failed=await run(queued.id);expect(failed.state).toBe("failed");expect(failed.output_ids).toHaveLength(0);
    await app.execution.tick();expect((await run(queued.id)).state).toBe("failed");
  });
  it("publishes a tracked mask as pending, refuses it in VACE, then freezes creator approval provenance",async()=>{
    const created=await enqueueTracking();await app.execution.tick();const queued=await run(created.id);
    expect(queued.state).toBe("queued");
    const graph=(await api("GET",`runs/${created.id}/workflow`)).json().graph;
    expect(graph["5"].inputs.coordinates_positive).toBe('[{"x":48,"y":32}]');
    expect(graph["5"].inputs.coordinates_negative).toBe('[{"x":8,"y":8}]');
    complete(queued.remote_id,await readFile(f.mask));await app.execution.tick();
    const done=await run(created.id);expect(done.state).toBe("succeeded");expect(done.output_ids).toHaveLength(1);
    const tracked=(await api("GET",`assets/${done.output_ids[0]}`)).json();
    expect(tracked).toMatchObject({media_type:"mask",project_id:projectId,parent_id:source.id});
    expect(tracked.metadata).toMatchObject({maskReview:{version:1,state:"pending"},sourceLinkedMask:{sourceAssetId:source.id,maskAssetId:tracked.id,producerRunId:created.id,workflowId:trackingBundle.manifest.id,routeId:"local",requiredCheckpoint:"sam2.1_hiera_tiny-fp16.safetensors"}});
    expect(tracked.metadata).not.toHaveProperty("maskSequence");
    const refused=await api("POST","runs",invocation({inputs:{source_video:source.id,edit_mask:tracked.id}}));expect(refused.statusCode,refused.body).toBe(422);
    expect((await api("POST",`assets/${tracked.id}/mask-review`,{decision:"approve",expectedSha256:tracked.sha256},viewer)).statusCode).toBe(403);
    const reviewed=await api("POST",`assets/${tracked.id}/mask-review`,{decision:"approve",expectedSha256:tracked.sha256});expect(reviewed.statusCode,reviewed.body).toBe(200);const receipt=reviewed.json();
    expect(receipt).toMatchObject({decision:"approved",maskAssetId:tracked.id,sourceAssetId:source.id,producerRunId:created.id});
    const admitted=await api("POST","runs",invocation({inputs:{source_video:source.id,edit_mask:tracked.id}}));expect(admitted.statusCode,admitted.body).toBe(200);
    const provenance=(await api("GET",`runs/${admitted.json().id}/provenance`)).json();
    expect(provenance.invocation.maskReviewSnapshot).toEqual(receipt);
    expect(provenance.invocation.mediaSnapshot).toMatchObject({sourceAssetId:source.id,maskSha256:tracked.sha256});
    await api("POST",`runs/${admitted.json().id}/cancel`);
  });
  it("keeps rejected tracked masks terminally unavailable to VACE",async()=>{
    const created=await enqueueTracking();await app.execution.tick();const queued=await run(created.id);complete(queued.remote_id,await readFile(f.mask));await app.execution.tick();
    const done=await run(created.id),tracked=(await api("GET",`assets/${done.output_ids[0]}`)).json();
    const review=await api("POST",`assets/${tracked.id}/mask-review`,{decision:"reject",expectedSha256:tracked.sha256});expect(review.statusCode,review.body).toBe(200);expect(review.json().decision).toBe("rejected");
    const refused=await api("POST","runs",invocation({inputs:{source_video:source.id,edit_mask:tracked.id}}));expect(refused.statusCode,refused.body).toBe(422);
    const stored=(await api("GET",`assets/${tracked.id}`)).json();expect(stored.metadata.maskReview.state).toBe("rejected");expect(stored.metadata).not.toHaveProperty("maskSequence");
  });
  it("does not publish a tracked mask when cancellation wins after worker completion",async()=>{
    const created=await enqueueTracking();await app.execution.tick();const queued=await run(created.id),outputAssetId=queued.invocation.outputAssetId;
    complete(queued.remote_id,await readFile(f.mask));const cancel=await api("POST",`runs/${created.id}/cancel`);expect(cancel.statusCode,cancel.body).toBe(200);
    await app.execution.tick();const canceled=await run(created.id);expect(canceled.state).toBe("canceled");expect(canceled.output_ids).toHaveLength(0);
    expect((await pool.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,outputAssetId])).rowCount).toBe(0);
  });
  it("deduplicates tracked-mask submission and publishes its deterministic artifact once",async()=>{
    const request=trackingInvocation(),first=await api("POST","runs",request),duplicate=await api("POST","runs",request);expect(first.statusCode,first.body).toBe(200);expect(duplicate.json().id).toBe(first.json().id);
    await app.execution.tick();const queued=await run(first.json().id),outputAssetId=queued.invocation.outputAssetId;complete(queued.remote_id,await readFile(f.mask));
    await app.execution.close();await app.app.close();app=await buildServer(config,pool,{catalogue});await app.app.ready();await app.execution.tick();await app.execution.tick();
    const done=await run(first.json().id);expect(done).toMatchObject({state:"succeeded",output_ids:[outputAssetId]});
    expect((await pool.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,outputAssetId])).rowCount).toBe(1);
    const provenance=(await api("GET",`runs/${done.id}/provenance`)).json();expect(provenance.outputs).toHaveLength(1);expect(provenance.outputs[0]).toMatchObject({id:outputAssetId,parent_id:source.id,media_type:"mask",metadata:{maskReview:{state:"pending"},sourceLinkedMask:{producerRunId:done.id}}});expect(JSON.stringify(provenance)).not.toContain(config.storageRoot);
  });
  it("cancels pending work and refuses missing or mutated media before remote submission",async()=>{
    const pending=await enqueue(),count=posts;await api("POST",`runs/${pending.id}/cancel`);await app.execution.tick();expect((await run(pending.id)).state).toBe("canceled");expect(posts).toBe(count);
    const created=await enqueue(),asset=(await pool.query("SELECT storage_key FROM assets WHERE id=$1",[mask.id])).rows[0],filename=`${config.storageRoot}/${asset.storage_key}`;
    const original=await readFile(filename);await writeFile(filename,"tampered");await app.execution.tick();expect((await run(created.id)).state).toBe("failed");expect(posts).toBe(count);await writeFile(filename,original);
    await unlink(filename);expect((await api("POST","runs",invocation())).statusCode).toBe(422);await writeFile(filename,original);
  });
  it("admits aligned depth, binds both videos and publishes the ordinary result once",async()=>{
    const depthResponse=await upload(`assets?projectId=${projectId}`,f.mask);expect(depthResponse.statusCode,depthResponse.body).toBe(200);const depth=depthResponse.json();
    const request={projectId,workerId,idempotencyKey:randomUUID(),capabilityId:depthBundle.manifest.id,version:depthBundle.manifest.version,routeId:"local",inputs:{source_video:source.id,depth_video:depth.id},controls:{prompt:"A cinematic scene",seed:543,strength:1},audioPolicy:"mute"};
    expect((await api("POST","runs",{...request,depthAlignmentSnapshot:{validationVersion:1}})).statusCode).toBe(400);
    const accepted=await api("POST","runs",request);expect(accepted.statusCode,accepted.body).toBe(200);expect((await api("POST","runs",request)).json().id).toBe(accepted.json().id);
    await app.execution.tick();const queued=await run(accepted.json().id);expect(queued.state).toBe("queued");expect(queued.invocation.depthAlignmentSnapshot).toMatchObject({sourceAssetId:source.id,sourceSha256:source.sha256,depthAssetId:depth.id,depthSha256:depth.sha256,fps:16,frames:17});
    const graph=(await api("GET",`runs/${queued.id}/workflow`)).json().graph;expect(graph["4"].inputs.file).toContain(source.id);expect(graph["6"].inputs.file).toContain(depth.id);expect(graph["15"].inputs.fps).toEqual(["5",2]);
    complete(queued.remote_id);await app.execution.tick();const done=await run(queued.id);expect(done.state).toBe("succeeded");expect(done.output_ids).toHaveLength(1);const before=posts;await app.execution.tick();expect(posts).toBe(before);expect((await run(queued.id)).output_ids).toEqual(done.output_ids);
    const mismatch=await f.make("depth-api-wrong-frames","color=c=gray:s=160x96:r=16",21),wrong=(await upload(`assets?projectId=${projectId}`,mismatch)).json();
    expect((await api("POST","runs",{...request,idempotencyKey:randomUUID(),inputs:{...request.inputs,depth_video:wrong.id}})).statusCode).toBe(422);
  });
  it("refuses changed depth before any upload through native and SDK submission",async()=>{
    const depth=(await upload(`assets?projectId=${projectId}`,f.mask)).json(),file=(await pool.query("SELECT storage_key FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,depth.id])).rows[0].storage_key,filename=await app.store.file(workspaceId,file),original=await readFile(filename);
    const previous={base:process.env.COMFY_SDK_BASE_URL,worker:process.env.COMFY_SDK_WORKER_ORIGIN};
    try{for(const sdk of [false,true]){
      const workerOrigin=`http://127.0.0.1:${(worker.address() as {port:number}).port}`;
      if(sdk){process.env.COMFY_SDK_BASE_URL=workerOrigin;process.env.COMFY_SDK_WORKER_ORIGIN=workerOrigin;}else delete process.env.COMFY_SDK_BASE_URL;
      const response=await api("POST","runs",{projectId,workerId,idempotencyKey:randomUUID(),capabilityId:depthBundle.manifest.id,version:depthBundle.manifest.version,routeId:"local",inputs:{source_video:source.id,depth_video:depth.id},controls:{prompt:"A cinematic scene"},audioPolicy:"mute"});expect(response.statusCode,response.body).toBe(200);
      await writeFile(filename,"changed depth");const before={posts,uploads};await app.execution.tick();const failed=await run(response.json().id);expect(failed.state).toBe("failed");expect(failed.error).toMatch(/changed since upload/);if(sdk)expect(failed.transport).toBe("sdk");expect({posts,uploads}).toEqual(before);await app.execution.tick();expect({posts,uploads}).toEqual(before);await writeFile(filename,original);
    }}finally{await writeFile(filename,original);if(previous.base===undefined)delete process.env.COMFY_SDK_BASE_URL;else process.env.COMFY_SDK_BASE_URL=previous.base;if(previous.worker===undefined)delete process.env.COMFY_SDK_WORKER_ORIGIN;else process.env.COMFY_SDK_WORKER_ORIGIN=previous.worker;}
  });
  it("rejects changed aligned inputs before native uploads, including when SDK is configured",async()=>{
    const previous={base:process.env.COMFY_SDK_BASE_URL,worker:process.env.COMFY_SDK_WORKER_ORIGIN};
    try{for(const sdk of [false,true])for(const asset of [source,mask]){
      const workerOrigin=`http://127.0.0.1:${(worker.address() as {port:number}).port}`;if(sdk){process.env.COMFY_SDK_BASE_URL=workerOrigin;process.env.COMFY_SDK_WORKER_ORIGIN=workerOrigin;}else delete process.env.COMFY_SDK_BASE_URL;
      const created=await enqueue(),key=(await pool.query("SELECT storage_key FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,asset.id])).rows[0].storage_key,filename=await app.store.file(workspaceId,key),bytes=await readFile(filename);
      try{await writeFile(filename,"changed aligned media");const before={posts,uploads};await app.execution.tick();const failed=await run(created.id);expect(failed.state).toBe("failed");expect(failed.error).toContain("changed before execution");expect(failed.transport).toBe("native");expect({posts,uploads}).toEqual(before);await app.execution.tick();expect({posts,uploads}).toEqual(before);}finally{await writeFile(filename,bytes);}
    }}finally{if(previous.base===undefined)delete process.env.COMFY_SDK_BASE_URL;else process.env.COMFY_SDK_BASE_URL=previous.base;if(previous.worker===undefined)delete process.env.COMFY_SDK_WORKER_ORIGIN;else process.env.COMFY_SDK_WORKER_ORIGIN=previous.worker;}
  });
  it("recovers source-bound active tracking and review assets without submitting another job",async()=>{
    const created=await enqueueTracking(),before=posts,tail=`assets/${source.id}/tracking-runs?capabilityId=${trackingBundle.manifest.id}`;
    const active=await api("GET",tail);expect(active.statusCode,active.body).toBe(200);expect(active.json().some((r:any)=>r.id===created.id&&r.state==="pending")).toBe(true);
    expect((await api("GET",tail,undefined,viewer)).json()).toEqual([]);expect((await api("GET",tail,undefined,foreign)).statusCode).toBe(403);
    const masks=await api("GET",`assets/${source.id}/tracked-masks`);expect(masks.statusCode,masks.body).toBe(200);expect(masks.json().some((a:any)=>a.metadata.maskReview.state==="pending")).toBe(true);expect(masks.json().every((a:any)=>a.parent_id===source.id&&!('storage_key' in a))).toBe(true);
    await pool.query("UPDATE assets SET sha256=$1 WHERE id=$2",["f".repeat(64),source.id]);
    try{expect((await api("GET",tail)).json()).toEqual([]);expect((await api("GET",`assets/${source.id}/tracked-masks`)).json()).toEqual([]);}finally{await pool.query("UPDATE assets SET sha256=$1 WHERE id=$2",[source.sha256,source.id]);}
    expect(posts).toBe(before);await api("POST",`runs/${created.id}/cancel`);expect((await api("GET",tail)).json().some((r:any)=>r.id===created.id)).toBe(false);
    expect((await api("GET",`assets/${randomUUID()}/tracked-masks`)).statusCode).toBe(404);
  });

});
