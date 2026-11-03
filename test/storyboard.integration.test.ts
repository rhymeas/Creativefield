import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {Pool} from "pg";
import {createServer,type Server} from "node:http";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,readFile,readdir} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import {hashToken} from "../server/crypto";
import {assembleVideo} from "../server/assembly";
import {buildKeyframeShots} from "../src/team/keyframe-submission";
import type {ServerConfig} from "../server/config";
import type {CapabilityBundle} from "../src/capabilities/types";
import type {RawQueueItem,HistoryEntry} from "../src/comfy/client";
import {Readable} from "node:stream";
import path from "node:path";
import sharp from "sharp";

const execute=promisify(execFile),connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("storyboard execution and real FFmpeg assembly",()=>{
  const schema=`cf_board_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,config:ServerConfig,worker:Server;
  let workspaceId:string,projectId:string,workerId:string,cookie:string,viewer:string,otherCreator:string,foreignCookie:string,foreignWs:string,bundle:CapabilityBundle;
  const accepted=new Map<string,RawQueueItem>(),history:Record<string,HistoryEntry>={},media=new Map<string,Buffer>();
  let posts=0,cancels=0,red:Buffer,blue:Buffer,scratch:string;
  const api=(method:"GET"|"POST"|"PUT",tail:string,payload?:unknown,session=cookie,workspace=workspaceId)=>server.app.inject({method,url:`/api/v1/workspaces/${workspace}/${tail}`,headers:{origin,cookie:session},payload:payload as any});
  const get=async(id:string)=>(await api("GET",`storyboard-renders/${id}`)).json();
  const generation=()=>({capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",controls:{seed:43}});
  const shot=(prompt="red",settings:any={})=>({prompt,durationSeconds:1,settings:{generation:generation(),...settings}});
  async function board(shots:any[]=[shot(),shot("blue")]){
    const made=await api("POST","storyboards",{name:"Board fixture",projectId});expect(made.statusCode,made.body).toBe(200);
    const id=made.json().id,save=await api("PUT",`storyboards/${id}/shots`,{revision:1,shots});expect(save.statusCode,save.body).toBe(200);return id;
  }
  const renderRequest=(extra:any={})=>({revision:2,workerId,idempotencyKey:randomUUID(),assembly:{width:320,height:240,fps:24,audioPolicy:"mute"},...extra});
  async function render(id:string,extra:any={}){const response=await api("POST",`storyboards/${id}/renders`,renderRequest(extra));expect(response.statusCode,response.body).toBe(200);return response.json();}
  async function finishChild(renderId:string,color:Buffer=red,success=true){
    const r=await get(renderId),child=r.shots.find((s:any)=>s.child_run_id&&!s.output_asset_id);
    const run=(await api("GET",`runs/${child.child_run_id}`)).json(),tuple=accepted.get(run.remote_id)!;expect(tuple).toBeTruthy();
    const filename=`${run.remote_id}.mp4`;media.set(filename,color);
    history[run.remote_id]={prompt:tuple,outputs:Object.fromEntries(tuple[4].map(id=>[id,{images:[{filename,subfolder:"",type:"output"}]}])),status:{completed:true,status_str:success?"success":"error",messages:[]}};
    accepted.delete(run.remote_id);await server.execution.tick();
  }
  async function restart(){await Promise.all([server.execution.close(),server.storyboards.close(),server.workerMonitor.close()]);await server.app.close();server=await buildServer(config,pool);await server.app.ready();}
  async function session(role:string,workspace=workspaceId){
    const id=randomUUID(),token=randomBytes(32).toString("hex");
    await pool.query("INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users LIMIT 1",[id,`${id}@fixture.test`]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",[workspace,id,role]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),id]);return `cf_session=${token}`;
  }
  beforeAll(async()=>{
    root=new Pool({connectionString});await root.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);await migrate(pool);
    scratch=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/storyboard-test-");
    config={databaseUrl:connectionString!,storageRoot:scratch,masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:4*1024*1024,cookieSecure:false};
    workspaceId=(await bootstrap(pool,"board@fixture.test","Fixture-password-long-27!","Storyboards")).workspaceId;
    server=await buildServer(config,pool);await server.app.ready();cookie=await session("admin");viewer=await session("viewer");otherCreator=await session("creator");
    foreignWs=randomUUID();await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Foreign')",[foreignWs]);foreignCookie=await session("admin",foreignWs);
    projectId=(await api("POST","projects",{name:"Board test"})).json().id;bundle=server.catalogue.find(b=>b.manifest.category==="t2v")!;
    await execute("ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","color=c=red:s=320x240:r=24:d=1.25","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=1.25","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest",`${scratch}/red.mp4`],{windowsHide:true});
    await execute("ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","color=c=blue:s=640x360:r=25:d=2","-c:v","libx264","-pix_fmt","yuv420p","-an",`${scratch}/blue.mp4`],{windowsHide:true});
    red=await readFile(`${scratch}/red.mp4`);blue=await readFile(`${scratch}/blue.mp4`);
    worker=createServer(async(req,res)=>{
      const u=new URL(req.url!,"http://fixture"),p=u.pathname;res.setHeader("Content-Type","application/json");
      if(p==="/api/upload/image"){
        const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
        const name=Buffer.concat(chunks).toString('latin1').match(/filename="([^"]+)"/)?.[1];
        if(!name){res.writeHead(400).end('{}');return;}res.end(JSON.stringify({name,subfolder:''}));return;
      }
      if(p==="/api/prompt"){
        let raw="";for await(const chunk of req)raw+=chunk;const b=JSON.parse(raw),id=randomUUID();posts++;
        const output=Object.entries(b.prompt).filter(([,n]:any)=>n.class_type==="SaveVideo").map(([id])=>id);
        accepted.set(id,[posts,id,b.prompt,b.extra_data,output]);res.end(JSON.stringify({prompt_id:id}));return;
      }
      if(p==="/api/queue"){res.end(JSON.stringify({queue_pending:[...accepted.values()],queue_running:[]}));return;}
      if(p.startsWith("/api/history")){const id=p.split("/")[3];res.end(JSON.stringify(id?(history[id]?{[id]:history[id]}:{}):history));return;}
      if(p==="/api/view"){res.setHeader("Content-Type","video/mp4");res.end(media.get(u.searchParams.get("filename")!)??red);return;}
      if(p.match(/^\/api\/jobs\/[^/]+\/cancel$/)){cancels++;accepted.delete(p.split("/")[3]);res.end(JSON.stringify({cancelled:true}));return;}
      res.writeHead(404).end("{}");
    });await new Promise<void>(resolve=>worker.listen(0,"127.0.0.1",resolve));
    workerId=(await api("POST","workers",{name:"Storyboard fixture",origin:`http://127.0.0.1:${(worker.address() as any).port}`,apiPrefix:"/api"})).json().id;
    const req=bundle.manifest.routes[0].requirements;
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:req.filter(r=>r.kind==="node").map(r=>r.name),models:req.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),credentials:[]}),workerId]);
  });
  afterAll(async()=>{if(server){await Promise.all([server.execution.close(),server.storyboards.close()]);await server.app.close();}await new Promise<void>(resolve=>worker?.close(()=>resolve()));await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}});
  it("pins two shots, serializes execution across restart and assembles exact ordered output",async()=>{
    const id=await board(),request=renderRequest(),count=posts;
    const duplicate=await Promise.all([api("POST",`storyboards/${id}/renders`,request),api("POST",`storyboards/${id}/renders`,request)]);
    expect(duplicate.map(r=>r.statusCode)).toEqual([200,200]);expect(duplicate[0].json().id).toBe(duplicate[1].json().id);const rid=duplicate[0].json().id;
    expect((await api("POST",`storyboards/${id}/renders`,{...request,assembly:{...request.assembly,fps:30}})).statusCode).toBe(409);
    await server.storyboards.tick();await server.execution.tick();expect(posts).toBe(count+1);
    await api("PUT",`storyboards/${id}/shots`,{revision:2,shots:[shot("EDITED")]});
    expect((await api("POST",`storyboards/${id}/renders`,request)).json().id).toBe(rid);
    await restart();await server.storyboards.tick();await server.execution.tick();expect(posts).toBe(count+1);
    await finishChild(rid);await server.storyboards.tick();await server.execution.tick();expect(posts).toBe(count+2);
    const pending=await get(rid);expect(pending.shots.map((s:any)=>s.invocation.controls.prompt)).toEqual(["red","blue"]);expect(pending.shots[1].invocation.controls.seed).toBe(43);
    await finishChild(rid,blue);await server.storyboards.tick();const result=await get(rid);expect(result.state,result.error).toBe("succeeded");
    const asset=(await pool.query("SELECT * FROM assets WHERE id=$1",[result.output_asset_id])).rows[0];expect(asset.metadata.frames).toBe(48);expect(asset.metadata.hasAudio).toBe(false);expect(asset.metadata.durationSeconds).toBeCloseTo(2,1);
    const file=await server.store.file(workspaceId,asset.storage_key);
    for(const [time,channel] of [[0.5,0],[1.5,2]]){const pixel=await execute("ffmpeg",["-v","error","-ss",String(time),"-i",file,"-frames:v","1","-vf","scale=1:1","-pix_fmt","rgb24","-f","rawvideo","pipe:1"],{encoding:"buffer",windowsHide:true});expect(pixel.stdout[channel]).toBeGreaterThan(150);}
    await restart();await server.storyboards.tick();expect((await get(rid)).output_asset_id).toBe(result.output_asset_id);expect(posts).toBe(count+2);
  },90000);
  it("admits linked first/last keyframe segments with exact assembly boundaries",async()=>{
    const model=server.catalogue.find(b=>b.manifest.id==='wan22-flf2v-14b')!;
    const workerRow=(await pool.query('SELECT inventory FROM workers WHERE id=$1',[workerId])).rows[0];
    const requirements=model.manifest.routes[0].requirements;
    try{
      await pool.query('UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2',[JSON.stringify({online:true,nodes:requirements.filter(r=>r.kind==='node').map(r=>r.name),models:requirements.filter(r=>r.kind==='model').map(r=>`${r.location}/${r.name}`),credentials:[]}),workerId]);
      const owner=(await pool.query("SELECT user_id FROM memberships WHERE workspace_id=$1 AND role='admin' LIMIT 1",[workspaceId])).rows[0].user_id;
      const image=await sharp({create:{width:320,height:240,channels:3,background:'red'}}).png().toBuffer(),ids=[] as string[];
      for(let i=0;i<4;i++){
        const saved=await server.store.put(workspaceId,Readable.from([image])),id=randomUUID();ids.push(id);
        await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,'keyframe.png','image','image/png',$4,$5,$6,$7,$8)",[id,workspaceId,projectId,saved.key,saved.sha256,saved.bytes,owner,JSON.stringify({width:320,height:240})]);
      }
      const generation={capabilityId:model.manifest.id,version:model.manifest.version,routeId:'local',controls:{}};
      const segment=(start:string,end:string,prompt:string)=>({prompt,durationSeconds:1,settings:{generation,audioPolicy:'mute'},assets:[{role:'start_image',assetId:start},{role:'end_image',assetId:end}]});
      const id=await board([segment(ids[0],ids[1],''),segment(ids[1],ids[2],'second move'),segment(ids[2],ids[3],'third move')]);
      const request=renderRequest({assembly:{width:320,height:240,fps:16,audioPolicy:'mute',keyframeBoundaries:true}});
      const response=await api('POST',`storyboards/${id}/renders`,request);expect(response.statusCode,response.body).toBe(200);
      const renderId=response.json().id,detail=await get(renderId);
      // A response may be lost after the server accepted it. Retrying the
      // identical keyframe request must recover the same render, not queue two.
      const retry=await api('POST',`storyboards/${id}/renders`,request);
      expect(retry.statusCode,retry.body).toBe(200);
      expect(retry.json().id).toBe(renderId);
      expect(detail.shots.map((s:any)=>[s.snapshot.frames,s.snapshot.assemblyStartFrame,s.invocation.controls.prompt])).toEqual([[17,0,''],[16,1,'second move'],[16,1,'third move']]);
      expect(detail.shots.map((s:any)=>[s.invocation.inputs.start_image,s.invocation.inputs.end_image])).toEqual([[ids[0],ids[1]],[ids[1],ids[2]],[ids[2],ids[3]]]);
      await server.storyboards.tick();await server.execution.tick();await finishChild(renderId,red);
      await server.storyboards.tick();await server.execution.tick();await finishChild(renderId,blue);
      await server.storyboards.tick();await server.execution.tick();await finishChild(renderId,red);
      await server.storyboards.tick();const result=await get(renderId);expect(result.state,result.error).toBe('succeeded');
      const output=(await pool.query('SELECT metadata FROM assets WHERE id=$1',[result.output_asset_id])).rows[0];expect(output.metadata.frames).toBe(49);
      const wrong=await board([segment(ids[0],ids[1],'first'),segment(ids[0],ids[2],'second')]);
      const rejected=await api('POST',`storyboards/${wrong}/renders`,renderRequest({assembly:request.assembly}));expect(rejected.statusCode).toBe(422);
    }finally{await pool.query('UPDATE workers SET inventory=$1 WHERE id=$2',[workerRow.inventory,workerId]);}
  },90000);
  it("carries four MiniMax H3 keyframes and prompts through storyboard assembly",async()=>{
    const model=server.catalogue.find(b=>b.manifest.id==='h3-flf2v')!;
    const workerRow=(await pool.query('SELECT inventory FROM workers WHERE id=$1',[workerId])).rows[0];
    const requirements=model.manifest.routes[0].requirements;
    try{
      await pool.query('UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2',[JSON.stringify({online:true,nodes:requirements.filter(r=>r.kind==='node').map(r=>r.name),models:requirements.filter(r=>r.kind==='model').map(r=>`${r.location}/${r.name}`),credentials:[]}),workerId]);
      const owner=(await pool.query("SELECT user_id FROM memberships WHERE workspace_id=$1 AND role='admin' LIMIT 1",[workspaceId])).rows[0].user_id;
      const image=await sharp({create:{width:320,height:240,channels:3,background:'red'}}).png().toBuffer(),ids:string[]=[];
      for(let i=0;i<4;i++){
        const saved=await server.store.put(workspaceId,Readable.from([image])),id=randomUUID();ids.push(id);
        await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,'keyframe.png','image','image/png',$4,$5,$6,$7,$8)",[id,workspaceId,projectId,saved.key,saved.sha256,saved.bytes,owner,JSON.stringify({width:320,height:240})]);
      }
      const frames=ids.map((assetId,i)=>({assetId,frame:[0,38,93,131][i]}));
      const planned=buildKeyframeShots(model.manifest,frames,['first move @Image 1 to @Image 2','second move','third move'],24);
      const id=await board(planned.shots),response=await api('POST',`storyboards/${id}/renders`,renderRequest({assembly:{width:320,height:240,fps:24,audioPolicy:'mute',keyframeBoundaries:true}}));
      expect(response.statusCode,response.body).toBe(200);
      const renderId=response.json().id,detail=await get(renderId);
      expect(detail.shots.map((s:any)=>[s.snapshot.frames,s.snapshot.assemblyStartFrame,s.invocation.controls.prompt])).toEqual([[39,0,'first move <Picture 1> to <Picture 2>'],[55,1,'second move'],[38,1,'third move']]);
      expect(detail.shots.map((s:any)=>[s.invocation.inputs.start_image,s.invocation.inputs.end_image])).toEqual([[ids[0],ids[1]],[ids[1],ids[2]],[ids[2],ids[3]]]);
      const clip=path.join(scratch,'h3-fixture.mp4');
      await execute('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i','color=c=red:s=320x240:r=24:d=3','-c:v','libx264','-pix_fmt','yuv420p',clip],{windowsHide:true});
      const video=await readFile(clip);
      for(let i=0;i<3;i++){await server.storyboards.tick();await server.execution.tick();await finishChild(renderId,video);}
      await server.storyboards.tick();const result=await get(renderId);expect(result.state,result.error).toBe('succeeded');
      const output=(await pool.query('SELECT metadata FROM assets WHERE id=$1',[result.output_asset_id])).rows[0];expect(output.metadata.frames).toBe(132);
    }finally{await pool.query('UPDATE workers SET inventory=$1 WHERE id=$2',[workerRow.inventory,workerId]);}
  },90000);
  it("rejects stale, unmapped, unsupported and foreign requests before creating children",async()=>{
    const count=posts,id=await board([shot("invalid",{cameraHint:"dolly"})]);expect((await api("POST",`storyboards/${id}/renders`,renderRequest())).statusCode).toBe(422);
    expect((await api("POST",`storyboards/${id}/renders`,renderRequest({revision:1}))).statusCode).toBe(409);
    expect((await api("POST",`storyboards/${id}/renders`,renderRequest(),viewer)).statusCode).toBe(403);
    expect((await api("POST",`storyboards/${id}/renders`,renderRequest(),foreignCookie,foreignWs)).statusCode).toBe(404);
    for(const settings of [{generation:undefined},{generation:{...generation(),controls:{length:4}}},{generation:{...generation(),controls:{cameraGeometry:1}}}]){
      const b=await board([shot("red",settings)]);expect((await api("POST",`storyboards/${b}/renders`,renderRequest())).statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(posts).toBe(count);
  });
  it("reserves internal child idempotency keys without blocking the storyboard",async()=>{
    const r=await render(await board([shot()])),count=posts;
    const attack=await api("POST","runs",{projectId,workerId,idempotencyKey:`storyboard:${r.id}:0`,...generation(),inputs:{},controls:{prompt:"collision",length:1},audioPolicy:"mute"});
    expect(attack.statusCode).toBe(400);
    await server.storyboards.tick();await server.execution.tick();expect(posts).toBe(count+1);
    expect((await get(r.id)).shots[0].child_run_id).toBeTruthy();
    await api("POST",`storyboard-renders/${r.id}/cancel`);await server.execution.tick();await server.storyboards.tick();expect((await get(r.id)).state).toBe("canceled");
  });
  it("assembles a fractional shot from exactly the frames requested from the model",async()=>{
    const r=await render(await board([{...shot(),durationSeconds:1.4}]));
    await server.storyboards.tick();await server.execution.tick();
    const s=(await get(r.id)).shots[0],run=(await api("GET",`runs/${s.child_run_id}`)).json(),graph=accepted.get(run.remote_id)![2];
    const binding=bundle.manifest.controls.find(c=>c.id==="length")!.binding!,frames=graph[binding.node].inputs[binding.field] as number;
    expect(s.snapshot.frames).toBe(34);expect(frames).toBe(37);expect(s.snapshot.generationFrames).toBe(frames);
    await execute("ffmpeg",["-v","error","-nostdin","-y","-f","lavfi","-i",`color=c=yellow:s=320x240:r=${s.snapshot.generationFps}`,"-frames:v",String(frames),"-c:v","libx264","-pix_fmt","yuv420p","-an",`${scratch}/fractional.mp4`],{windowsHide:true});
    await finishChild(r.id,await readFile(`${scratch}/fractional.mp4`));await server.storyboards.tick();const result=await get(r.id);expect(result.state,result.error).toBe("succeeded");
    const meta=(await pool.query("SELECT metadata FROM assets WHERE id=$1",[result.output_asset_id])).rows[0].metadata;expect(meta.frames).toBe(34);expect(meta.durationSeconds).toBeCloseTo(34/24,3);
  });
  // Native probes, encoding and frame verification use the repository's existing
  // 120-second media-test budget, including under the configured four-fork load.
  it("keeps failed tool checks distinct from missing software and does not submit generation",async()=>{
    const id=await board(),count=posts,previous=process.env.FFPROBE_PATH;
    process.env.FFPROBE_PATH=process.execPath;
    try{
      const readiness=(await api("GET","storyboard-requirements")).json();
      expect(readiness.state).toBe("check_failed");expect(readiness.missing).toEqual([]);
      expect(readiness.issues.some((issue:{tool:string})=>issue.tool==="FFprobe")).toBe(true);
      expect(readiness.instructions).not.toMatch(/install/i);
      const response=await api("POST",`storyboards/${id}/renders`,renderRequest());
      expect(response.statusCode).toBe(422);expect(response.json().error).toContain("Assembly check incomplete");
      expect(response.json().error).not.toContain("installation required");expect(posts).toBe(count);
    }finally{if(previous===undefined)delete process.env.FFPROBE_PATH;else process.env.FFPROBE_PATH=previous;}
  });
  it("reports missing finishing software before any generation",async()=>{
    const id=await board(),count=posts,previous=process.env.FFMPEG_PATH;process.env.FFMPEG_PATH="comfyfield-missing-ffmpeg";
    try{
      expect((await api("GET","storyboard-requirements")).json().state).toBe("install_required");
      const response=await api("POST",`storyboards/${id}/renders`,renderRequest());expect(response.statusCode).toBe(422);expect(response.json().error).toContain("installation required");
    }finally{if(previous===undefined)delete process.env.FFMPEG_PATH;else process.env.FFMPEG_PATH=previous;}
    expect(posts).toBe(count);expect((await api("GET","storyboard-requirements")).json().state).toBe("ready");
  });
  it("stops on failed and unknown children and respects owner cancellation",async()=>{
    const r=await render(await board()),count=posts;
    await server.storyboards.tick();await server.execution.tick();expect(posts).toBe(count+1);
    const first=(await get(r.id)).shots[0];await pool.query("UPDATE runs SET state='submission_unknown',remote_id=NULL WHERE id=$1",[first.child_run_id]);
    await server.storyboards.tick();expect((await get(r.id)).shots[1].child_run_id).toBe(null);
    await server.execution.tick();await finishChild(r.id,red,false);await server.storyboards.tick();expect((await get(r.id)).state).toBe("failed");expect(posts).toBe(count+1);
    const canceled=await render(await board());expect((await api("POST",`storyboard-renders/${canceled.id}/cancel`,undefined,otherCreator)).statusCode).toBe(403);
    expect((await api("GET",`storyboard-renders/${canceled.id}`,undefined,foreignCookie,foreignWs)).statusCode).toBe(404);
    await api("POST",`storyboard-renders/${canceled.id}/cancel`);await server.storyboards.tick();expect((await get(canceled.id)).state).toBe("canceled");expect(posts).toBe(count+1);
    const queued=await render(await board());await server.storyboards.tick();await server.execution.tick();await api("POST",`storyboard-renders/${queued.id}/cancel`);await server.execution.tick();await server.storyboards.tick();expect((await get(queued.id)).state).toBe("canceled");expect(cancels).toBeGreaterThan(0);
  });
  it("retries failed assembly without resubmitting completed generation and preserves audio",async()=>{
    const r=await render(await board(),{assembly:{width:320,height:240,fps:30,audioPolicy:"preserve"}});
    await server.storyboards.tick();await server.execution.tick();await finishChild(r.id);await server.storyboards.tick();await server.execution.tick();await finishChild(r.id,blue);const count=posts;
    const previous=process.env.FFMPEG_PATH;process.env.FFMPEG_PATH="comfyfield-missing-ffmpeg";
    try{await server.storyboards.tick();}finally{if(previous===undefined)delete process.env.FFMPEG_PATH;else process.env.FFMPEG_PATH=previous;}
    expect((await get(r.id)).state).toBe("assembly_failed");expect((await readdir(`${scratch}/.assembly`)).length).toBe(0);
    expect((await api("POST",`storyboard-renders/${r.id}/retry-assembly`,undefined,viewer)).statusCode).toBe(403);
    await api("POST",`storyboard-renders/${r.id}/retry-assembly`);await restart();await server.storyboards.tick();const result=await get(r.id);expect(result.state,result.error).toBe("succeeded");expect(posts).toBe(count);
    const meta=(await pool.query("SELECT metadata FROM assets WHERE id=$1",[result.output_asset_id])).rows[0].metadata;expect(meta.hasAudio).toBe(true);expect(meta.frames).toBe(60);expect(meta.durationSeconds).toBeCloseTo(2,1);
  });
  it("rejects short clips and aborts assembly without publishing media",async()=>{
    const {Readable}=await import("node:stream"),source=await server.store.put(workspaceId,Readable.from(red));
    await expect(assembleVideo(server.store,workspaceId,[{key:source.key,frames:240}],{width:320,height:240,fps:24,audioPolicy:"mute"},new AbortController().signal)).rejects.toThrow("shorter");
    const controller=new AbortController();controller.abort();await expect(assembleVideo(server.store,workspaceId,[{key:source.key,frames:24}],{width:320,height:240,fps:24,audioPolicy:"mute"},controller.signal)).rejects.toThrow("interrupted");
    expect(await readdir(`${scratch}/.assembly`)).toEqual([]);
  });
  it("cancels an active assembly while retaining generated shot assets",async()=>{
    const r=await render(await board());await server.storyboards.tick();await server.execution.tick();await finishChild(r.id);await server.storyboards.tick();await server.execution.tick();await finishChild(r.id,blue);
    const count=posts,tick=server.storyboards.tick();
    for(let tries=0;tries<2000;tries++){const state=(await get(r.id)).state;if(state==="assembling")break;await new Promise(resolve=>setTimeout(resolve,5));}
    expect((await get(r.id)).state).toBe("assembling");await api("POST",`storyboard-renders/${r.id}/cancel`);await tick;await server.storyboards.tick();
    const result=await get(r.id);expect(result.state).toBe("canceled");expect(result.output_asset_id).toBe(null);expect(result.shots.every((s:any)=>!!s.output_asset_id)).toBe(true);expect(posts).toBe(count);expect(await readdir(`${scratch}/.assembly`)).toEqual([]);
  });
  it("queues idempotent still takes, retains approvals across reordering and pins animation inputs",async()=>{
    const still=server.catalogue.find(b=>b.manifest.category==="image"&&b.manifest.coverage.local==="implemented"&&!b.manifest.inputs.some(p=>p.required)&&!b.manifest.imageArtifacts)!;
    const video=server.catalogue.find(b=>b.manifest.category==="i2v"&&b.manifest.timing?.frameMapping)!;
    const defaults=(b:CapabilityBundle)=>Object.fromEntries(b.manifest.controls.filter(c=>!c.disabledReason&&c.default!==undefined&&!["prompt","length"].includes(c.id)).map(c=>[c.id,c.default]));
    const req=[...still.manifest.routes.find(r=>r.id==="local")!.requirements,...video.manifest.routes.find(r=>r.id==="local")!.requirements];
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:req.filter(r=>r.kind==="node").map(r=>r.name),models:req.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),credentials:[]}),workerId]);
    const planKeys=[randomUUID(),randomUUID()],shots=planKeys.map((planKey,i)=>({...shot(`Still prompt ${i}`,{generation:{capabilityId:video.manifest.id,version:video.manifest.version,routeId:"local",controls:defaults(video)}}),planKey}));
    const id=await board(shots),request={revision:2,workerId,idempotencyKey:randomUUID(),capabilityId:still.manifest.id,version:still.manifest.version,controls:defaults(still)};
    const replies=await Promise.all([api("POST",`storyboards/${id}/stills`,request),api("POST",`storyboards/${id}/stills`,request)]);
    expect(replies.map(r=>r.statusCode),replies.map(r=>r.body).join()).toEqual([200,200]);expect(replies[0].json()).toEqual(replies[1].json());
    const takes=replies[0].json();expect(takes).toHaveLength(2);
    expect((await api("POST",`storyboards/${id}/stills`,{...request,controls:{...request.controls,seed:15}})).statusCode).toBe(409);
    expect((await api("POST",`storyboards/${id}/stills`,{...request,idempotencyKey:randomUUID()},viewer)).statusCode).toBe(403);
    expect((await api("POST",`storyboards/${id}/stills/${takes[0].id}/approve`,{})).statusCode).toBe(422);
    const {Readable}=await import("node:stream"),sharp=(await import("sharp")).default;
    const png=await sharp({create:{width:512,height:512,channels:3,background:"red"}}).png().toBuffer();
    const assets:string[]=[];
    for(const take of takes){
      const saved=await server.store.put(workspaceId,Readable.from(png)),asset=randomUUID();assets.push(asset);
      await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) SELECT $1,$2,$3,'still.png','image','image/png',$4,$5,$6,created_by,'{}' FROM runs WHERE id=$7",[asset,workspaceId,projectId,saved.key,saved.sha256,saved.bytes,take.child_run_id]);
      await pool.query("UPDATE runs SET state='succeeded',output_ids=$1 WHERE id=$2",[JSON.stringify([asset]),take.child_run_id]);
      const approve=await api("POST",`storyboards/${id}/stills/${take.id}/approve`,{});expect(approve.statusCode,approve.body).toBe(200);
    }
    const before=(await api("GET",`storyboards/${id}/stills`)).json();expect(before.every((t:any)=>!!t.approved_at)).toBe(true);
    // Saving deletes physical shot rows; stable plan keys retain the approved frame.
    expect((await api("PUT",`storyboards/${id}/shots`,{revision:2,shots:[shots[1],shots[0]]})).statusCode).toBe(200);
    const current=(await api("GET",`storyboards/${id}`)).json();expect(current.shots.map((s:any)=>s.plan_key)).toEqual([...planKeys].reverse());
    const pinned=Object.fromEntries(planKeys.map((key,i)=>[key,takes[i].id]));
    const renderReply=await api("POST",`storyboards/${id}/renders`,renderRequest({revision:3,approvedStillTakes:pinned}));expect(renderReply.statusCode,renderReply.body).toBe(200);
    const prepared=(await pool.query("SELECT snapshot,prepared FROM storyboard_render_shots WHERE render_id=$1 ORDER BY ordinal",[renderReply.json().id])).rows;
    expect(prepared.map(s=>s.prepared.invocation.inputs.start_image)).toEqual([...assets].reverse());expect(prepared[0].snapshot.approvedStill.takeId).toBe(takes[1].id);
    const again=await api("POST",`storyboards/${id}/stills`,{...request,revision:3,idempotencyKey:randomUUID()});expect(again.statusCode,again.body).toBe(200);
    const history=(await api("GET",`storyboards/${id}/stills`)).json();expect(history.filter((t:any)=>t.approved_at)).toHaveLength(2);expect(history).toHaveLength(4);
    const one=await api("POST",`storyboards/${id}/stills`,{...request,revision:3,idempotencyKey:randomUUID(),planKeys:[planKeys[0]]});expect(one.statusCode,one.body).toBe(200);expect(one.json()).toHaveLength(1);
    const candidate=one.json()[0];await pool.query("UPDATE runs SET state='succeeded',output_ids=$1 WHERE id=$2",[JSON.stringify([assets[0]]),candidate.child_run_id]);
    expect((await api("POST",`storyboards/${id}/stills/${candidate.id}/reject`,{},viewer)).statusCode).toBe(403);
    expect((await api("POST",`storyboards/${id}/stills/${candidate.id}/reject`,{})).statusCode).toBe(200);
    expect((await api("POST",`storyboards/${id}/stills/${candidate.id}/approve`,{})).statusCode).toBe(409);
    expect((await api("POST",`storyboards/${id}/stills/${takes[0].id}/reject`,{})).statusCode).toBe(409);
    const decisions=(await api("GET",`storyboards/${id}/stills`)).json();expect(decisions.filter((t:any)=>t.rejected_at)).toHaveLength(1);expect(decisions.filter((t:any)=>t.approved_at)).toHaveLength(2);
    expect((await api("POST",`storyboards/${id}/stills`,{...request,revision:3,idempotencyKey:randomUUID(),planKeys:[randomUUID()]})).statusCode).toBe(422);

    const approvedTime=history.find((t:any)=>t.id===takes[0].id).approved_at;await api("POST",`storyboards/${id}/stills/${takes[0].id}/approve`,{});
    expect((await api("GET",`storyboards/${id}/stills`)).json().find((t:any)=>t.id===takes[0].id).approved_at).toBe(approvedTime);
    await api("PUT",`storyboards/${id}/shots`,{revision:3,shots:[{...shots[1],prompt:"Changed creative direction"},shots[0]]});
    expect((await api("POST",`storyboards/${id}/stills/${takes[1].id}/approve`,{})).statusCode).toBe(409);
    expect((await api("POST",`storyboards/${id}/renders`,renderRequest({revision:4,approvedStillTakes:pinned}))).statusCode).toBe(422);
    expect((await api("GET",`storyboards/${id}/stills`)).json().every((t:any)=>t.plan_key===planKeys[0])).toBe(true);
    expect((await api("GET",`storyboards/${id}/stills`,undefined,foreignCookie,foreignWs)).statusCode).toBe(404);
  });
  it("rejects duplicate stable shot identities without destroying the saved plan",async()=>{
    const id=await board(),saved=(await api("GET",`storyboards/${id}`)).json(),key=randomUUID();
    expect((await api("PUT",`storyboards/${id}/shots`,{revision:2,shots:[{...shot(),planKey:key},{...shot(),planKey:key}]})).statusCode).toBe(400);
    expect((await api("GET",`storyboards/${id}`)).json()).toEqual(saved);
  });

});
