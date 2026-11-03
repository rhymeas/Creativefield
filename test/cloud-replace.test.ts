import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from "vitest";
import {Pool} from "pg";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {randomBytes,randomUUID} from "node:crypto";
import {Readable} from "node:stream";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {comfyCloudKey} from "../server/config";
import {hashToken} from "../server/crypto";
import {migrate} from "../server/db";
import {loadServerCatalogue} from "../server/catalogue";
import {cloudInputs,sdkClient,sdkFailureReason} from "../server/sdk-client";
import {probeWorker} from "../server/workers";
import {compileLocal} from "../src/capabilities/compile";
import {CLOUD_ONLY_REASON,capabilityReadiness} from "../src/capabilities/readiness";
import {cloudInventory,cloudReadiness,CLOUD_PLAN_BLOCKED_REASON,CLOUD_WORKER_REASON} from "../server/cloud-readiness";
import type {CapabilityBundle,WorkerInventory} from "../src/capabilities/types";
import {FAKE_CORE_NODES,FAKE_FLUX2_NODES,FAKE_REPLACE_NODES,startFakeComfyCloud,type FakeComfyCloud} from "./helpers/fake-comfy-cloud";

/* The cloud character-swap packs: each one compiles, readiness answers for Comfy Cloud and not for
   this computer, and a run goes to the cloud worker through the fake cloud. No real key, no credits
   and no live cloud run: test/helpers/fake-comfy-cloud.ts answers instead. */

const origin="http://localhost:5173",fakeKey="fake-key-not-real";
const PACKS=["cloud-h3-character-swap","cloud-kling-omni-edit","cloud-seedance2-reference"] as const;
const MAIN_NODE:Record<string,string>={
  "cloud-h3-character-swap":"MiniMaxH3ReferenceToVideo",
  "cloud-kling-omni-edit":"KlingOmniProEditVideoNode",
  "cloud-seedance2-reference":"ByteDance2ReferenceNodeV2",
};
const cloudNodes=[...FAKE_FLUX2_NODES,...FAKE_CORE_NODES,...FAKE_REPLACE_NODES];
const localInventory:WorkerInventory={online:true,objectInfoChecked:true,nodes:cloudNodes,models:[],credentials:[],checkedModelFolders:[]};
const freshCloudInventory=()=>cloudInventory({inventory:{...localInventory,modelInventory:"cloud"},checked_at:new Date()});

const loadCatalogue=()=>loadServerCatalogue({log:()=>{}});
function bundleOf(list:CapabilityBundle[],id:string){const bundle=list.find(candidate=>candidate.manifest.id===id);if(!bundle)throw new Error(`The catalogue has no ${id}`);return bundle;}
const cloudRun=(bundle:CapabilityBundle)=>({capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"cloud",inputs:{source_video:"comfyfield-source.mp4",character_image:"comfyfield-character.png"},controls:{prompt:"Change the person into the character in the picture."},audioPolicy:"mute" as const});

describe("cloud character-swap packs compile for Comfy Cloud",()=>{
  it("compiles every pack against its cloud route",async()=>{
    const list=await loadCatalogue();
    for(const id of PACKS){
      const bundle=bundleOf(list,id),manifest=bundle.manifest;
      expect(manifest.routes.map(route=>route.execution),id).toEqual(["comfy_cloud"]);
      const graph=compileLocal(bundle,cloudRun(bundle));
      const classes=Object.values(graph).map(node=>node.class_type);
      expect(classes,id).toContain(MAIN_NODE[id]);
      expect(classes,id).toContain("SaveVideo");
      // The server put the uploaded names in the graph; the browser never chooses a path.
      expect(Object.values(graph).find(node=>node.class_type==="LoadVideo")?.inputs.file).toBe("comfyfield-source.mp4");
      expect(Object.values(graph).find(node=>node.class_type==="LoadImage")?.inputs.image).toBe("comfyfield-character.png");
    }
  });

  it("keeps the local route unavailable",async()=>{
    const bundle=bundleOf(await loadCatalogue(),"cloud-h3-character-swap");
    expect(()=>compileLocal(bundle,{...cloudRun(bundle),routeId:"local"})).toThrow("Selected route is unavailable");
  });
});

/* Comfy Cloud keeps no ComfyUI input folder: `/api/upload/image` is a 404 there, so an input has to
   be uploaded as a Cloud asset and named in the graph by its core/ASSET reference. This is the step
   the first real run stopped at. */
