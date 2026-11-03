import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Pool} from "pg";
import {execFile,spawnSync} from "node:child_process";
import {promisify} from "node:util";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {Readable} from "node:stream";
import path from "node:path";
import sharp from "sharp";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import {inspectNormalizedVideo} from "../server/video-extension-media";
import {prepareVideoSource,readyFrameRate} from "../server/video-extension-prepare";
import type {ServerConfig} from "../server/config";

const execute=promisify(execFile);
const binariesAvailable=spawnSync(process.env.FFMPEG_PATH??"ffmpeg",["-version"],{windowsHide:true}).status===0
  &&spawnSync(process.env.FFPROBE_PATH??"ffprobe",["-version"],{windowsHide:true}).status===0;

describe("ready frame rate",()=>{
  it("keeps the clip's own average rate, rounded and kept between 8 and 60",()=>{
    expect([29.97,31.03,30].map(readyFrameRate)).toEqual([30,31,30]);
    expect(readyFrameRate(5)).toBe(8);
    expect(readyFrameRate(120)).toBe(60);
  });
});

describe.skipIf(!binariesAvailable)("video source prepare route",()=>{
  const schema=`cf_prepare_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173",password="Prepare-fixture-password-28!";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,workspaceId:string,userId:string,projectId:string,cookie:string,scratch:string;
  let wobbly:string,steady:string,steady24:string,fast60:string,withSound:string,notVideo:string,screenRecording:string;
  const url=(tail:string)=>`/api/v1/workspaces/${workspaceId}/${tail}`;
  const prepare=(assetId:string,fps?:number)=>server.app.inject({method:"POST",url:url("video-sources/prepare"),headers:{origin,cookie},payload:{projectId,assetId,...(fps===undefined?{}:{fps})}});
  const prepareClean=(assetId:string)=>server.app.inject({method:"POST",url:url("video-sources/prepare"),headers:{origin,cookie},payload:{projectId,assetId,clean:true}});
  async function asset(name:string,kind:string,type:string,bytes:Buffer){
    const saved=await server.store.put(workspaceId,Readable.from(bytes)),id=randomUUID();
    return (await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
      [id,workspaceId,projectId,name,kind,type,saved.key,saved.sha256,saved.bytes,userId])).rows[0];
  }
  async function videoAsset(name:string,file:string){return asset(name,"video","video/mp4",await readFile(file));}
  async function averageFrameRate(file:string){
    const {stdout}=await execute(process.env.FFPROBE_PATH??"ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=avg_frame_rate","-of","json",file],{windowsHide:true});
    const [numerator,denominator]=String(JSON.parse(String(stdout)).streams[0].avg_frame_rate).split("/").map(Number);
    return numerator/denominator;
  }
  const readyCount=(sha256:string)=>pool.query("SELECT count(*) FROM assets WHERE workspace_id=$1 AND project_id=$2 AND metadata->'videoPrepare'->>'sourceSha256'=$3",[workspaceId,projectId,sha256]).then(result=>result.rows[0].count);
  const storedFile=(assetId:string)=>pool.query("SELECT storage_key FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,assetId]).then(result=>server.store.file(workspaceId,result.rows[0].storage_key));

  beforeAll(async()=>{
    scratch=await mkdtemp(path.join(tmpdir(),"comfyfield-prepare-"));
    const ffmpeg=process.env.FFMPEG_PATH??"ffmpeg";
    wobbly=path.join(scratch,"wobbly.mp4");
    // Two rates jittered frame by frame: ffprobe reports a constant-looking rate but uneven timestamps.
    await execute(ffmpeg,["-v","error","-y","-f","lavfi","-i","testsrc2=size=64x64:rate=30","-frames:v","90","-vf","setpts=PTS+0.004*sin(N*11)/TB","-fps_mode","passthrough","-c:v","libx264","-preset","ultrafast","-crf","18","-pix_fmt","yuv420p",wobbly],{windowsHide:true,timeout:60000});
    steady=path.join(scratch,"steady.mp4");
    await execute(ffmpeg,["-v","error","-y","-f","lavfi","-i","testsrc2=size=64x64:rate=30","-frames:v","60","-c:v","libx264","-preset","ultrafast","-crf","18","-pix_fmt","yuv420p",steady],{windowsHide:true,timeout:60000});
    steady24=path.join(scratch,"steady-24.mp4");
    await execute(ffmpeg,["-v","error","-y","-f","lavfi","-i","testsrc2=size=64x64:rate=24","-frames:v","72","-c:v","libx264","-preset","ultrafast","-crf","18","-pix_fmt","yuv420p",steady24],{windowsHide:true,timeout:60000});
    // A phone clip at 60 fps: four seconds, 240 frames, already a constant zero-based rate.
    fast60=path.join(scratch,"fast-60.mp4");
    await execute(ffmpeg,["-v","error","-y","-f","lavfi","-i","testsrc2=size=64x64:rate=60","-frames:v","240","-c:v","libx264","-preset","ultrafast","-crf","18","-pix_fmt","yuv420p",fast60],{windowsHide:true,timeout:60000});
    withSound=path.join(scratch,"with-sound.mp4");
    await execute(ffmpeg,["-v","error","-y","-i",wobbly,"-f","lavfi","-i","anullsrc=r=48000:cl=mono","-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-shortest",withSound],{windowsHide:true,timeout:60000});
    notVideo=path.join(scratch,"notes.mp4");
    await writeFile(notVideo,"This is not a video.");
    // A phone-style recording: moving picture in the middle, static app bars top and bottom.
    screenRecording=path.join(scratch,"screen.mp4");
    await execute(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-y",
      "-f","lavfi","-i","color=c=#101820:s=270x480:r=30:d=2",
      "-f","lavfi","-i","life=s=270x152:r=30:mold=10:ratio=0.1:seed=1",
      "-filter_complex","[1:v]trim=duration=2[vid];[0:v][vid]overlay=0:164",
      "-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p",screenRecording],{windowsHide:true,timeout:60000});
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    workspaceId=(await bootstrap(pool,"video-prepare@example.test",password,"Video prepare")).workspaceId;
    userId=(await pool.query("SELECT id FROM users WHERE email='video-prepare@example.test'")).rows[0].id;
    const config:ServerConfig={databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot:path.join(scratch,"store"),masterKey:randomBytes(32),publicOrigin:origin,
      host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:32*1024*1024,cookieSecure:false};
    server=await buildServer(config,pool);await server.app.ready();
    const login=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"video-prepare@example.test",password}});
    cookie=String(login.headers["set-cookie"]).split(";")[0];
    projectId=(await server.app.inject({method:"POST",url:url("projects"),headers:{origin,cookie},payload:{name:"Video prepare"}})).json().id;
  },120000);
  afterAll(async()=>{
    await server?.app.close();await pool?.end();
    if(root){await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await root.end();}
    if(scratch)await rm(scratch,{recursive:true,force:true});
  });

  it("makes a wobbly clip ready once, keeps its average rate, and reuses that copy",async()=>{
    await expect(inspectNormalizedVideo(wobbly)).rejects.toThrow();
    const source=await videoAsset("Phone clip.mp4",wobbly),expected=readyFrameRate(await averageFrameRate(wobbly)),first=await prepare(source.id);
    expect(first.statusCode,first.body).toBe(200);
    const ready=first.json();
    expect(ready.id).not.toBe(source.id);
    expect(ready.name).toBe("Phone clip.mp4 (ready)");
    expect(ready).toMatchObject({project_id:projectId,media_type:"video",content_type:"video/mp4",parent_id:source.id});
    expect(ready.sha256).not.toBe(source.sha256);
    expect(ready).not.toHaveProperty("storage_key");
    expect(ready.metadata.videoPrepare).toMatchObject({sourceAssetId:source.id,sourceSha256:source.sha256});
    const facts=await inspectNormalizedVideo(await storedFile(ready.id));
    expect(facts.frameRate).toEqual({numerator:expected,denominator:1});
    expect(facts.hasAudio).toBe(false);
    expect(facts.frameCount).toBeGreaterThan(10);
    const again=await prepare(source.id);
    expect(again.statusCode,again.body).toBe(200);
    expect(again.json().id).toBe(ready.id);
    expect(await readyCount(source.sha256)).toBe("1");
  },120000);

  it("returns a steady clip unchanged instead of copying it",async()=>{
    const source=await videoAsset("Steady clip.mp4",steady),response=await prepare(source.id);
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json().id).toBe(source.id);
    expect(await readyCount(source.sha256)).toBe("0");
  },120000);

  it("resamples a 60 fps clip to 24 fps and reuses that copy",async()=>{
    const source=await videoAsset("Phone 60.mp4",fast60),seconds=(await inspectNormalizedVideo(fast60)).durationSeconds;
    const first=await prepare(source.id,24);
    expect(first.statusCode,first.body).toBe(200);
    const ready=first.json();
    expect(ready.id).not.toBe(source.id);
    expect(ready.name).toBe("Phone 60.mp4 (ready 24 fps)");
    expect(ready.parent_id).toBe(source.id);
    expect(ready.metadata.videoPrepare).toMatchObject({sourceAssetId:source.id,sourceSha256:source.sha256,fps:24});
    const facts=await inspectNormalizedVideo(await storedFile(ready.id));
    expect(facts.frameRate).toEqual({numerator:24,denominator:1});
    expect(facts.frameCount).toBe(Math.round(seconds*24));
    const again=await prepare(source.id,24);
    expect(again.statusCode,again.body).toBe(200);
    expect(again.json().id).toBe(ready.id);
    expect(await readyCount(source.sha256)).toBe("1");
    // A request without a rate still gets the clip itself, not its 24 fps copy.
    expect((await prepare(source.id)).json().id).toBe(source.id);
  },120000);

  it("uses a 24 fps clip itself when it is asked for 24 fps",async()=>{
    const source=await videoAsset("Steady 24.mp4",steady24),response=await prepare(source.id,24);
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json().id).toBe(source.id);
    expect(await readyCount(source.sha256)).toBe("0");
  },120000);

  it("refuses a frame rate outside 8 to 60 or not a whole number",async()=>{
    const source=await videoAsset("Rate range.mp4",steady);
    for(const fps of [7,61,24.5]){
      const response=await server.app.inject({method:"POST",url:url("video-sources/prepare"),headers:{origin,cookie},payload:{projectId,assetId:source.id,fps}});
      expect(response.statusCode,`${fps}: ${response.body}`).toBe(400);
    }
  },120000);

  it("crops a screen recording to its moving picture and stores it as a clean clip",async()=>{
    const source=await videoAsset("TikTok screen.mp4",screenRecording);
    const clean=await prepareVideoSource(pool,server.store,workspaceId,userId,{projectId,assetId:source.id,clean:true});
    expect(clean.cleaned).toBe(true);
    expect(clean.id).not.toBe(source.id);
    expect(clean.name).toBe("TikTok screen.mp4 (clean)");
    expect(clean.parent_id).toBe(source.id);
    expect((clean.metadata as {videoPrepare:{clean:boolean;cleanVersion:number;sourceSha256:string;region:{width:number;height:number;aspect:string}}}).videoPrepare)
      .toMatchObject({clean:true,cleanVersion:5,sourceSha256:source.sha256,region:{width:270,height:152,aspect:"16:9"}});
    const facts=await inspectNormalizedVideo(await storedFile(clean.id));
    expect({width:facts.width,height:facts.height}).toEqual({width:270,height:152});
    expect(facts.frameRate).toEqual({numerator:30,denominator:1});
    const again=await prepareVideoSource(pool,server.store,workspaceId,userId,{projectId,assetId:source.id,clean:true});
    expect(again.id).toBe(clean.id);
    // A previous attempt that could not remove overlays is not a reusable clean copy.
    await pool.query("UPDATE assets SET metadata=jsonb_set(metadata,'{videoPrepare,overlay,state}','\"unavailable\"'::jsonb) WHERE id=$1",[clean.id]);
    const retried=await prepareVideoSource(pool,server.store,workspaceId,userId,{projectId,assetId:source.id,clean:true});
    expect(retried.id).not.toBe(clean.id);
    expect(retried.metadata.videoPrepare).toMatchObject({overlay:{state:"none"}});
    // A clean copy from the old region finder has no cleanVersion and must not be reused.
    await pool.query("UPDATE assets SET metadata = metadata #- '{videoPrepare,cleanVersion}' WHERE id=$1",[retried.id]);
    const fresh=await prepareVideoSource(pool,server.store,workspaceId,userId,{projectId,assetId:source.id,clean:true});
    expect(fresh.id).not.toBe(clean.id);
    expect(fresh.id).not.toBe(retried.id);
    expect((fresh.metadata as {videoPrepare:{cleanVersion:number}}).videoPrepare.cleanVersion).toBe(5);
  },120000);

  it("accepts clean:true on the prepare route and returns the clean clip",async()=>{
    const source=await videoAsset("Route screen.mp4",screenRecording),response=await prepareClean(source.id);
    expect(response.statusCode,response.body).toBe(200);
    const clean=response.json();
    expect(clean).toMatchObject({project_id:projectId,media_type:"video",content_type:"video/mp4",cleaned:true});
    expect(clean).not.toHaveProperty("storage_key");
    expect(clean.metadata.videoPrepare).toMatchObject({clean:true,cleanVersion:5,sourceSha256:source.sha256,region:{width:270,height:152,aspect:"16:9"}});
  },120000);

  it("keeps one audio stream as aac stereo 48000 in the ready clip",async()=>{
    const source=await videoAsset("Screen recording.mp4",withSound),response=await prepare(source.id);
    expect(response.statusCode,response.body).toBe(200);
    const facts=await inspectNormalizedVideo(await storedFile(response.json().id));
    expect(facts.hasAudio).toBe(true);
    expect(facts.audioSeconds).toBeGreaterThan(0);
  },120000);

  it("refuses an image, a file that is not a video, a missing asset and a bad body",async()=>{
    const image=await asset("Still.png","image","image/png",await readFile("test/assets/motion-character.png"));
    expect((await prepare(image.id)).statusCode).toBe(422);
    const fake=await videoAsset("notes.mp4",notVideo);
    expect((await prepare(fake.id)).statusCode).toBe(422);
    expect((await prepare(randomUUID())).statusCode).toBe(404);
    const bad=await server.app.inject({method:"POST",url:url("video-sources/prepare"),headers:{origin,cookie},payload:{assetId:randomUUID()}});
    expect(bad.statusCode).toBe(400);
  },120000);

  it("still refuses a wobbly clip for trimming, so the frame contract is not loosened",async()=>{
    const source=await videoAsset("Phone for trim.mp4",wobbly);
    const response=await server.app.inject({method:"POST",url:url("video-extension-plans"),headers:{origin,cookie},
      payload:{projectId,sourceAssetId:source.id,startFrame:0,endFrameExclusive:16,extensionFrames:0,overlapFrames:0}});
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatch(/frame rate|timestamps/i);
  },120000);
  it("serves reference inspection on the main application origin without submitting work",async()=>{
    const runId=randomUUID(),graph=JSON.parse(await readFile("native-workflows/scail2-character-replace/template.api.json","utf8"));
    await pool.query("INSERT INTO runs(id,workspace_id,project_id,created_by,capability_id,capability_version,route_id,state,idempotency_key,request_hash,invocation,graph) VALUES($1,$2,$3,$4,'scail2-character-replace','0.5.1','local','succeeded',$5,'fixture-inspection','{}',$6)",[runId,workspaceId,projectId,userId,randomUUID(),JSON.stringify(graph)]);
    const response=await server.app.inject({method:"GET",url:url(`runs/${runId}/reference-inspection`),headers:{cookie}});
    expect(response.statusCode,response.body).toBe(200);
    expect(Object.values(response.json().graph).filter((n:any)=>n.class_type==="SaveImage")).toHaveLength(4);
    expect((await pool.query("SELECT state FROM runs WHERE id=$1",[runId])).rows[0].state).toBe("succeeded");
  });
  it("creates only an image candidate, reuses a request, and binds explicit approval to that image",async()=>{
    const source=await videoAsset("Anchor source.mp4",steady24),png=await sharp({create:{width:64,height:64,channels:3,background:"#aaaaaa"}}).png().toBuffer();
    const left=await asset("Left reference.png","image","image/png",png),right=await asset("Right reference.png","image","image/png",png);
    const manifest=JSON.parse(await readFile("native-workflows/replace-scene-anchor/manifest.json","utf8")),flux=JSON.parse(await readFile("native-workflows/replace-scene-anchor-flux/manifest.json","utf8")),requirements=[...manifest.routes[0].requirements,...flux.routes[0].requirements];
    const worker=randomUUID(),inventory={online:true,nodes:requirements.filter((r:any)=>r.kind==="node").map((r:any)=>r.name),models:requirements.filter((r:any)=>r.kind==="model").map((r:any)=>`${r.location}/${r.name}`),credentials:[],objectInfoChecked:true,checkedModelFolders:["diffusion_models","text_encoders","vae"]};
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,inventory,checked_at) VALUES($1,$2,'Anchor fixture','http://127.0.0.1:1',$3,now())",[worker,workspaceId,JSON.stringify(inventory)]);
    const body={projectId,workerId:worker,videoAssetId:source.id,referenceIds:[left.id,right.id],requestKey:randomUUID()};
    expect((await server.app.inject({method:"POST",url:url("replace-anchors"),payload:body,headers:{origin}})).statusCode).toBe(401);
    const create=()=>server.app.inject({method:"POST",url:url("replace-anchors"),payload:body,headers:{origin,cookie}});
    const first=await create();expect(first.statusCode,first.body).toBe(200);const pending=first.json();
    expect(pending.state).toBe("working");expect((await create()).json().runId).toBe(pending.runId);
    expect((await server.app.inject({method:"POST",url:url("replace-anchors"),payload:{...body,variant:"qwen"},headers:{origin,cookie}})).json().runId).toBe(pending.runId);
    expect((await server.app.inject({method:"POST",url:url("replace-anchors"),payload:{...body,variant:"flux"},headers:{origin,cookie}})).statusCode).toBe(409);
    const experiment=await server.app.inject({method:"POST",url:url("replace-anchors"),payload:{...body,variant:"flux",requestKey:randomUUID()},headers:{origin,cookie}});expect(experiment.statusCode,experiment.body).toBe(200);
    expect(experiment.json()).toMatchObject({variant:"flux",sourceFrameId:pending.sourceFrameId});
    expect((await pool.query("SELECT capability_id FROM runs WHERE id=$1",[experiment.json().runId])).rows[0].capability_id).toBe("replace-scene-anchor-flux");
    const different=await server.app.inject({method:"POST",url:url("replace-anchors"),payload:{...body,prompt:"Different request"},headers:{origin,cookie}});expect(different.statusCode).toBe(409);
    const run=(await pool.query("SELECT * FROM runs WHERE id=$1",[pending.runId])).rows[0];
    expect(run.capability_id).toBe("replace-scene-anchor");expect(run.invocation.inputs).toMatchObject({reference_image:left.id,reference_image_2:right.id});
    const candidate=await asset("Scene candidate.png","image","image/png",png);
    await pool.query("UPDATE runs SET state='succeeded',output_ids=$2 WHERE id=$1",[pending.runId,JSON.stringify([candidate.id])]);
    const reviewUrl=url(`replace-anchors/${pending.runId}`),read=()=>server.app.inject({method:"GET",url:reviewUrl,headers:{cookie}});
    const ready=(await read()).json();expect(ready.state).toBe("ready");
    const approved=await server.app.inject({method:"POST",url:reviewUrl+"/review",headers:{origin,cookie},payload:{decision:"approved",expectedDigest:ready.contextDigest}});
    expect(approved.statusCode,approved.body).toBe(200);expect((await read()).json().state).toBe("approved");
    expect((await pool.query("SELECT count(*)::int AS n FROM runs WHERE idempotency_key=$1",[`replace-anchor:${body.requestKey}`])).rows[0].n).toBe(1);
    await pool.query("UPDATE assets SET sha256=$2 WHERE id=$1",[candidate.id,"e".repeat(64)]);
    expect((await read()).json().state).toBe("ready");
    expect((await server.app.inject({method:"POST",url:reviewUrl+"/review",headers:{origin,cookie},payload:{decision:"approved",expectedDigest:ready.contextDigest}})).statusCode).toBe(409);
  },120000);
  it("admits a five-frame video-model probe without still approval and refuses a full clip",async()=>{
    const file=path.join(scratch,"video-probe-five.mp4");
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-y","-v","error","-i",steady24,"-frames:v","5","-an","-c:v","libx264","-pix_fmt","yuv420p",file],{windowsHide:true});
    const short=await videoAsset("Probe five frames.mp4",file),long=await videoAsset("Too long for probe.mp4",steady24),png=await sharp({create:{width:64,height:64,channels:3,background:"#aaaaaa"}}).png().toBuffer();
    const cut=()=>server.app.inject({method:"POST",url:url("video-frame-sources"),headers:{origin,cookie},payload:{projectId,assetId:long.id}});
    expect((await server.app.inject({method:"POST",url:url("video-frame-sources"),headers:{origin},payload:{projectId,assetId:long.id}})).statusCode).toBe(401);
    expect((await server.app.inject({method:"POST",url:url("video-frame-sources"),headers:{origin,cookie},payload:{projectId:randomUUID(),assetId:long.id}})).statusCode).toBe(404);
    const prepared=await cut();expect(prepared.statusCode,prepared.body).toBe(200);
    expect((await cut()).json().id).toBe(prepared.json().id);
    await pool.query("UPDATE assets SET sha256=$2 WHERE id=$1",[long.id,"e".repeat(64)]);expect((await cut()).statusCode).toBe(422);
    await pool.query("UPDATE assets SET sha256=$2 WHERE id=$1",[long.id,long.sha256]);
    const facts=await inspectNormalizedVideo(await server.store.file(workspaceId,prepared.json().storage_key));expect(facts.frameCount).toBe(5);expect(facts.frameRate).toEqual({numerator:24,denominator:1});
    const left=await asset("Probe left.png","image","image/png",png),right=await asset("Probe right.png","image","image/png",png);
    const manifest=JSON.parse(await readFile("native-workflows/replace-video-frame-probe/manifest.json","utf8")),requirements=manifest.routes[0].requirements;
    const worker=randomUUID(),inventory={online:true,nodes:requirements.filter((r:any)=>r.kind==="node").map((r:any)=>r.name),models:requirements.filter((r:any)=>r.kind==="model").map((r:any)=>`${r.location}/${r.name}`),credentials:[],objectInfoChecked:true,checkedModelFolders:[...new Set(requirements.filter((r:any)=>r.kind==="model").map((r:any)=>r.location))]};
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,inventory,checked_at) VALUES($1,$2,'Video probe fixture','http://127.0.0.1:2',$3,now())",[worker,workspaceId,JSON.stringify(inventory)]);
    const body={projectId,workerId:worker,idempotencyKey:`video-probe:${randomUUID()}`,capabilityId:manifest.id,version:manifest.version,routeId:"local",inputs:{source_video:long.id,character_image:left.id,character_image_2:right.id},controls:{prompt:"Keep the source scene and reference characters."},audioPolicy:"mute"};
    const refused=await server.app.inject({method:"POST",url:url("runs"),headers:{origin,cookie},payload:body});expect(refused.statusCode,refused.body).toBe(422);expect(refused.body).toContain("exactly five frames");
    const accepted=await server.app.inject({method:"POST",url:url("runs"),headers:{origin,cookie},payload:{...body,inputs:{...body.inputs,source_video:short.id}}});expect(accepted.statusCode,accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({capability_id:manifest.id,state:"pending",output_ids:[]});
    expect((await pool.query("SELECT count(*)::int n FROM runs WHERE capability_id=$1",[manifest.id])).rows[0].n).toBe(1);
    const single=JSON.parse(await readFile("native-workflows/replace-video-frame-probe-single/manifest.json","utf8"));
    const one=await server.app.inject({method:"POST",url:url("runs"),headers:{origin,cookie},payload:{...body,idempotencyKey:`video-probe:${randomUUID()}`,capabilityId:single.id,version:single.version,inputs:{source_video:short.id,character_image:left.id},controls:{prompt:"Replace one person.",person:"1"}}});
    expect(one.statusCode,one.body).toBe(200);
    const invocation=(await pool.query("SELECT invocation FROM runs WHERE id=$1",[one.json().id])).rows[0].invocation;
    expect(invocation.inputs.character_image_2).toBeUndefined();expect(invocation.controls.person).toBe("1");
    const scene=JSON.parse(await readFile("native-workflows/replace-video-frame-probe-scene/manifest.json","utf8"));
    await pool.query("UPDATE workers SET inventory=$2 WHERE id=$1",[worker,JSON.stringify({...inventory,nodes:[...inventory.nodes,"ImageScale","PrimitiveStringMultiline"]})]);
    const sceneBody={...body,idempotencyKey:`video-probe:${randomUUID()}`,capabilityId:scene.id,version:scene.version,inputs:{source_video:short.id,scene_image:left.id},controls:{prompt:"Keep the scene.",people:"0,1"}};
    const sceneRun=await server.app.inject({method:"POST",url:url("runs"),headers:{origin,cookie},payload:sceneBody});expect(sceneRun.statusCode,sceneRun.body).toBe(200);
    const frozen=(await pool.query("SELECT invocation FROM runs WHERE id=$1",[sceneRun.json().id])).rows[0].invocation;
    expect(frozen.inputs).toEqual({source_video:short.id,scene_image:left.id});expect(frozen.sceneReference).toMatchObject({assetId:left.id,sha256:left.sha256});
    expect(frozen.controls.replacement_mode).toBe(false);
    await pool.query("UPDATE assets SET sha256=$2 WHERE id=$1",[left.id,"d".repeat(64)]);
    const changed=await server.app.inject({method:"POST",url:url("runs"),headers:{origin,cookie},payload:{...sceneBody,idempotencyKey:`video-probe:${randomUUID()}`}});expect(changed.statusCode).toBe(422);expect(changed.body).toContain("scene image");
  },120000);
});
