import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {WebSocketServer,type WebSocket} from "ws";
import {Pool} from "pg";
import {createServer,type Server} from "node:http";
import {EventEmitter} from "node:events";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,readFile} from "node:fs/promises";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import type {ServerConfig} from "../server/config";
import type {CapabilityBundle} from "../src/capabilities/types";
import type {HistoryEntry,RawQueueItem} from "../src/comfy/client";

const connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("durable local image execution",()=>{
  const schema=`cf_image_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,config:ServerConfig,worker:Server;
  let workspaceId:string,projectId:string,workerId:string,cookie:string,bundle:CapabilityBundle,image:Buffer;
  const accepted=new Map<string,RawQueueItem>(),history:Record<string,HistoryEntry>={};
  let posts=0,views=0,invalidImage=false,dropNext=false;
  let previewServer:WebSocketServer;
  const url=(tail:string)=>`/api/v1/workspaces/${workspaceId}/${tail}`;
  const api=(method:"GET"|"POST",tail:string,payload?:unknown)=>server.app.inject({method,url:url(tail),headers:{origin,cookie},payload:payload as any});
  const controls=()=>Object.fromEntries(bundle.manifest.controls.filter(control=>!control.disabledReason&&control.default!==undefined).map(control=>[control.id,control.default]));
  const invocation=(extra:Record<string,unknown>={})=>({projectId,workerId,idempotencyKey:randomUUID(),capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{},controls:{...controls(),prompt:"ComfyField image integration fixture",seed:424242,batch_size:2},audioPolicy:"mute",...extra});
  const run=async(id:string)=>(await api("GET",`runs/${id}`)).json();
  function complete(remoteId:string,count=2,success=true){
    const tuple=accepted.get(remoteId)!;
    const images=Array.from({length:count},(_,index)=>({filename:`fixture-${index+1}.png`,subfolder:"ComfyField",type:"output"}));
    history[remoteId]={prompt:tuple,outputs:Object.fromEntries(tuple[4].map(id=>[id,{images}])),status:{completed:true,status_str:success?"success":"error",messages:[]}};
    accepted.delete(remoteId);
  }

  beforeAll(async()=>{
    root=new Pool({connectionString});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    config={databaseUrl:connectionString!,storageRoot:await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/image-exec-"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:2*1024*1024,cookieSecure:false};
    workspaceId=(await bootstrap(pool,"image-execution@example.test","Fixture-password-long-27!","Image execution tests")).workspaceId;
    server=await buildServer(config,pool);await server.app.ready();
    const login=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"image-execution@example.test",password:"Fixture-password-long-27!"}});
    cookie=String(login.headers["set-cookie"]).split(";")[0];
    projectId=(await api("POST","projects",{name:"Image fixture"})).json().id;
    bundle=server.catalogue.find(candidate=>candidate.manifest.id==="qwen-image-21-t2i")!;
    expect(bundle.manifest.routes[0].implementation).toBe("implemented");
    image=await readFile(new URL("./assets/render-test.png",import.meta.url));
    worker=createServer(async(req,res)=>{
      const path=new URL(req.url!,"http://fixture").pathname;
      res.setHeader("Content-Type","application/json");
      if(path==="/api/prompt"){
        const data=await new Promise<string>((resolve,reject)=>{let text="";const events=req as unknown as EventEmitter;events.on("data",chunk=>{text+=chunk;});events.on("end",()=>resolve(text));events.on("error",reject);});
        const body=JSON.parse(data),id=randomUUID();posts++;
        accepted.set(id,[posts,id,body.prompt,body.extra_data,Object.keys(body.prompt).filter(key=>body.prompt[key].class_type==="SaveImageAdvanced")]);
        if(dropNext){dropNext=false;res.destroy();return;}
        res.end(JSON.stringify({prompt_id:id}));return;
      }
      if(path==="/api/queue"){res.end(JSON.stringify({queue_running:[],queue_pending:[...accepted.values()]}));return;}
      if(path.startsWith("/api/history")){const id=path.split("/")[3];res.end(JSON.stringify(id?(history[id]?{[id]:history[id]}:{}):history));return;}
      if(path==="/api/view"){views++;res.setHeader("Content-Type","image/png");res.end(invalidImage?Buffer.from("not an image"):image);return;}
      if(path.match(/^\/api\/jobs\/[^/]+\/cancel$/)){const id=path.split("/")[3];accepted.delete(id);res.end(JSON.stringify({cancelled:true}));return;}
      res.writeHead(404).end("{}");
    });
    previewServer=new WebSocketServer({server:worker,path:"/api/ws"});
    await new Promise<void>(resolve=>worker.listen(0,"127.0.0.1",resolve));
    const address=worker.address() as {port:number};
    workerId=(await api("POST","workers",{name:"Image fixture worker",origin:`http://127.0.0.1:${address.port}`,apiPrefix:"/api"})).json().id;
    const requirements=bundle.manifest.routes[0].requirements;
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:requirements.filter(item=>item.kind==="node").map(item=>item.name),models:requirements.filter(item=>item.kind==="model").map(item=>`${item.location}/${item.name}`),credentials:[],objectInfoChecked:true,checkedModelFolders:["diffusion_models","text_encoders","vae"]}),workerId]);
  },30000);

  afterAll(async()=>{await server?.execution.close();await server?.app.close();worker?.closeAllConnections();if(worker)await new Promise<void>(resolve=>worker.close(()=>resolve()));await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}});

  it("deduplicates, compiles, imports a verified batch and preserves provenance across restart",async()=>{
    const request=invocation(),[first,duplicate]=await Promise.all([api("POST","runs",request),api("POST","runs",request)]);
    expect(first.statusCode,first.body).toBe(200);expect(duplicate.statusCode,duplicate.body).toBe(200);expect(first.json().id).toBe(duplicate.json().id);
    expect((await api("POST","runs",{...request,controls:{...request.controls,prompt:"Changed intent"}})).statusCode).toBe(409);
    await Promise.all([server.execution.tick(),server.execution.tick()]);expect(posts).toBe(1);
    const queued=await run(first.json().id);expect(queued.state).toBe("queued");
    const graph=(await api("GET",`runs/${queued.id}/workflow`)).json().graph;
    expect(graph["459:452"].inputs.prompt).toBe("ComfyField image integration fixture");expect(graph["459:458"].inputs.seed).toBe(424242);
    complete(queued.remote_id);await server.execution.tick();
    const done=await run(queued.id);expect(done.state).toBe("succeeded");expect(done.output_ids).toHaveLength(2);
    const listed=(await api("GET",`runs?projectId=${projectId}`)).json().find((r:any)=>r.id===done.id);expect(listed.output_content_type).toBe("image/png");
    const assets=(await pool.query("SELECT * FROM assets WHERE id=ANY($1::uuid[]) ORDER BY name",[done.output_ids])).rows;
    const sha=createHash("sha256").update(image).digest("hex");
    expect(assets).toHaveLength(2);
    for(const asset of assets){
      expect(asset).toMatchObject({project_id:projectId,media_type:"image",content_type:"image/png",sha256:sha,parent_id:null});
      expect(asset.metadata).toMatchObject({contentType:"image/png",width:1280,height:704,hasAlpha:false,generation:{runId:done.id,capabilityId:bundle.manifest.id,seed:424242}});
      expect((await api("GET",`assets/${asset.id}/content`)).rawPayload).toEqual(image);
    }
    const provenance=(await api("GET",`runs/${done.id}/provenance`)).json();
    expect(provenance.execution).toBe("local_comfy");expect(provenance.workflowHash).toMatch(/^[a-f0-9]{64}$/);expect(provenance.outputs).toHaveLength(2);expect(JSON.stringify(provenance)).not.toContain("storage_key");expect(JSON.stringify(provenance)).not.toContain(config.storageRoot);
    await server.execution.close();await server.app.close();server=await buildServer(config,pool);await server.app.ready();
    await server.execution.tick();expect((await run(done.id)).output_ids).toEqual(done.output_ids);expect((await pool.query("SELECT count(*) FROM assets WHERE id=ANY($1::uuid[])",[done.output_ids])).rows[0].count).toBe("2");
  });

  it("fails corrupt image bytes permanently without publishing an asset",async()=>{
    const created=(await api("POST","runs",invocation())).json();await server.execution.tick();complete((await run(created.id)).remote_id);invalidImage=true;const before=(await pool.query("SELECT count(*) FROM assets")).rows[0].count;
    await server.execution.tick();const failed=await run(created.id);expect(failed.state).toBe("failed");expect(failed.error).toContain("failed validation");expect((await pool.query("SELECT count(*) FROM assets")).rows[0].count).toBe(before);
    invalidImage=false;await server.execution.tick();expect((await run(created.id)).state).toBe("failed");
  });

  it("recovers an accepted image submission after response loss and restart without resubmitting",async()=>{
    const created=(await api("POST","runs",invocation())).json(),before=posts;dropNext=true;
    await server.execution.tick();expect((await run(created.id)).state).toBe("submission_unknown");expect(posts).toBe(before+1);
    await server.execution.close();await server.app.close();server=await buildServer(config,pool);await server.app.ready();
    await server.execution.tick();const recovered=await run(created.id);expect(recovered.state).toBe("queued");expect(recovered.remote_id).toBeTruthy();expect(posts).toBe(before+1);
    complete(recovered.remote_id);await server.execution.tick();expect((await run(created.id)).state).toBe("succeeded");
  });

  it("rejects image artifacts beyond the requested batch and hard maximum before downloading",async()=>{
    for(const [batchSize,returned] of [[2,3],[4,5]] as const){
      const request=invocation({controls:{...controls(),prompt:"ComfyField image integration fixture",seed:424242,batch_size:batchSize}});
      const created=(await api("POST","runs",request)).json();await server.execution.tick();const queued=await run(created.id);
      const beforeViews=views,beforeAssets=(await pool.query("SELECT count(*) FROM assets")).rows[0].count;
      complete(queued.remote_id,returned);await server.execution.tick();const failed=await run(created.id);
      expect(failed.state).toBe("failed");expect(failed.error).toContain(`accepts at most ${batchSize}`);expect(views).toBe(beforeViews);
      expect((await pool.query("SELECT count(*) FROM assets")).rows[0].count).toBe(beforeAssets);
    }
  });

  it("reports image-specific worker completion failures",async()=>{
    const created=(await api("POST","runs",invocation())).json();await server.execution.tick();const queued=await run(created.id);
    complete(queued.remote_id,0,false);await server.execution.tick();const failed=await run(created.id);
    expect(failed.state).toBe("failed");expect(failed.error).toBe("Worker did not complete the image");
  });

  it.each(["failed","canceled"] as const)("retains a frozen real preview after %s and stops live progress",async state=>{
    const connected=new Promise<WebSocket>(resolve=>previewServer.once("connection",resolve));
    const created=(await api("POST","runs",invocation())).json();
    await server.execution.tick();
    const socket=await connected,queued=await run(created.id);
    socket.send(JSON.stringify({type:"progress",data:{prompt_id:queued.remote_id,value:12,max:20,node:"sampler"}}));
    const header=Buffer.alloc(8);header.writeUInt32BE(1,0);header.writeUInt32BE(2,4);
    socket.send(Buffer.concat([header,image]));
    await vi.waitFor(()=>expect(server.execution.developFrame(created.id)?.seq).toBe(1));
    if(state==="failed")complete(queued.remote_id,0,false);
    else expect((await api("POST",`runs/${created.id}/cancel`)).statusCode).toBe(200);
    await server.execution.tick();
    expect((await run(created.id)).state).toBe(state);
    const develop=await api("GET",`runs/${created.id}/develop`);
    expect(develop.json()).toMatchObject({active:false,preview:true,value:12,max:20,seq:1});
    const preview=await api("GET",`runs/${created.id}/preview`);
    expect(preview.statusCode).toBe(200);expect(preview.rawPayload).toEqual(image);
    expect(socket.readyState).not.toBe(1);
  });

  it("does not infer an unknown SDK outcome from native history",async()=>{
    const created=(await api("POST","runs",invocation())).json(),before=posts;
    await pool.query("UPDATE runs SET transport='sdk',state='submission_unknown',remote_id=NULL WHERE id=$1",[created.id]);
    const resolve=await api("POST",`runs/${created.id}/resolve-unknown`);
    expect(resolve.statusCode).toBe(422);
    expect(resolve.json().error).toContain("SDK submissions cannot be resolved from native");
    expect((await run(created.id)).state).toBe("submission_unknown");
    expect(posts).toBe(before);
    const resolutions=await Promise.all([
      api("POST",`runs/${created.id}/resolve-unknown`,{resolution:"mark_failed"}),
      api("POST",`runs/${created.id}/resolve-unknown`,{resolution:"mark_failed"}),
    ]);
    expect(resolutions.map(result=>result.statusCode).sort()).toEqual([200,409]);
    expect((await run(created.id)).state).toBe("failed");
    const events=(await pool.query("SELECT detail FROM run_events WHERE run_id=$1 AND state='failed'",[created.id])).rows;
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({manual:true,resolution:"not_accepted",transport:"sdk"});
  });

  it("keeps cancellation pending for an SDK submission with no recorded job id",async()=>{
    const created=(await api("POST","runs",invocation())).json(),before=posts;
    await pool.query("UPDATE runs SET transport='sdk',state='cancel_requested',remote_id=NULL WHERE id=$1",[created.id]);
    await server.execution.tick();
    const waiting=await run(created.id);
    expect(waiting.state).toBe("cancel_requested");
    expect(waiting.error).toContain("unknown SDK submission outcome");
    expect((await api("GET",`runs/${created.id}/develop`)).json().active).toBe(true);
    expect(posts).toBe(before);
    const confirmed=await api("POST",`runs/${created.id}/resolve-unknown`,{resolution:"mark_failed"});
    expect(confirmed.json()).toEqual({state:"canceled",manual:true});
    expect((await run(created.id)).state).toBe("canceled");
    expect((await api("GET",`runs/${created.id}/develop`)).json().active).toBe(false);
  });
});
