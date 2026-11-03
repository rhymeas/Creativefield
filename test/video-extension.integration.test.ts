import {afterAll,beforeAll,describe,it,expect} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import path from "node:path";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import type {ServerConfig} from "../server/config";
import {inspectNormalizedVideo} from "../server/video-extension-media";
import {VideoExtensionService} from "../server/video-extension-execution";

const connectionString=process.env.TEST_DATABASE_URL,execute=promisify(execFile);
describe.skipIf(!connectionString)("durable video trim execution with PostgreSQL",()=>{
  const schema=`cf_vid05_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,config:ServerConfig,workspaceId:string,projectId:string,sourceAssetId:string,cookie:string,scratch:string;
  function url(tail:string,workspace=workspaceId){return `/api/v1/workspaces/${workspace}/${tail}`;}
  async function api(method:"GET"|"POST",tail:string,payload?:unknown){return server.app.inject({method,url:url(tail),headers:{origin,cookie},payload:payload as any});}
  async function closeServer(){if(!server)return;await Promise.all([server.execution.close(),server.directExecution.close(),server.storyboards.close(),server.videoExtensions.close(),server.workerMonitor.close()]);await server.app.close();}
  async function restart(){await closeServer();server=await buildServer(config,pool);await server.app.ready();}
  function request(key=randomUUID(),extra:Record<string,unknown>={}){return {projectId,sourceAssetId,idempotencyKey:key,startFrame:4,endFrameExclusive:20,extensionFrames:0,overlapFrames:0,controls:{},...extra};}
  beforeAll(async()=>{
    root=new Pool({connectionString});await root.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    scratch=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-vid05-db-");config={databaseUrl:connectionString!,storageRoot:path.join(scratch,"store"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:20*1024*1024,cookieSecure:false};
    workspaceId=(await bootstrap(pool,"vid05@example.test","Fixture-password-long-27!","VID-05 tests")).workspaceId;server=await buildServer(config,pool);await server.app.ready();
    const login=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"vid05@example.test",password:"Fixture-password-long-27!"}});cookie=String(login.headers["set-cookie"]).split(";")[0];projectId=(await api("POST","projects",{name:"VID-05 fixture"})).json().id;
    const file=path.join(scratch,"source.mp4");await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","color=c=red:s=512x320:r=16:d=1.5","-c:v","libx264","-pix_fmt","yuv420p","-an",file],{windowsHide:true});
    const saved=await server.store.put(workspaceId,createReadStream(file)),owner=(await pool.query("SELECT created_by FROM projects WHERE id=$1",[projectId])).rows[0].created_by;sourceAssetId=randomUUID();
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'source.mp4','video','video/mp4',$4,$5,$6,$7)",[sourceAssetId,workspaceId,projectId,saved.key,saved.sha256,saved.bytes,owner]);
  }, 120000);
  afterAll(async()=>{await closeServer();await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}if(scratch)await rm(scratch,{recursive:true,force:true});});
  it("deduplicates, survives restart and atomically publishes an exact mute trim",async()=>{
    const key=randomUUID(),body=request(key),first=await api("POST","video-extensions",body),duplicate=await api("POST","video-extensions",body);expect(first.statusCode,first.body).toBe(200);expect(duplicate.json().id).toBe(first.json().id);expect((await api("POST","video-extensions",{...body,endFrameExclusive:19})).statusCode).toBe(409);
    expect((await api("GET",`video-extensions?projectId=${projectId}&requestKey=${key}`)).json().map((item:{id:string})=>item.id)).toEqual([first.json().id]);
    expect((await api("GET",`video-extensions?projectId=${randomUUID()}`)).json()).toEqual([]);
    expect((await api("GET",`video-extensions?projectId=${projectId}&requestKey=${randomUUID()}`)).json()).toEqual([]);
    const id=first.json().id;await restart();await server.videoExtensions.tick();const done=(await api("GET",`video-extensions/${id}`)).json();expect(done.state,done.error).toBe("succeeded");expect(done.output_asset_id).toBeTruthy();expect(done.stages).toEqual([expect.objectContaining({kind:"stitch",state:"succeeded",output_asset_id:done.output_asset_id})]);
    const asset=(await pool.query("SELECT * FROM assets WHERE id=$1",[done.output_asset_id])).rows[0],facts=await inspectNormalizedVideo(await server.store.file(workspaceId,asset.storage_key));expect(facts).toMatchObject({width:512,height:320,frameCount:16,hasAudio:false});expect(asset.parent_id).toBe(sourceAssetId);expect(asset.metadata).toMatchObject({operation:"trim",sourceAssetId,videoExtensionJobId:id,output:{frames:16,audioPolicy:"mute"}});expect(JSON.stringify(done)).not.toContain(config.storageRoot);
    await server.videoExtensions.tick();expect((await pool.query("SELECT count(*) FROM assets WHERE id=$1",[done.output_asset_id])).rows[0].count).toBe("1");
  }, 120000);
  it("trims a constant 30 FPS project video end to end and publishes a 16 FPS output",async()=>{
    const file=path.join(scratch,"phone30.mp4");await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","color=c=blue:s=512x320:r=30:d=1","-c:v","libx264","-pix_fmt","yuv420p","-an",file],{windowsHide:true});
    const saved=await server.store.put(workspaceId,createReadStream(file)),owner=(await pool.query("SELECT created_by FROM projects WHERE id=$1",[projectId])).rows[0].created_by,assetId=randomUUID();
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'phone30.mp4','video','video/mp4',$4,$5,$6,$7)",[assetId,workspaceId,projectId,saved.key,saved.sha256,saved.bytes,owner]);
    const created=await api("POST","video-extensions",{projectId,sourceAssetId:assetId,idempotencyKey:randomUUID(),startFrame:0,endFrameExclusive:30,extensionFrames:0,overlapFrames:0,controls:{}});expect(created.statusCode,created.body).toBe(200);
    await server.videoExtensions.tick();const done=(await api("GET",`video-extensions/${created.json().id}`)).json();expect(done.state,done.error).toBe("succeeded");
    const asset=(await pool.query("SELECT * FROM assets WHERE id=$1",[done.output_asset_id])).rows[0],facts=await inspectNormalizedVideo(await server.store.file(workspaceId,asset.storage_key));
    expect(facts.frameRate).toEqual({numerator:16,denominator:1});expect(facts.frameCount).toBe(16);expect(asset.metadata).toMatchObject({operation:"trim",sourceAssetId:assetId,output:{frames:16}});
    const preserved=await api("POST","video-extensions",{projectId,sourceAssetId:assetId,idempotencyKey:randomUUID(),startFrame:0,endFrameExclusive:30,extensionFrames:0,overlapFrames:0,preserveFrameRate:true,controls:{}});expect(preserved.statusCode,preserved.body).toBe(200);
    await server.videoExtensions.tick();const donePreserved=(await api("GET",`video-extensions/${preserved.json().id}`)).json();expect(donePreserved.state,donePreserved.error).toBe("succeeded");
    const preservedAsset=(await pool.query("SELECT storage_key FROM assets WHERE id=$1",[donePreserved.output_asset_id])).rows[0],preservedFacts=await inspectNormalizedVideo(await server.store.file(workspaceId,preservedAsset.storage_key));
    expect(preservedFacts.frameRate).toEqual({numerator:30,denominator:1});expect(preservedFacts.frameCount).toBe(30);
  }, 120000);
  it("reconciles persisted scratch and a pre-publication candidate after restart",async()=>{
    const created=(await api("POST","video-extensions",request())).json(),attemptId=randomUUID(),candidateId=randomUUID(),attemptDir=path.join(config.storageRoot,".video-extension",`attempt-${attemptId}`);
    await pool.query("UPDATE video_extension_jobs SET state='stitching' WHERE workspace_id=$1 AND id=$2",[workspaceId,created.id]);
    await pool.query("UPDATE video_extension_stages SET state='running',detail=$1 WHERE workspace_id=$2 AND job_id=$3 AND kind='stitch'",[JSON.stringify({attemptId,candidateId}),workspaceId,created.id]);
    await mkdir(attemptDir,{recursive:true});await writeFile(path.join(attemptDir,"output.mp4"),"interrupted encode");
    const stale=await server.store.put(workspaceId,createReadStream(path.join(scratch,"source.mp4")),candidateId);
    await writeFile(path.join(config.storageRoot,workspaceId,`${candidateId}.partial`),"interrupted candidate copy");
    await restart();await server.videoExtensions.tick();
    const done=(await api("GET",`video-extensions/${created.id}`)).json(),asset=(await pool.query("SELECT * FROM assets WHERE id=$1",[done.output_asset_id])).rows[0];
    expect(done.state,done.error).toBe("succeeded");expect(asset.storage_key).toBe(`${workspaceId}/${candidateId}`);expect(asset.sha256).not.toBe(stale.sha256);
    await expect(readFile(path.join(attemptDir,"output.mp4"))).rejects.toMatchObject({code:"ENOENT"});
    expect((await pool.query("SELECT count(*) FROM assets WHERE metadata->>'videoExtensionJobId'=$1",[created.id])).rows[0].count).toBe("1");
  }, 120000);
  it("cleans persisted scratch and candidate files when cancellation wins after restart",async()=>{
    const created=(await api("POST","video-extensions",request())).json(),attemptId=randomUUID(),candidateId=randomUUID(),attemptDir=path.join(config.storageRoot,".video-extension",`attempt-${attemptId}`),workspaceDir=path.join(config.storageRoot,workspaceId);
    await pool.query("UPDATE video_extension_jobs SET state='stitching' WHERE workspace_id=$1 AND id=$2",[workspaceId,created.id]);
    await pool.query("UPDATE video_extension_stages SET state='running',detail=$1 WHERE workspace_id=$2 AND job_id=$3 AND kind='stitch'",[JSON.stringify({attemptId,candidateId}),workspaceId,created.id]);
    await mkdir(attemptDir,{recursive:true});await writeFile(path.join(attemptDir,"output.mp4"),"interrupted encode");await server.store.put(workspaceId,createReadStream(path.join(scratch,"source.mp4")),candidateId);await writeFile(path.join(workspaceDir,`${candidateId}.partial`),"interrupted copy");
    await restart();expect((await api("POST",`video-extensions/${created.id}/cancel`)).json().state).toBe("cancel_requested");await server.videoExtensions.tick();
    expect((await api("GET",`video-extensions/${created.id}`)).json().state).toBe("canceled");
    for(const file of [path.join(attemptDir,"output.mp4"),path.join(workspaceDir,candidateId),path.join(workspaceDir,`${candidateId}.partial`)])await expect(readFile(file)).rejects.toMatchObject({code:"ENOENT"});
  }, 120000);
  it("cleans the candidate after a confirmed publication COMMIT rollback",async()=>{
    const created=(await api("POST","video-extensions",request())).json();let injected=false;
    const rollbackPool=new Proxy(pool,{get(target,key){if(key==="connect")return async()=>{
      const client=await target.connect();let publishing=false;
      return new Proxy(client,{get(c,k){if(k==="query")return async(sql:string,...args:unknown[])=>{
        if(typeof sql==="string"&&sql.includes("INSERT INTO assets"))publishing=true;
        if(sql==="COMMIT"&&publishing&&!injected){injected=true;throw new Error("Confirmed publication rollback");}
        return (c.query as any)(sql,...args);
      };const value=Reflect.get(c,k);return typeof value==="function"?value.bind(c):value;}});
    };const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}}) as Pool;
    const service=new VideoExtensionService(rollbackPool,server.store);await service.tick();await service.close();
    const beforeRestart=(await api("GET",`video-extensions/${created.id}`)).json(),candidateId=beforeRestart.stages[0].detail.candidateId;await restart();const failed=(await api("GET",`video-extensions/${created.id}`)).json();
    expect(injected).toBe(true);expect(failed.state).toBe("stitch_failed");expect(candidateId).toMatch(/^[a-f0-9-]{36}$/);
    await expect(server.store.file(workspaceId,`${workspaceId}/${candidateId}`)).rejects.toMatchObject({code:"ENOENT"});
    expect((await pool.query("SELECT count(*) FROM assets WHERE metadata->>'videoExtensionJobId'=$1",[created.id])).rows[0].count).toBe("0");
  }, 120000);
  it("preserves published media when the COMMIT acknowledgement is lost",async()=>{
    const created=(await api("POST","video-extensions",request())).json();let injected=false;
    const ambiguousPool=new Proxy(pool,{get(target,key){if(key==="connect")return async()=>{
      const client=await target.connect();let publishing=false;
      return new Proxy(client,{get(c,k){if(k==="query")return async(sql:string,...args:unknown[])=>{
        if(typeof sql==="string"&&sql.includes("INSERT INTO assets"))publishing=true;
        const value=await (c.query as any)(sql,...args);
        if(sql==="COMMIT"&&publishing&&!injected){injected=true;throw new Error("Publication acknowledgement lost");}
        return value;
      };const value=Reflect.get(c,k);return typeof value==="function"?value.bind(c):value;}});
    };const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}}) as Pool;
    const service=new VideoExtensionService(ambiguousPool,server.store);await service.tick();await service.close();
    const done=(await api("GET",`video-extensions/${created.id}`)).json(),asset=(await pool.query("SELECT storage_key FROM assets WHERE id=$1",[done.output_asset_id])).rows[0];
    expect(injected).toBe(true);expect(done.state).toBe("succeeded");expect(await server.store.file(workspaceId,asset.storage_key)).toBeTruthy();
  }, 120000);
  it("cancels before FFmpeg and rejects unqualified forward continuation",async()=>{
    const created=(await api("POST","video-extensions",request())).json(),canceled=await api("POST",`video-extensions/${created.id}/cancel`);expect(canceled.json().state).toBe("cancel_requested");await server.videoExtensions.tick();expect((await api("GET",`video-extensions/${created.id}`)).json()).toMatchObject({state:"canceled",output_asset_id:null});
    const bundle=server.catalogue.find(item=>item.manifest.id==="video-edit")!,route=bundle.manifest.routes.find(item=>item.id==="local")!,implementation=route.implementation;
    try{route.implementation="experimental";const forward=await api("POST","video-extensions",request(randomUUID(),{workerId:randomUUID(),extensionFrames:8,overlapFrames:5}));expect(forward.statusCode,forward.body).toBe(422);expect(forward.body).toContain("experimental");}finally{route.implementation=implementation;}
  }, 120000);
});
