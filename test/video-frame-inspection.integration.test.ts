import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {Readable} from "node:stream";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import sharp from "sharp";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import {hashToken} from "../server/crypto";

describe.skipIf(!process.env.TEST_DATABASE_URL)("durable frame inspection authorization and publication",()=>{
  const schema=`cf_frames_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,workspace:string,user:string,project:string,worker:string,cookie:string,viewer:string,foreign:string,foreignWs:string,runId:string,videoAsset:string;
  const api=(method:"GET"|"POST",run=runId,session=cookie,ws=workspace)=>server.app.inject({method,url:`/api/v1/workspaces/${ws}/runs/${run}/frames`,headers:{origin,cookie:session},...(method==="POST"?{payload:{}}:{})});
  async function session(role:string,ws=workspace){const id=randomUUID(),token=randomBytes(32).toString("hex");await pool.query("INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users LIMIT 1",[id,`${id}@fixture.test`]);await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",[ws,id,role]);await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),id]);return `cf_session=${token}`;}
  async function asset(bytes:Buffer,type:"image"|"video"){
    const saved=await server.store.put(workspace,Readable.from(bytes)),id=randomUUID();
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[id,workspace,project,type==="image"?"frame.png":"clip.mp4",type,type==="image"?"image/png":"video/mp4",saved.key,saved.sha256,saved.bytes,user]);return id;
  }
  async function makeRun(){
    const bundle=server.catalogue.find(b=>b.manifest.id==="wan22-flf2v-14b")!,req=bundle.manifest.routes.find(r=>r.id==="local")!.requirements;
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:req.filter(r=>r.kind==="node").map(r=>r.name),models:req.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),credentials:[]}),worker]);
    const input=await asset(await sharp({create:{width:320,height:240,channels:3,background:"red"}}).png().toBuffer(),"image"),controls=Object.fromEntries(bundle.manifest.controls.filter(c=>c.default!==undefined).map(c=>[c.id,c.default]));
    const response=await server.app.inject({method:"POST",url:`/api/v1/workspaces/${workspace}/runs`,headers:{origin,cookie},payload:{projectId:project,workerId:worker,idempotencyKey:randomUUID(),capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{start_image:input,end_image:input},controls:{...controls,prompt:"Static product",length:1},audioPolicy:"mute"}});
    expect(response.statusCode,response.body).toBe(200);return response.json().id as string;
  }
  beforeAll(async()=>{
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    const boot=await bootstrap(pool,"frames@fixture.test","Fixture-password-only-123!","Frames");workspace=boot.workspaceId;user=boot.userId;
    const scratch=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/frame-inspection-");
    server=await buildServer({databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot:scratch,masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:4*1024*1024,cookieSecure:false},pool);await server.app.ready();cookie=await session("admin");viewer=await session("viewer");
    foreignWs=randomUUID();await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Foreign')",[foreignWs]);foreign=await session("admin",foreignWs);
    project=(await server.app.inject({method:"POST",url:`/api/v1/workspaces/${workspace}/projects`,headers:{origin,cookie},payload:{name:"Frames"}})).json().id;
    worker=(await server.app.inject({method:"POST",url:`/api/v1/workspaces/${workspace}/workers`,headers:{origin,cookie},payload:{name:"Unstarted fixture",origin:"http://127.0.0.1:9",apiPrefix:""}})).json().id;
    const filename=scratch+"/fixture.mp4";await promisify(execFile)("ffmpeg",["-v","error","-nostdin","-y","-f","lavfi","-i","color=c=red:s=320x240:r=16","-frames:v","17","-c:v","libx264","-pix_fmt","yuv420p",filename],{windowsHide:true});
    videoAsset=await asset(await readFile(filename),"video");runId=await makeRun();await pool.query("UPDATE runs SET state='succeeded',output_ids=$1 WHERE id=$2",[JSON.stringify([videoAsset]),runId]);
  });
  afterAll(async()=>{if(server){await Promise.all([server.execution.close(),server.storyboards.close(),server.workerMonitor.close()]);await server.app.close();}await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}});
  it("deduplicates concurrent extraction and publishes eight parent-linked frames atomically",async()=>{
    expect((await api("GET")).statusCode).toBe(200);expect((await api("GET")).json()).toBe(null);expect((await api("POST",runId,viewer)).statusCode).toBe(403);
    const responses=await Promise.all([api("POST"),api("POST")]);expect(responses.map(r=>r.statusCode),responses.map(r=>r.body).join()).toEqual([200,200]);expect(responses[0].json()).toEqual(responses[1].json());
    const result=responses[0].json();expect(result.frames).toHaveLength(8);expect(result.frameCount).toBe(17);expect(result.measurement.decodedFrameMd5).toHaveLength(17);
    const frames=(await pool.query("SELECT parent_id,metadata FROM assets WHERE workspace_id=$1 AND parent_id=$2",[workspace,videoAsset])).rows;expect(frames).toHaveLength(8);expect(frames.every(a=>a.metadata.frameExtraction.sourceAssetId===videoAsset)).toBe(true);
    expect((await api("GET",runId,viewer)).json()).toEqual(result);expect((await api("POST")).json()).toEqual(result);
    expect((await api("GET",runId,foreign,foreignWs)).statusCode).toBe(404);expect((await api("POST",runId,foreign,foreignWs)).statusCode).toBe(404);
  });
  it("refuses pending runs and a changed published video without partial frame assets",async()=>{
    const pending=await makeRun();expect((await api("POST",pending)).statusCode).toBe(422);
    const row=(await pool.query("SELECT storage_key FROM assets WHERE id=$1",[videoAsset])).rows[0],file=await server.store.file(workspace,row.storage_key),original=await readFile(file);
    await pool.query("UPDATE runs SET state='succeeded',output_ids=$1 WHERE id=$2",[JSON.stringify([videoAsset]),pending]);
    try{await writeFile(file,Buffer.from("changed video"));expect((await api("POST",pending)).statusCode).toBe(422);}finally{await writeFile(file,original);}
    expect((await pool.query("SELECT run_id FROM video_frame_inspections WHERE run_id=$1",[pending])).rowCount).toBe(0);expect((await pool.query("SELECT id FROM assets WHERE parent_id=$1",[videoAsset])).rowCount).toBe(8);
  });
});
