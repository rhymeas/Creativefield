import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {Readable} from "node:stream";
import sharp from "sharp";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {comfyCloudKey,loadConfig} from "../server/config";
import {hashToken} from "../server/crypto";
import {migrate} from "../server/db";
import {CLOUD_PLAN_BLOCKED_REASON,cloudInventory,cloudReadiness} from "../server/cloud-readiness";
import type {ProbedInventory} from "../src/capabilities/readiness";
import {FAKE_CORE_NODES,FAKE_FLUX2_NODES,startFakeComfyCloud,type FakeComfyCloud} from "./helpers/fake-comfy-cloud";

const origin="http://localhost:5173",fakeKey="fake-key-not-real";
const needsOwnComputer="This one needs your own computer. Pick This computer to run it.";
/** The smallest graph Cloud validates and then judges by plan, as read live on 2026-10-27. */
const PROBE_GRAPH={"1":{class_type:"PrimitiveString",inputs:{value:"ping"}},"2":{class_type:"PreviewAny",inputs:{source:["1",0]}}};
type Server=Awaited<ReturnType<typeof buildServer>>;
type ProbeBody={
  inventory:{online:boolean;nodes:string[];models:string[];objectInfoChecked:boolean;modelInventory?:string;canSubmit?:boolean;submitBlockedReason?:string};
  capabilities:Array<{id:string;readiness:{state:string;reasons:string[]}}>;
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("the Comfy Cloud path against a fake Comfy Cloud",()=>{
  const schema=`cf_cloud_e2e_${randomUUID().replaceAll("-","")}`;
  let root:Pool,pool:Pool,server:Server,workspace:string,cookie:string,projectId:string,workerId:string;
  let fake:FakeComfyCloud,image:Buffer,probeBody:ProbeBody,owner:string;
  /** The picture workflow this suite runs on the fake cloud: the FLUX image packs run on this computer only. */
  const PICTURE_PACK="sam3-image-segment";
  const responses:string[]=[],logs:string[]=[],consoleMocks:Array<{mockRestore:()=>void}>=[];
  const savedEnv={key:process.env.COMFY_CLOUD_API_KEY,file:process.env.COMFY_CLOUD_API_KEY_FILE};

  async function api(method:"GET"|"POST",tail:string,payload?:unknown){
    const response=await server.app.inject({method,url:`/api/v1/workspaces/${workspace}/${tail}`,headers:{origin,cookie},payload:payload as any});
    responses.push(response.body);
    return response;
  }
  function runRequest(capabilityId:string,version:string,idempotencyKey=`cloud-e2e-${randomUUID()}`,inputs:Record<string,string>={}){
    return{projectId,workerId,idempotencyKey,capabilityId,version,routeId:"local",inputs,controls:{prompt:"A blue mug on a wooden desk"},audioPolicy:"mute"};
  }

  async function picture():Promise<string>{
    const id=randomUUID(),bytes=await readFile("fixtures/real/product-mug-white.jpg"),stored=await server.store.put(workspace,Readable.from([bytes]),id);
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'source.jpg','image','image/jpeg',$4,$5,$6,$7)",[id,workspace,projectId,stored.key,stored.sha256,stored.bytes,owner]);
    return id;
  }

  beforeAll(async()=>{
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    workspace=(await bootstrap(pool,"cloud-e2e@fixture.test","Fixture-password-only-123!","Cloud e2e")).workspaceId;
    const user=randomUUID(),token=randomBytes(32).toString("hex");owner=user;
    await pool.query("INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users LIMIT 1",[user,`${user}@fixture.test`]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[workspace,user]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),user]);
    cookie=`cf_session=${token}`;
    /* The only key this suite ever uses: a made-up one in a temp file. */
    const keyFile=`${await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-e2e-")}/key.txt`;await writeFile(keyFile,`${fakeKey}\n`);
    delete process.env.COMFY_CLOUD_API_KEY;process.env.COMFY_CLOUD_API_KEY_FILE=keyFile;
    image=await sharp({create:{width:32,height:32,channels:3,background:{r:40,g:110,b:220}}}).png().toBuffer();
    const samNodes=Object.values(JSON.parse(await readFile("native-workflows/sam3-image-segment/template.api.json","utf8")) as Record<string,{class_type:string}>).map(node=>node.class_type);
    fake=await startFakeComfyCloud({key:fakeKey,image,nodes:[...FAKE_FLUX2_NODES,...FAKE_CORE_NODES,...samNodes]});
    for(const level of ["log","info","warn","error","debug"] as const)
      consoleMocks.push(vi.spyOn(console,level).mockImplementation((...args:unknown[])=>{logs.push(args.map(arg=>typeof arg==="string"?arg:JSON.stringify(arg)).join(" "));}));
    server=await buildServer({databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot:await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-e2e-"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false,comfyCloudApiKey:comfyCloudKey({COMFY_CLOUD_API_KEY_FILE:keyFile})},pool);
    await server.app.ready();
    projectId=(await api("POST","projects",{name:"Cloud e2e"})).json().id;
    /* POST /workers accepts only https://cloud.comfy.org because the key is sent there.
       The row is the narrowest seam the probe and execution read, so the fake is wired here. */
    workerId=randomUUID();
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,api_prefix,kind,enabled) VALUES($1,$2,'Comfy Cloud fake',$3,'/api','cloud',true)",[workerId,workspace,fake.url]);
    const probed=await api("POST",`workers/${workerId}/probe`);
    expect(probed.statusCode,probed.body).toBe(200);
    probeBody=probed.json() as ProbeBody;
  });

  afterAll(async()=>{
    for(const mock of consoleMocks)mock.mockRestore();
    if(fake)await fake.close();
    if(server){await Promise.all([server.execution.close(),server.storyboards.close(),server.workerMonitor.close()]);await server.app.close();}
    await pool?.end();
    if(savedEnv.key===undefined)delete process.env.COMFY_CLOUD_API_KEY;else process.env.COMFY_CLOUD_API_KEY=savedEnv.key;
    if(savedEnv.file===undefined)delete process.env.COMFY_CLOUD_API_KEY_FILE;else process.env.COMFY_CLOUD_API_KEY_FILE=savedEnv.file;
    if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
  });

  it("probes the fake with the key and asks for no memory stats or model folders",()=>{
    expect(probeBody.inventory).toMatchObject({online:true,objectInfoChecked:true,models:[],modelInventory:"cloud"});
    expect(probeBody.inventory.nodes).toEqual(expect.arrayContaining([...FAKE_FLUX2_NODES,...FAKE_CORE_NODES]));
    const info=fake.requests.filter(request=>request.method==="GET"&&request.path==="/api/object_info");
    expect(info).toHaveLength(1);
    expect(info[0].headers.authorization).toBe(`Bearer ${fakeKey}`);
    expect(fake.requests.some(request=>request.path==="/api/system_stats"||request.path.startsWith("/api/models/"))).toBe(false);
  });

  it("asks whether the key may submit with the smallest graph Cloud validates, and makes no job",()=>{
    expect(probeBody.inventory.canSubmit).toBe(true);
    expect(probeBody.inventory.submitBlockedReason).toBeUndefined();
    const asked=fake.requests.filter(request=>request.method==="POST"&&request.path==="/api/prompt");
    // One submit from the probe; the run's own submit goes through the SDK and comes later.
    expect(asked).toHaveLength(1);
    expect(JSON.parse(asked[0].body)).toEqual({prompt:PROBE_GRAPH});
    expect(asked[0].headers.authorization).toBe(`Bearer ${fakeKey}`);
    expect(fake.jobCount()).toBe(0);
  });

  it("tells readiness what the fake has and what it lacks",()=>{
    const ready=probeBody.capabilities.find(capability=>capability.id===PICTURE_PACK);
    expect(ready?.readiness.state).toBe("ready");
    const owned=probeBody.capabilities.find(capability=>capability.id==="sam31-video-mask");
    expect(owned?.readiness.state).toBe("install_required");
    expect(owned?.readiness.reasons).toContain("Comfy Cloud does not have LoadVideo. Run this workflow on this computer instead.");
  });

  it("wants the key on the native prompt call, and calls an empty prompt a graph error",async()=>{
    const refused=await fetch(`${fake.url}/api/prompt`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt:PROBE_GRAPH})});
    expect(refused.status).toBe(401);
    /* With the key, an empty prompt is still a graph error: validation runs before the plan
       check, so its 400 can never be read as permission. */
    const empty=await fetch(`${fake.url}/api/prompt`,{method:"POST",headers:{"content-type":"application/json","x-api-key":fakeKey},body:JSON.stringify({prompt:{}})});
    expect(empty.status).toBe(400);
    expect((await empty.json() as {error?:{type?:string}}).error?.type).toBe("VALIDATION_ERROR");
    const accepted=await fetch(`${fake.url}/api/prompt`,{method:"POST",headers:{"content-type":"application/json","x-api-key":fakeKey},body:JSON.stringify({prompt:PROBE_GRAPH})});
    expect(accepted.status).toBe(200);
    const body=await accepted.json() as {prompt_id?:string};
    expect(body.prompt_id).toMatch(/^fake-prompt-/);
  });

  it("submits a run, polls it to succeeded and stores the image",async()=>{
    const bundle=server.catalogue.find(candidate=>candidate.manifest.id===PICTURE_PACK);
    expect(bundle).toBeDefined();
    const request=runRequest(bundle!.manifest.id,bundle!.manifest.version,undefined,{source_image:await picture()});
    const created=await api("POST","runs",request);
    expect(created.statusCode,created.body).toBe(200);
    const runId=created.json().id as string;

    await server.execution.tick();
    let run=(await api("GET",`runs/${runId}`)).json();
    expect(run.state,run.error).toBe("queued");
    expect(run.transport).toBe("sdk");
    expect(run.remote_id).toMatch(/^fake-job-/);

    // The probe asked on the native prompt call; this is the one submit that carries a graph.
    const submitted=fake.requests.filter(entry=>entry.method==="POST"&&entry.path==="/api/v2/jobs"&&Object.keys(JSON.parse(entry.body).workflow??{}).length>0);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].headers.authorization).toBe(`Bearer ${fakeKey}`);
    expect(submitted[0].headers["idempotency-key"]).toBe(request.idempotencyKey);
    const graph=JSON.parse(submitted[0].body).workflow as Record<string,{class_type:string}>;
    expect(graph["6"].class_type).toBe("SaveImage");

    await server.execution.tick();
    run=(await api("GET",`runs/${runId}`)).json();
    expect(run.state,run.error).toBe("running");

    fake.succeed(run.remote_id);
    await server.execution.tick();
    run=(await api("GET",`runs/${runId}`)).json();
    expect(run.state,run.error).toBe("succeeded");
    expect(run.output_ids).toHaveLength(1);

    const asset=(await api("GET",`assets/${run.output_ids[0]}`)).json();
    expect(asset).toMatchObject({media_type:"image",content_type:"image/png",name:fake.outputName,bytes:String(image.length)});
    const content=await api("GET",`assets/${run.output_ids[0]}/content`);
    expect(content.statusCode,content.body).toBe(200);
    expect(content.rawPayload).toEqual(image);
  });

  it("refuses a cloud-incompatible workflow up front and writes no run",async()=>{
    const bundle=server.catalogue.find(candidate=>candidate.manifest.id==="sam31-video-mask");
    expect(bundle).toBeDefined();
    const request=runRequest(bundle!.manifest.id,bundle!.manifest.version);
    const refused=await api("POST","runs",request);
    expect(refused.statusCode,refused.body).toBe(422);
    expect(refused.json().error).toBe(needsOwnComputer);
    expect((await pool.query("SELECT id FROM runs WHERE idempotency_key=$1",[request.idempotencyKey])).rowCount).toBe(0);
  });

  it("warns that a free-tier key may not run any cloud pack, and writes no run",async()=>{
    /* A free-tier account reads, uploads and probes fine, so only the key's own account shows it. */
    const free=await startFakeComfyCloud({key:fakeKey,image,submitAccess:"free_tier"});
    try{
      const freeWorkerId=randomUUID();
      await pool.query("INSERT INTO workers(id,workspace_id,name,origin,api_prefix,kind,enabled) VALUES($1,$2,'Comfy Cloud free tier',$3,'/api','cloud',true)",[freeWorkerId,workspace,free.url]);
      const probed=await api("POST",`workers/${freeWorkerId}/probe`);
      expect(probed.statusCode,probed.body).toBe(200);
      const inventory=(probed.json() as ProbeBody).inventory;
      expect(inventory).toMatchObject({online:true,canSubmit:false,submitBlockedReason:"API key authentication is not available for free tier accounts"});
      expect(free.jobCount()).toBe(0);

      const cloud=cloudInventory({inventory:inventory as unknown as ProbedInventory,checked_at:new Date()});
      const cloudPacks=server.catalogue.filter(bundle=>bundle.manifest.routes.some(route=>route.execution==="comfy_cloud"));
      expect(cloudPacks.length).toBeGreaterThan(0);
      for(const bundle of cloudPacks)expect(cloudReadiness(bundle.manifest,"cloud",cloud).reasons,bundle.manifest.id).toEqual([CLOUD_PLAN_BLOCKED_REASON]);

      const pack=server.catalogue.find(bundle=>bundle.manifest.id==="cloud-h3-character-swap");
      expect(pack).toBeDefined();
      const refused=await api("POST","runs",{projectId,workerId:freeWorkerId,idempotencyKey:`cloud-free-${randomUUID()}`,capabilityId:pack!.manifest.id,version:pack!.manifest.version,routeId:"cloud",inputs:{},controls:{prompt:"A blue mug on a wooden desk"},audioPolicy:"mute"});
      expect(refused.statusCode,refused.body).toBe(422);
      expect(refused.json().error).toBe(CLOUD_PLAN_BLOCKED_REASON);
      expect((await pool.query("SELECT id FROM runs WHERE worker_id=$1",[freeWorkerId])).rowCount).toBe(0);
    }finally{await free.close();}
  });

  it("puts the cloud's own sentence in a run the plan refuses, and makes no job",async()=>{
    const free=await startFakeComfyCloud({key:fakeKey,image,submitAccess:"free_tier"});
    try{
      /* A worker probed while its plan still allowed submissions, then pointed at the cloud that
         refuses them: the run is the only place left where the refusal can show. */
      const refusedWorkerId=randomUUID();
      const allowed=(await pool.query("SELECT inventory FROM workers WHERE id=$1",[workerId])).rows[0].inventory;
      await pool.query("INSERT INTO workers(id,workspace_id,name,origin,api_prefix,kind,enabled,inventory,checked_at) VALUES($1,$2,'Comfy Cloud plan refused',$3,'/api','cloud',true,$4,now())",[refusedWorkerId,workspace,free.url,JSON.stringify(allowed)]);
      const bundle=server.catalogue.find(candidate=>candidate.manifest.id===PICTURE_PACK);
      expect(bundle).toBeDefined();
      const created=await api("POST","runs",{projectId,workerId:refusedWorkerId,idempotencyKey:`cloud-refused-${randomUUID()}`,capabilityId:bundle!.manifest.id,version:bundle!.manifest.version,routeId:"local",inputs:{source_image:await picture()},controls:{prompt:"A blue mug on a wooden desk"},audioPolicy:"mute"});
      expect(created.statusCode,created.body).toBe(200);
      await server.execution.tick();
      const run=(await api("GET",`runs/${created.json().id}`)).json();
      expect(run.state,run.error).toBe("failed");
      expect(run.error).toContain("API key authentication is not available for free tier accounts (HTTP 403)");
      expect(logs.join("\n")).toContain("SDK submit was rejected:");
      expect(free.jobCount()).toBe(0);
    }finally{await free.close();}
  });

  it("never puts the fake key in a response, log line or error",async()=>{
    expect(fake.requests.some(request=>request.authorized)).toBe(true);
    expect([...responses,...logs].join("\n")).not.toContain(fakeKey);
    expect(JSON.stringify((await pool.query("SELECT * FROM workers")).rows)).not.toContain(fakeKey);
    expect(JSON.stringify((await pool.query("SELECT * FROM runs")).rows)).not.toContain(fakeKey);
  });

  it("never asks the fake for memory stats, the queue or /free",()=>{
    expect(fake.requests.some(request=>["/api/system_stats","/api/queue","/api/free"].includes(request.path))).toBe(false);
  });
});

describe("a missing Comfy Cloud key file",()=>{
  it("fails at start with the plain message and never names a key",async()=>{
    const dir=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-e2e-key-");
    const env={DATABASE_URL:"postgresql://user:pass@127.0.0.1:5432/comfyfield",STORAGE_ROOT:dir,MASTER_KEY:randomBytes(32).toString("base64"),PUBLIC_ORIGIN:origin,COMFY_CLOUD_API_KEY_FILE:`${dir}/absent.txt`};
    let message="";
    try{loadConfig(env);}catch(error){message=error instanceof Error?error.message:String(error);}
    expect(message).toBe("COMFY_CLOUD_API_KEY_FILE is missing");
    expect(message).not.toContain(fakeKey);
  });
});