describe("a Comfy Cloud input is an asset, not a file in an input folder",()=>{
  let dir:string,fake:FakeComfyCloud,bundle:CapabilityBundle,video:string,image:string;
  const saved={key:process.env.COMFY_CLOUD_API_KEY};

  beforeAll(async()=>{
    dir=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-inputs-");
    video=`${dir}/clip.mp4`;image=`${dir}/character.jpg`;
    await writeFile(video,Buffer.from("fake clip bytes"));
    await writeFile(image,await readFile("fixtures/real/product-mug-white.jpg"));
    fake=await startFakeComfyCloud({key:fakeKey,image:await readFile("fixtures/real/product-mug-white.jpg"),nodes:cloudNodes});
    process.env.COMFY_CLOUD_API_KEY=fakeKey;
    bundle=bundleOf(await loadCatalogue(),"cloud-h3-character-swap");
  });

  afterAll(async()=>{
    await fake?.close();
    if(saved.key===undefined)delete process.env.COMFY_CLOUD_API_KEY;else process.env.COMFY_CLOUD_API_KEY=saved.key;
  });

  it("uploads each input as an asset and puts its reference in the graph",async()=>{
    const files=[{role:"source_video",filename:"comfyfield-clip.mp4",contentType:"video/mp4",path:video},
      {role:"character_image",filename:"comfyfield-character.jpg",contentType:"image/jpeg",path:image}];
    const graph=compileLocal(bundle,cloudRun(bundle));
    const client=sdkClient({origin:fake.url,kind:"cloud"});
    const ids=await cloudInputs(client,bundle.manifest,graph,files);

    expect(Object.keys(ids)).toEqual(["source_video","character_image"]);
    expect(ids.source_video).toMatch(/^fake-input-/);
    expect(fake.inputs.map(entry=>[entry.filePath,entry.contentType])).toEqual([["comfyfield-clip.mp4","video/mp4"],["comfyfield-character.jpg","image/jpeg"]]);

    const job=await client.submit(client.workflows.fromJson(graph));
    expect(job.id).toMatch(/^fake-job-/);
    const submitted=fake.requests.filter(request=>request.method==="POST"&&request.path==="/api/v2/jobs");
    expect(submitted).toHaveLength(1);
    const sent=JSON.parse(submitted[0]!.body).workflow as Record<string,{class_type:string;inputs:Record<string,unknown>}>;
    for(const [node,field,role] of [["1","file","source_video"],["2","image","character_image"]] as const){
      expect(sent[node].inputs[field],role).toEqual({__type:"core/ASSET",info:{id:ids[role],hash:expect.stringMatching(/^blake3:/),file_path:files.find(file=>file.role===role)!.filename}});
    }
  });

  it("never sends an input to ComfyUI's upload route",()=>{
    const multipart=fake.requests.filter(request=>request.path==="/api/upload/image"&&/multipart\/form-data/.test(String(request.headers["content-type"]??"")));
    expect(multipart).toHaveLength(0);
  });

  it("answers with the real cloud's 404 when a caller still uses that route",async()=>{
    const refused=await fetch(`${fake.url}/api/upload/image`,{method:"POST",headers:{authorization:`Bearer ${fakeKey}`},body:"x"});
    expect(refused.status).toBe(404);
  });

  it("gives a run the cloud's own reason, with its status and never the key",()=>{
    const error=Object.assign(new Error("API key authentication is not available for free tier accounts"),{httpStatus:403});
    expect(sdkFailureReason(error)).toBe("API key authentication is not available for free tier accounts (HTTP 403)");
    expect(sdkFailureReason(error)).not.toContain(fakeKey);
    expect(sdkFailureReason(new Error("  "))).toBe("Comfy Cloud did not say why");
  });
});

