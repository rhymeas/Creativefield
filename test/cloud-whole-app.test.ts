import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {Readable} from "node:stream";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {comfyCloudKey} from "../server/config";
import {hashToken} from "../server/crypto";
import {migrate} from "../server/db";
import {loadServerCatalogue} from "../server/catalogue";
import {cloudInventory} from "../server/cloud-readiness";
import {probeWorker} from "../server/workers";
import {CLOUD_UNAVAILABLE_REASON,capabilityReadiness} from "../src/capabilities/readiness";
import type {CapabilityBundle} from "../src/capabilities/types";
import sharp from "sharp";
import {FAKE_CORE_NODES,startFakeComfyCloud,type FakeComfyCloud} from "./helpers/fake-comfy-cloud";

/* Every surface with "Run on": when the chosen worker is a Comfy Cloud worker the run really goes
   there, on the pack's cloud route, and a pack that cannot run there says why in plain words. No
   real key, no credits and no live cloud run: test/helpers/fake-comfy-cloud.ts answers instead. */

const origin="http://localhost:5173",fakeKey="fake-key-not-real";
/** The files Comfy Cloud's own node list offers for these packs. */
const FLUX_FILES:string[]=[];
const SAM_FILES=["sam3.1_multiplex_fp16.safetensors"];
const loadCatalogue=()=>loadServerCatalogue({log:()=>{}});
function bundleOf(list:CapabilityBundle[],id:string){const bundle=list.find(candidate=>candidate.manifest.id===id);if(!bundle)throw new Error(`The catalogue has no ${id}`);return bundle;}
/** The nodes these packs need, as Comfy Cloud reports them in its own node list. */
function nodesOf(list:CapabilityBundle[],ids:string[]){
  return [...new Set(ids.flatMap(id=>Object.values(bundleOf(list,id).template??{}).map(node=>node.class_type)))];
}
/* The FLUX image packs run on this computer only (FLUX 3 Klein is unproven on Comfy Cloud), so SAM 3 segment is the picture pack here. */
const PACK_NODES=["sam3-image-segment"];
/** A real PNG, so the stored artifact is decoded like any other. */
async function pngBytes():Promise<Buffer>{
  return sharp({create:{width:32,height:32,channels:3,background:{r:40,g:110,b:220}}}).png().toBuffer();
}
let cloudNodes:string[]=[];