describe("readiness tells Comfy Cloud and this computer apart",()=>{
  it("is ready on a cloud worker that has the nodes",async()=>{
    const list=await loadCatalogue();
    for(const id of PACKS)expect(capabilityReadiness(bundleOf(list,id).manifest,"cloud",freshCloudInventory()),id).toMatchObject({state:"ready",reasons:[]});
  });

  it("asks for the cloud on this computer instead of calling the route unimplemented",async()=>{
    const list=await loadCatalogue();
    const manifest=bundleOf(list,PACKS[0]).manifest;
    expect(capabilityReadiness(manifest,"cloud",localInventory)).toMatchObject({state:"unsupported",reasons:[CLOUD_ONLY_REASON]});
    // The panel asks about the local route first: a cloud-only pack answers where it runs.
    expect(capabilityReadiness(manifest,"local",localInventory).reasons).toEqual([CLOUD_ONLY_REASON]);
  });

  it("names the SCAIL-2 node Comfy Cloud lacks in plain words",async()=>{
    const scail=bundleOf(await loadCatalogue(),"scail2-character-replace");
    expect(scail.manifest.routes.map(route=>route.id)).toEqual(["local","cloud"]);
    const readiness=capabilityReadiness(scail.manifest,"cloud",cloudInventory({inventory:{online:true,objectInfoChecked:true,nodes:["WanSCAILToVideo","SCAIL2ColoredMask"],models:[],credentials:[],modelInventory:"cloud"},checked_at:new Date()}));
    expect(readiness.state).toBe("install_required");
    expect(readiness.reasons).toContain("Comfy Cloud does not have SAM3_VideoTrack. Run this workflow on this computer instead.");
    // On this computer the SCAIL-2 route is judged by installed nodes and models, as before.
    expect(capabilityReadiness(scail.manifest,"local",localInventory).state).not.toBe("ready");
  });

  it("says a key that may not submit can run no cloud pack",async()=>{
    const list=await loadCatalogue();
    /* Every pack with a cloud route, asked about that route on a worker whose key is refused. */
    const cloudPacks=list.filter(bundle=>bundle.manifest.routes.some(route=>route.execution==="comfy_cloud"));
    expect(cloudPacks.map(bundle=>bundle.manifest.id)).toEqual(expect.arrayContaining([...PACKS,"scail2-character-replace"]));
    for(const bundle of cloudPacks)
      expect(cloudReadiness(bundle.manifest,"cloud",{...freshCloudInventory(),canSubmit:false,submitBlockedReason:"API key authentication is not available for free tier accounts"}),bundle.manifest.id)
        .toEqual({state:"unsupported",reasons:[CLOUD_PLAN_BLOCKED_REASON],missing:[]});
    // A key that may submit, and a worker probed before the question was asked, are unchanged.
    expect(cloudReadiness(bundleOf(list,PACKS[0]).manifest,"cloud",freshCloudInventory()).state).toBe("ready");
    expect(cloudReadiness(bundleOf(list,PACKS[0]).manifest,"cloud",{...freshCloudInventory(),canSubmit:true}).state).toBe("ready");
  });
});

/* A free-tier Comfy Cloud account reads, uploads and probes fine, and has every submitted run
   refused with a 403. The probe asks the key's own account with a submit no plan can turn into a
   job, so the worker can be recorded as unable to submit before the user picks it. */
describe("the worker probe asks whether the key may submit at all",()=>{
  let fake:FakeComfyCloud;
  const saved={key:process.env.COMFY_CLOUD_API_KEY};
  const probe=(fakeUrl:string,previous?:WorkerInventory)=>probeWorker({query:vi.fn().mockResolvedValue({rows:[]})} as unknown as Pool,[],{id:"w",workspace_id:"ws",origin:fakeUrl,api_prefix:"/api",kind:"cloud",inventory:previous});

  afterEach(()=>{if(saved.key===undefined)delete process.env.COMFY_CLOUD_API_KEY;else process.env.COMFY_CLOUD_API_KEY=saved.key;});
  afterAll(async()=>{await fake?.close();});

  it("records a free-tier key as unable to submit, with the cloud's reason, and makes no job",async()=>{
    fake=await startFakeComfyCloud({key:fakeKey,image:await readFile("fixtures/real/product-mug-white.jpg"),nodes:cloudNodes,submitAccess:"free_tier"});
    process.env.COMFY_CLOUD_API_KEY=fakeKey;
    const inventory=await probe(fake.url);
    expect(inventory.nodes.length).toBeGreaterThan(0);
    expect(inventory).toMatchObject({online:true,modelInventory:"cloud",canSubmit:false,submitBlockedReason:"API key authentication is not available for free tier accounts"});
    const asked=fake.requests.filter(request=>request.path==="/api/prompt");
    expect(asked).toHaveLength(1);
    // The smallest graph Cloud validates, so the plan check is what answers, not graph validation.
    expect(JSON.parse(asked[0]!.body)).toEqual({prompt:{"1":{class_type:"PrimitiveString",inputs:{value:"ping"}},"2":{class_type:"PreviewAny",inputs:{source:["1",0]}}}});
    expect(fake.jobCount()).toBe(0);
  });

  it("keeps the recorded answer when the probe cannot ask",async()=>{
    process.env.COMFY_CLOUD_API_KEY=fakeKey;
    // A worker that went quiet keeps what the last probe found about the key.
    const inventory=await probe("http://127.0.0.1:9",{online:true,nodes:[],models:[],credentials:[],canSubmit:false,submitBlockedReason:"API key authentication is not available for free tier accounts"} as WorkerInventory&{canSubmit:false;submitBlockedReason:string});
    expect(inventory.canSubmit).toBe(false);
    expect(inventory.submitBlockedReason).toBe("API key authentication is not available for free tier accounts");
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("a cloud run is submitted to the Comfy Cloud worker",()=>{
  const schema=`cf_cloud_replace_${randomUUID().replaceAll("-","")}`;
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,workspace:string,cookie:string,projectId:string,cloudWorkerId:string,localWorkerId:string,owner:string;
  let fake:FakeComfyCloud;
  const savedEnv={key:process.env.COMFY_CLOUD_API_KEY,file:process.env.COMFY_CLOUD_API_KEY_FILE};

  async function api(method:"GET"|"POST",tail:string,payload?:unknown){
    return server.app.inject({method,url:`/api/v1/workspaces/${workspace}/${tail}`,headers:{origin,cookie},payload:payload as any});
  }
  async function asset(name:string,media:"video"|"image"):Promise<string>{
    const id=randomUUID(),bytes=media==="image"?await readFile("fixtures/real/product-mug-white.jpg"):Buffer.from("fake test clip bytes");
    const stored=await server.store.put(workspace,Readable.from([bytes]),id);
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[id,workspace,projectId,name,media,media==="image"?"image/jpeg":"video/mp4",stored.key,stored.sha256,stored.bytes,owner]);
    return id;
  }
  const runBody=(capabilityId:string,workerId:string,routeId:string,version:string,inputs:Record<string,string>)=>({projectId,workerId,idempotencyKey:`cloud-replace-${randomUUID()}`,capabilityId,version,routeId,inputs,controls:{prompt:"Change the person into the character in the picture."},audioPolicy:"mute"});

  beforeAll(async()=>{
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    workspace=(await bootstrap(pool,"cloud-replace@fixture.test","Fixture-password-only-123!","Cloud replace")).workspaceId;
    owner=randomUUID();const token=randomBytes(32).toString("hex");
    await pool.query("INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users LIMIT 1",[owner,`${owner}@fixture.test`]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[workspace,owner]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),owner]);
    cookie=`cf_session=${token}`;
    /* The only key this suite uses: a made-up one in a temp file. */
    const keyFile=`${await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-replace-key-")}/key.txt`;await writeFile(keyFile,`${fakeKey}\n`);
    delete process.env.COMFY_CLOUD_API_KEY;process.env.COMFY_CLOUD_API_KEY_FILE=keyFile;
    /* The submit path uploads a cloud worker's inputs as Cloud assets: real Comfy Cloud has no
       ComfyUI input folder, so the fake answers `/api/upload/image` with a 404 like the real one. */
    fake=await startFakeComfyCloud({key:fakeKey,image:await readFile("fixtures/real/product-mug-white.jpg"),nodes:cloudNodes});
    for(const level of ["log","info","warn","error","debug"] as const)vi.spyOn(console,level).mockImplementation(()=>{});
    server=await buildServer({databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot:await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-replace-store-"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:8*1024*1024,cookieSecure:false,comfyCloudApiKey:comfyCloudKey({COMFY_CLOUD_API_KEY_FILE:keyFile})},pool);
    await server.app.ready();
    projectId=(await api("POST","projects",{name:"Cloud replace"})).json().id;
    /* Rows are the narrowest seam the probe and execution read; POST /workers allows only
       https://cloud.comfy.org, and test/cloud-worker.test.ts keeps that guard. The local worker
       points at a closed port so nothing here reaches the fake through the memory guard. */
    cloudWorkerId=randomUUID();localWorkerId=randomUUID();
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,api_prefix,kind,enabled) VALUES($1,$2,'Comfy Cloud fake',$3,'/api','cloud',true)",[cloudWorkerId,workspace,fake.url]);
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,api_prefix,kind,enabled) VALUES($1,$2,'This computer','http://127.0.0.1:9','/api','local',true)",[localWorkerId,workspace]);
    const probed=await api("POST",`workers/${cloudWorkerId}/probe`);
    expect(probed.statusCode,probed.body).toBe(200);
  });

  afterAll(async()=>{
    vi.restoreAllMocks();
    if(fake)await fake.close();
    if(server){await Promise.all([server.execution.close(),server.storyboards.close(),server.workerMonitor.close()]);await server.app.close();}
    await pool?.end();
    if(savedEnv.key===undefined)delete process.env.COMFY_CLOUD_API_KEY;else process.env.COMFY_CLOUD_API_KEY=savedEnv.key;
    if(savedEnv.file===undefined)delete process.env.COMFY_CLOUD_API_KEY_FILE;else process.env.COMFY_CLOUD_API_KEY_FILE=savedEnv.file;
    if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
  });

  it("submits each pack to the cloud worker",async()=>{
    const video=await asset("clip.mp4","video"),face=await asset("character.jpg","image");
    const created:string[]=[];
    for(const id of PACKS){
      const response=await api("POST","runs",runBody(id,cloudWorkerId,"cloud","0.1.0",{source_video:video,character_image:face}));
      expect(response.statusCode,response.body).toBe(200);
      const run=response.json();
      expect(run.worker_id).toBe(cloudWorkerId);
      expect(run.route_id).toBe("cloud");
      created.push(run.id);
    }
    await server.execution.tick();
    for(const id of created){
      const run=(await api("GET",`runs/${id}`)).json();
      expect(run.state,run.error).toBe("queued");
      expect(run.transport).toBe("sdk");
      expect(run.remote_id).toMatch(/^fake-job-/);
    }
    // The probe asked on the native prompt call; these are the submits that carry a graph.
    const submitted=fake.requests.filter(request=>request.method==="POST"&&request.path==="/api/v2/jobs"&&Object.keys(JSON.parse(request.body).workflow??{}).length>0);
    expect(submitted).toHaveLength(PACKS.length);
    for(const request of submitted)expect(request.authorized).toBe(true);
    const graphs=submitted.map(request=>JSON.parse(request.body).workflow as Record<string,{class_type:string}>);
    for(const id of PACKS){
      const graph=graphs.find(candidate=>Object.values(candidate).some(node=>node.class_type===MAIN_NODE[id]));
      expect(graph,id).toBeDefined();
      expect(Object.values(graph!).some(node=>node.class_type==="SaveVideo"),id).toBe(true);
    }
    // Every input went up as a Cloud asset, and none to a ComfyUI input folder.
    expect(fake.inputs).toHaveLength(PACKS.length*2);
    expect(fake.requests.some(request=>request.method==="POST"&&request.path==="/api/upload/image")).toBe(false);
    for(const graph of graphs){
      const nodes=Object.values(graph) as Array<{class_type:string;inputs:Record<string,unknown>}>;
      expect(nodes.find(node=>node.class_type==="LoadVideo")?.inputs.file).toMatchObject({__type:"core/ASSET"});
      expect(nodes.find(node=>node.class_type==="LoadImage")?.inputs.image).toMatchObject({__type:"core/ASSET"});
    }
    // The memory guard sends a cloud worker nothing: no stats, no queue, no free.
    expect(fake.requests.some(request=>request.path==="/api/system_stats"||request.path==="/api/queue"||request.path==="/api/free")).toBe(false);
  });

  it("refuses a cloud pack on this computer, and takes the cloud route for a cloud worker",async()=>{
    const video=await asset("clip2.mp4","video"),face=await asset("character2.jpg","image");
    const onComputer=await api("POST","runs",runBody("cloud-kling-omni-edit",localWorkerId,"cloud","0.1.0",{source_video:video,character_image:face}));
    expect(onComputer.statusCode,onComputer.body).toBe(422);
    expect(onComputer.json().error).toBe(CLOUD_WORKER_REASON);
    /* A panel knows the pack, not the route id: the worker a person picked decides, so the local
       route id a Create panel sends runs the pack's cloud route on the cloud worker. */
    const localRoute=await api("POST","runs",runBody("cloud-kling-omni-edit",cloudWorkerId,"local","0.1.0",{source_video:video,character_image:face}));
    expect(localRoute.statusCode,localRoute.body).toBe(200);
    expect(localRoute.json()).toMatchObject({worker_id:cloudWorkerId,route_id:"cloud"});
  });

  it("refuses a cloud node Comfy Cloud does not have, before any run row",async()=>{
    const body=runBody("scail2-character-replace",cloudWorkerId,"cloud","0.4.0",{});
    const refused=await api("POST","runs",body);
    expect(refused.statusCode,refused.body).toBe(422);
    expect(refused.json().error).toContain("Comfy Cloud does not have SAM3_VideoTrack");
    expect((await pool.query("SELECT id FROM runs WHERE idempotency_key=$1",[body.idempotencyKey])).rowCount).toBe(0);
  });
});