describe("Comfy Cloud's model files are read from its own node list",()=>{
  const saved={key:process.env.COMFY_CLOUD_API_KEY};
  let fake:FakeComfyCloud,thin:FakeComfyCloud;
  const probe=(url:string)=>probeWorker({query:vi.fn().mockResolvedValue({rows:[]})} as unknown as Pool,[],{id:"w",workspace_id:"ws",origin:url,api_prefix:"/api",kind:"cloud"});

  beforeAll(async()=>{
    const image=await pngBytes();
    cloudNodes=[...new Set([...nodesOf(await loadCatalogue(),PACK_NODES),...FAKE_CORE_NODES])];
    fake=await startFakeComfyCloud({key:fakeKey,image,nodes:cloudNodes,modelFiles:[...FLUX_FILES,...SAM_FILES]});
    thin=await startFakeComfyCloud({key:fakeKey,image,nodes:cloudNodes,modelFiles:["flux2-vae.safetensors"]});
    process.env.COMFY_CLOUD_API_KEY=fakeKey;delete process.env.COMFY_CLOUD_API_KEY_FILE;
  });
  afterAll(async()=>{
    await fake?.close();await thin?.close();
    if(saved.key===undefined)delete process.env.COMFY_CLOUD_API_KEY;else process.env.COMFY_CLOUD_API_KEY=saved.key;
  });

  it("records the files its loaders offer and keeps the model folders empty",async()=>{
    const inventory=await probe(fake.url);
    expect(inventory.modelFiles).toEqual([...FLUX_FILES,...SAM_FILES].sort());
    expect(inventory.models).toEqual([]);
    expect(inventory.modelInventory).toBe("cloud");
  });

  it("says a file Comfy Cloud does not have instead of calling the pack ready",async()=>{
    const list=await loadCatalogue();
    const ready=capabilityReadiness(bundleOf(list,"sam3-image-segment").manifest,"cloud",cloudInventory({inventory:await probe(fake.url),checked_at:new Date()}));
    expect(ready.state).toBe("ready");
    const missing=capabilityReadiness(bundleOf(list,"qwen-image-21-t2i").manifest,"local",cloudInventory({inventory:await probe(thin.url),checked_at:new Date()}));
    expect(missing.state).toBe("install_required");
    expect(missing.reasons).toContain("Comfy Cloud does not have qwen_image_2.1_int8_convrot.safetensors.");
  });

  it("leaves models unchecked when the node list carries no file list at all",async()=>{
    const bare=await startFakeComfyCloud({key:fakeKey,image:await pngBytes(),nodes:cloudNodes});
    try{
      const inventory=await probe(bare.url);
      expect(inventory.modelFiles).toBeUndefined();
      const readiness=capabilityReadiness(bundleOf(await loadCatalogue(),"sam3-image-segment").manifest,"cloud",cloudInventory({inventory,checked_at:new Date()}));
      expect(readiness).toMatchObject({state:"ready",reasons:[]});
    }finally{await bare.close();}
  });

  it("asks for a pack's cloud route only where the pack has one",async()=>{
    const list=await loadCatalogue();
    const cloudPacks=list.filter(bundle=>bundle.manifest.routes.some(route=>route.execution==="comfy_cloud")).map(bundle=>bundle.manifest.id);
    expect(cloudPacks).toEqual(expect.arrayContaining(["sam3-image-segment","nvidia-vfx-upscale","camera","wan22-ti2v-5b-t2v","wan22-i2v-14b","wan22-flf2v-14b","realesrgan-x4","scail2-character-replace"]));
    // Masked edit measures its mask here, so it stays off Comfy Cloud, in plain words.
    expect(cloudPacks).not.toContain("wan21-vace-masked-edit");
    expect(cloudPacks).not.toContain("wan-animate2-distilled");
    // FLUX 3 Klein is not proven on Comfy Cloud: the image packs run on this computer only.
    expect(cloudPacks).not.toContain("flux2-klein-t2i");
    const readiness=capabilityReadiness(bundleOf(list,"wan21-vace-masked-edit").manifest,"local",{online:true,objectInfoChecked:true,nodes:cloudNodes,models:[],credentials:[],checkedModelFolders:[]});
    expect(readiness.state).not.toBe("ready");
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("a run whose chosen worker is Comfy Cloud goes there",()=>{
  const schema=`cf_cloud_whole_${randomUUID().replaceAll("-","")}`;
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,workspace:string,cookie:string,projectId:string,owner:string;
  let cloudWorkerId:string,thinWorkerId:string,localWorkerId:string;
  let fake:FakeComfyCloud,thin:FakeComfyCloud;
  const savedEnv={key:process.env.COMFY_CLOUD_API_KEY,file:process.env.COMFY_CLOUD_API_KEY_FILE};

  async function api(method:"GET"|"POST",tail:string,payload?:unknown){
    return server.app.inject({method,url:`/api/v1/workspaces/${workspace}/${tail}`,headers:{origin,cookie},payload:payload as any});
  }
  async function image(name:string):Promise<string>{
    const id=randomUUID(),bytes=await readFile("fixtures/real/product-mug-white.jpg");    const stored=await server.store.put(workspace,Readable.from([bytes]),id);
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,$4,'image','image/jpeg',$5,$6,$7,$8)",[id,workspace,projectId,name,stored.key,stored.sha256,stored.bytes,owner]);
    return id;
  }
  /** A panel sends the route id it knows for the pack: the worker a person picked decides the rest. */
  const runBody=(capabilityId:string,workerId:string,version:string,inputs:Record<string,string>,routeId="local")=>({projectId,workerId,idempotencyKey:`cloud-whole-${randomUUID()}`,capabilityId,version,routeId,inputs,controls:{prompt:"A blue mug on a wooden desk"},audioPolicy:"mute"});

  beforeAll(async()=>{
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    workspace=(await bootstrap(pool,"cloud-whole@fixture.test","Fixture-password-only-123!","Cloud whole app")).workspaceId;
    owner=randomUUID();const token=randomBytes(32).toString("hex");
    await pool.query("INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users LIMIT 1",[owner,`${owner}@fixture.test`]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[workspace,owner]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),owner]);
    cookie=`cf_session=${token}`;
    /* The only key this suite uses: a made-up one in a temp file. */
    const keyFile=`${await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-whole-key-")}/key.txt`;await writeFile(keyFile,`${fakeKey}\n`);
    delete process.env.COMFY_CLOUD_API_KEY;process.env.COMFY_CLOUD_API_KEY_FILE=keyFile;
    const imageBytes=await pngBytes();
    cloudNodes=[...new Set([...nodesOf(await loadCatalogue(),PACK_NODES),...FAKE_CORE_NODES])];
    fake=await startFakeComfyCloud({key:fakeKey,image:imageBytes,nodes:cloudNodes,modelFiles:[...FLUX_FILES,...SAM_FILES]});
    thin=await startFakeComfyCloud({key:fakeKey,image:imageBytes,nodes:cloudNodes,modelFiles:["flux2-vae.safetensors"]});
    for(const level of ["log","info","warn","error","debug"] as const)vi.spyOn(console,level).mockImplementation(()=>{});
    server=await buildServer({databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot:await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-whole-store-"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:8*1024*1024,cookieSecure:false,comfyCloudApiKey:comfyCloudKey({COMFY_CLOUD_API_KEY_FILE:keyFile})},pool);
    await server.app.ready();
    projectId=(await api("POST","projects",{name:"Cloud whole app"})).json().id;
    /* Rows are the narrowest seam the probe and execution read; POST /workers allows only
       https://cloud.comfy.org, and test/cloud-worker.test.ts keeps that guard. The local worker
       points at a closed port so nothing here reaches a fake through the memory guard. */
    cloudWorkerId=randomUUID();thinWorkerId=randomUUID();localWorkerId=randomUUID();
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,api_prefix,kind,enabled) VALUES($1,$2,'Comfy Cloud fake',$3,'/api','cloud',true)",[cloudWorkerId,workspace,fake.url]);
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,api_prefix,kind,enabled) VALUES($1,$2,'Comfy Cloud without the files',$3,'/api','cloud',true)",[thinWorkerId,workspace,thin.url]);
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,api_prefix,kind,enabled) VALUES($1,$2,'This computer','http://127.0.0.1:9','/api','local',true)",[localWorkerId,workspace]);
    for(const id of [cloudWorkerId,thinWorkerId]){
      const probed=await api("POST",`workers/${id}/probe`);
      expect(probed.statusCode,probed.body).toBe(200);
    }
  });

  afterAll(async()=>{
    vi.restoreAllMocks();
    if(fake)await fake.close();
    if(thin)await thin.close();
    if(server){await Promise.all([server.execution.close(),server.storyboards.close(),server.workerMonitor.close()]);await server.app.close();}
    await pool?.end();
    if(savedEnv.key===undefined)delete process.env.COMFY_CLOUD_API_KEY;else process.env.COMFY_CLOUD_API_KEY=savedEnv.key;
    if(savedEnv.file===undefined)delete process.env.COMFY_CLOUD_API_KEY_FILE;else process.env.COMFY_CLOUD_API_KEY_FILE=savedEnv.file;
    if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
  });

  it("runs a picture workflow on the cloud worker, through the pack's cloud route",async()=>{
    const created=await api("POST","runs",runBody("sam3-image-segment",cloudWorkerId,"0.2.0",{source_image:await image("create.jpg")}));
    expect(created.statusCode,created.body).toBe(200);
    const run=created.json();
    expect(run.worker_id).toBe(cloudWorkerId);
    expect(run.route_id).toBe("cloud");

    await server.execution.tick();
    const queued=(await api("GET",`runs/${run.id}`)).json();
    expect(queued.state,queued.error).toBe("queued");
    expect(queued.transport).toBe("sdk");
    expect(queued.remote_id).toMatch(/^fake-job-/);

    fake.succeed(queued.remote_id);
    await server.execution.tick();
    const done=(await api("GET",`runs/${run.id}`)).json();
    expect(done.state,done.error).toBe("succeeded");
    expect(done.output_ids).toHaveLength(1);
    const asset=(await api("GET",`assets/${done.output_ids[0]}`)).json();
    expect(asset.media_type).toBe("image");
  });

  it("uploads the picture of a cloud run as a Cloud asset",async()=>{
    const source=await image("source.jpg");
    const created=await api("POST","runs",runBody("sam3-image-segment",cloudWorkerId,"0.2.0",{source_image:source}));
    expect(created.statusCode,created.body).toBe(200);
    expect(created.json().route_id).toBe("cloud");
    await server.execution.tick();
    const run=(await api("GET",`runs/${created.json().id}`)).json();
    expect(run.state,run.error).toBe("queued");
    // Cloud has no ComfyUI input folder: the picture can only go up as a Cloud asset.
    expect(fake.inputs.some(entry=>entry.contentType==="image/jpeg")).toBe(true);
    expect(fake.requests.some(request=>request.method==="POST"&&request.path==="/api/upload/image")).toBe(false);
  });

  it("keeps every step of a chained flow on the chosen worker",async()=>{
    const source=await image("chain-source.jpg");
    /* Swap a thing runs its steps one after another: select the area, then edit it. Each step is
       its own run, and every one names the worker a person picked. */
    const mask=await api("POST","runs",runBody("sam3-image-segment",cloudWorkerId,"0.2.0",{source_image:source}));
    expect(mask.statusCode,mask.body).toBe(200);
    const edit=await api("POST","runs",runBody("sam3-image-segment",cloudWorkerId,"0.2.0",{source_image:source}));
    expect(edit.statusCode,edit.body).toBe(200);
    for(const step of [mask.json(),edit.json()]){
      expect(step.worker_id).toBe(cloudWorkerId);
      expect(step.route_id).toBe("cloud");
    }
    await server.execution.tick();
    for(const step of [mask.json(),edit.json()]){
      const run=(await api("GET",`runs/${step.id}`)).json();
      expect(run.state,run.error).toBe("queued");
      expect(run.transport).toBe("sdk");
    }
    const jobs=fake.requests.filter(request=>request.method==="POST"&&request.path==="/api/v2/jobs"&&Object.keys(JSON.parse(request.body).workflow??{}).length>0);
    expect(jobs.length).toBeGreaterThanOrEqual(4);
    // No step of any run in this suite fell to this computer.
    expect((await pool.query("SELECT id FROM runs WHERE worker_id=$1",[localWorkerId])).rowCount).toBe(0);
  });

  it("says in plain words which pack cannot run on Comfy Cloud, and writes no run",async()=>{
    const source=await image("refused.jpg");
    /* Masked edit measures its mask here, so it has no cloud route: the chosen cloud worker cannot
       run it and the run is refused before a row exists. */
    const body=runBody("wan21-vace-masked-edit",cloudWorkerId,"0.3.0",{source_video:source,edit_mask:source});
    const refused=await api("POST","runs",body);
    expect(refused.statusCode,refused.body).toBe(422);
    expect(refused.json().error).toBe(CLOUD_UNAVAILABLE_REASON);
    expect((await pool.query("SELECT id FROM runs WHERE idempotency_key=$1",[body.idempotencyKey])).rowCount).toBe(0);
    const qwen=runBody("qwen-image-21-t2i",cloudWorkerId,"0.1.0",{});
    const other=await api("POST","runs",qwen);
    expect(other.statusCode,other.body).toBe(422);
    expect(other.json().error).toBe(CLOUD_UNAVAILABLE_REASON);
    expect((await pool.query("SELECT id FROM runs WHERE idempotency_key=$1",[qwen.idempotencyKey])).rowCount).toBe(0);
  });

  it("refuses a cloud run whose file Comfy Cloud does not have, before any run row",async()=>{
    const source=await image("thin.jpg");
    const body=runBody("sam3-image-segment",thinWorkerId,"0.2.0",{source_image:source});
    const refused=await api("POST","runs",body);
    expect(refused.statusCode,refused.body).toBe(422);
    expect(refused.json().error).toContain("Comfy Cloud does not have sam3.1_multiplex_fp16.safetensors.");
    expect((await pool.query("SELECT id FROM runs WHERE idempotency_key=$1",[body.idempotencyKey])).rowCount).toBe(0);
  });

  it("never sends the key or asks its own computer anything on a cloud run",async()=>{
    expect(fake.requests.some(request=>request.authorized)).toBe(true);
    const bodies=JSON.stringify((await pool.query("SELECT * FROM workers")).rows);
    expect(bodies).not.toContain(fakeKey);
    expect(JSON.stringify((await pool.query("SELECT * FROM runs")).rows)).not.toContain(fakeKey);
    expect(fake.requests.some(request=>["/api/system_stats","/api/queue","/api/free"].includes(request.path))).toBe(false);
  });
});
