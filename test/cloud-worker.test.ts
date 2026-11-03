import {afterEach,afterAll,beforeAll,describe,expect,it} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,writeFile} from "node:fs/promises";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {loadServerCatalogue} from "../server/catalogue";
import {CLOUD_PLAN_BLOCKED_REASON} from "../server/cloud-readiness";
import {comfyCloudKey} from "../server/config";
import {hashToken} from "../server/crypto";
import {migrate} from "../server/db";
import {probeSubmitAccess} from "../server/workers";
import {startFakeComfyCloud,type FakeComfyCloud} from "./helpers/fake-comfy-cloud";

const origin="http://localhost:5173",fakeKey="fake-comfy-cloud-key-for-tests";
type Server=Awaited<ReturnType<typeof buildServer>>;

async function tempKeyFile(content:string):Promise<string>{
  const dir=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-key-");
  const file=`${dir}/key.txt`;await writeFile(file,content);return file;
}

describe("the Comfy Cloud key can come from a file",()=>{
  it("reads the key from a file and trims whitespace",async()=>{
    const file=await tempKeyFile(`\n  ${fakeKey}  \n`);
    expect(comfyCloudKey({COMFY_CLOUD_API_KEY_FILE:file})).toBe(fakeKey);
  });
  it("accepts one NAME= prefix on the line",async()=>{
    const file=await tempKeyFile(`COMFY_CLOUD_API_KEY=${fakeKey}\n`);
    expect(comfyCloudKey({COMFY_CLOUD_API_KEY_FILE:file})).toBe(fakeKey);
  });
  it("lets COMFY_CLOUD_API_KEY win when both are set",async()=>{
    const file=await tempKeyFile(fakeKey);
    expect(comfyCloudKey({COMFY_CLOUD_API_KEY:"direct-key",COMFY_CLOUD_API_KEY_FILE:file})).toBe("direct-key");
  });
  it("says missing or empty without echoing the key or its length",async()=>{
    const dir=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-key-");
    expect(()=>comfyCloudKey({COMFY_CLOUD_API_KEY_FILE:`${dir}/absent.txt`})).toThrow("COMFY_CLOUD_API_KEY_FILE is missing");
    const empty=await tempKeyFile(" \n");
    expect(()=>comfyCloudKey({COMFY_CLOUD_API_KEY_FILE:empty})).toThrow("COMFY_CLOUD_API_KEY_FILE is empty");
    const spaced=await tempKeyFile("two words");
    let message="";
    try{comfyCloudKey({COMFY_CLOUD_API_KEY_FILE:spaced});}catch(error){message=(error as Error).message;}
    expect(message).toBe("COMFY_CLOUD_API_KEY_FILE must be one key without spaces");
    expect(message).not.toContain("two");
    expect(message).not.toContain(String(fakeKey.length));
  });
});

/* The submit probe is a real submit, so it asks with the smallest graph Comfy Cloud validates
   (`POST /api/prompt`) and only once an hour for a key. An empty graph is refused by validation
   before the plan check, so a 400 can never be read as permission. */
describe("the submit probe asks with a graph Comfy Cloud can validate",()=>{
  const probed={origin:"",api_prefix:"/api"};
  const saved={key:process.env.COMFY_CLOUD_API_KEY};
  const asked=(fake:FakeComfyCloud)=>fake.requests.filter(request=>request.method==="POST"&&request.path==="/api/prompt");
  const probe=(fakeUrl:string)=>probeSubmitAccess({...probed,origin:fakeUrl});
  afterEach(()=>{if(saved.key===undefined)delete process.env.COMFY_CLOUD_API_KEY;else process.env.COMFY_CLOUD_API_KEY=saved.key;});

  it("submits the smallest valid graph, and makes no job",async()=>{
    const fake=await startFakeComfyCloud({key:fakeKey,image:Buffer.alloc(1)});
    try{
      process.env.COMFY_CLOUD_API_KEY=fakeKey;
      expect(await probe(fake.url)).toEqual({canSubmit:true});
      const sent=asked(fake);
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]!.body)).toEqual({prompt:{"1":{class_type:"PrimitiveString",inputs:{value:"ping"}},"2":{class_type:"PreviewAny",inputs:{source:["1",0]}}}});
      expect(sent[0]!.headers.authorization).toBe(`Bearer ${fakeKey}`);
      expect(fake.jobCount()).toBe(0);
    }finally{await fake.close();}
  });

  it("reads a free-tier refusal with the cloud's own sentence",async()=>{
    const fake=await startFakeComfyCloud({key:fakeKey,image:Buffer.alloc(1),submitAccess:"free_tier"});
    try{
      process.env.COMFY_CLOUD_API_KEY=fakeKey;
      expect(await probe(fake.url)).toEqual({canSubmit:false,submitBlockedReason:"API key authentication is not available for free tier accounts"});
      expect(fake.jobCount()).toBe(0);
    }finally{await fake.close();}
  });

  it("asks a key at most once an hour, however often a worker is probed",async()=>{
    const fake=await startFakeComfyCloud({key:fakeKey,image:Buffer.alloc(1)});
    try{
      process.env.COMFY_CLOUD_API_KEY=fakeKey;
      expect(await probe(fake.url)).toEqual({canSubmit:true});
      expect(await probe(fake.url)).toEqual({canSubmit:true});
      expect(asked(fake)).toHaveLength(1);
    }finally{await fake.close();}
  });

  it("does not read a 400 about the graph as permission",async()=>{
    // The live service validates the graph before it checks the plan, so its 400 proves nothing.
    const fake=await startFakeComfyCloud({key:fakeKey,image:Buffer.alloc(1),submitAccess:"graph_refused"});
    try{
      process.env.COMFY_CLOUD_API_KEY=fakeKey;
      expect(await probe(fake.url)).toEqual({});
    }finally{await fake.close();}
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("Comfy Cloud as a worker kind",()=>{
  const schema=`cf_cloud_${randomUUID().replaceAll("-","")}`;
  let root:Pool,pool:Pool,workspace:string,cookie:string,withKey:Server,withoutKey:Server;
  async function boot(env:NodeJS.ProcessEnv){
    const server=await buildServer({databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot:await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-worker-"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false,comfyCloudApiKey:comfyCloudKey(env)},pool);
    await server.app.ready();return server;
  }
  const post=(server:Server,payload:Record<string,unknown>)=>server.app.inject({method:"POST",url:`/api/v1/workspaces/${workspace}/workers`,headers:{origin,cookie},payload});
  const list=(server:Server)=>server.app.inject({method:"GET",url:`/api/v1/workspaces/${workspace}/workers`,headers:{origin,cookie}});
  /** A fake Comfy Cloud listing what one cloud-only pack needs. Rows are the narrowest seam: the
   *  workers table allows only https://cloud.comfy.org through POST /workers. */
  async function cloudFake(options:{submitAccess?:"allowed"|"free_tier"}={}){
    const catalogue=await loadServerCatalogue({log:()=>{}});
    const pack=catalogue.find(bundle=>bundle.manifest.id==="cloud-h3-character-swap");
    if(!pack)throw new Error("The catalogue has no cloud-h3-character-swap");
    const route=pack.manifest.routes.find(candidate=>candidate.execution==="comfy_cloud");
    const fake=await startFakeComfyCloud({key:fakeKey,image:Buffer.alloc(1),
      nodes:[...new Set(Object.values(pack.template??{}).map(node=>node.class_type))],
      modelFiles:route?.requirements.filter(item=>item.kind==="model").map(item=>item.name),
      ...(options.submitAccess?{submitAccess:options.submitAccess}:{})});
    return {catalogue,fake};
  }
  /** Probe a cloud worker that points at the fake. */
  async function probeFake(server:Server,url:string){
    const id=randomUUID();
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,api_prefix,kind) VALUES($1,$2,'Probed',$3,'/api','cloud')",[id,workspace,url]);
    return server.app.inject({method:"POST",url:`/api/v1/workspaces/${workspace}/workers/${id}/probe`,headers:{origin,cookie}});
  }
  /** Run the probe with a key the fake accepts, then put the environment back. */
  async function withCloudKey<T>(run:()=>Promise<T>):Promise<T>{
    const saved=process.env.COMFY_CLOUD_API_KEY;
    process.env.COMFY_CLOUD_API_KEY=fakeKey;
    try{return await run();}finally{
      if(saved===undefined)delete process.env.COMFY_CLOUD_API_KEY;else process.env.COMFY_CLOUD_API_KEY=saved;
    }
  }
  type Capabilities={id:string;readiness:{state:string;reasons:string[];missing:unknown[]}}[];
  beforeAll(async()=>{
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    workspace=(await bootstrap(pool,"cloud@fixture.test","Fixture-password-only-123!","Cloud")).workspaceId;
    const user=randomUUID(),token=randomBytes(32).toString("hex");
    await pool.query("INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users LIMIT 1",[user,`${user}@fixture.test`]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[workspace,user]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),user]);
    cookie=`cf_session=${token}`;withKey=await boot({COMFY_CLOUD_API_KEY_FILE:await tempKeyFile(fakeKey)});withoutKey=await boot({});
  });
  afterAll(async()=>{
    for(const server of [withKey,withoutKey])if(server){await Promise.all([server.execution.close(),server.storyboards.close(),server.workerMonitor.close()]);await server.app.close();}
    await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
  });
  it("reads the key from the environment and never stores it",()=>{
    expect(comfyCloudKey({COMFY_CLOUD_API_KEY:` ${fakeKey} `})).toBe(fakeKey);
    expect(comfyCloudKey({})).toBeUndefined();
    expect(()=>comfyCloudKey({COMFY_CLOUD_API_KEY:"two words"})).toThrow("without spaces");
  });
  it("refuses a Comfy Cloud worker when the key is unset",async()=>{
    const refused=await post(withoutKey,{name:"Comfy Cloud",origin:"https://cloud.comfy.org",kind:"cloud",apiPrefix:"/api"});
    expect(refused.statusCode,refused.body).toBe(400);
    expect(refused.json().error).toBe("Set COMFY_CLOUD_API_KEY or COMFY_CLOUD_API_KEY_FILE before adding a Comfy Cloud worker");
    expect((await pool.query("SELECT id FROM workers WHERE origin='https://cloud.comfy.org'")).rowCount).toBe(0);
  });
  it("adds a Comfy Cloud worker with the key and reports its kind",async()=>{
    const added=await post(withKey,{name:"Comfy Cloud",origin:"https://cloud.comfy.org",kind:"cloud",apiPrefix:"/api"});
    expect(added.statusCode,added.body).toBe(200);expect(added.json()).toMatchObject({origin:"https://cloud.comfy.org",kind:"cloud"});
    const row=(await pool.query("SELECT * FROM workers WHERE id=$1",[added.json().id])).rows[0];
    expect(row.kind).toBe("cloud");expect(row.api_prefix).toBe("/api");expect(JSON.stringify(row)).not.toContain(fakeKey);
    const listed=(await list(withKey)).json() as {id:string;kind:string}[];
    expect(listed.find(worker=>worker.id===row.id)?.kind).toBe("cloud");expect(JSON.stringify(listed)).not.toContain(fakeKey);
  });
  it("refuses a Comfy Cloud worker that points somewhere else",async()=>{
    const elsewhere=await post(withKey,{name:"Elsewhere",origin:"http://127.0.0.1:8199",kind:"cloud",apiPrefix:"/api"});
    expect(elsewhere.statusCode,elsewhere.body).toBe(400);
    expect(elsewhere.json().error).toBe("Comfy Cloud workers use https://cloud.comfy.org with the /api prefix");
    const noPrefix=await post(withKey,{name:"No prefix",origin:"https://cloud.comfy.org",kind:"cloud",apiPrefix:""});
    expect(noPrefix.statusCode,noPrefix.body).toBe(400);
    expect((await pool.query("SELECT id FROM workers")).rowCount).toBe(1);
  });
  it("keeps a local worker local without any key",async()=>{
    const added=await post(withoutKey,{name:"This computer",origin:"http://127.0.0.1:8199",apiPrefix:""});
    expect(added.statusCode,added.body).toBe(200);expect(added.json().kind).toBe("local");
    const legacy=randomUUID();await pool.query("INSERT INTO workers(id,workspace_id,name,origin) VALUES($1,$2,'Legacy',$3)",[legacy,workspace,`http://worker-${legacy}.test`]);
    expect((await pool.query("SELECT kind FROM workers WHERE id=$1",[legacy])).rows[0].kind).toBe("local");
    const listed=(await list(withoutKey)).json() as {id:string;kind:string}[];
    expect(listed.find(worker=>worker.id===added.json().id)?.kind).toBe("local");
    expect(JSON.stringify(listed)).not.toContain(fakeKey);
  });
  /* What the probe answers, which is what the app decides: a cloud worker is judged on the pack's
     own cloud route, and on its key's plan. */
  it("judges a cloud worker on the pack's cloud route, not on this computer",async()=>{
    const {fake}=await cloudFake();
    try{
      const probed=await withCloudKey(()=>probeFake(withKey,fake.url));
      expect(probed.statusCode,probed.body).toBe(200);
      const capabilities=probed.json().capabilities as Capabilities;
      /* A cloud-only pack reads ready here only through its cloud route: asked about the local one
         it would say to pick Comfy Cloud, on a Comfy Cloud worker. */
      expect(capabilities.find(entry=>entry.id==="cloud-h3-character-swap")?.readiness,probed.body).toMatchObject({state:"ready",reasons:[]});
    }finally{await fake.close();}
  });
  it("gives every cloud pack the plan when the key may not submit, and leaves a local pack alone",async()=>{
    const {catalogue,fake}=await cloudFake({submitAccess:"free_tier"});
    try{
      const probed=await withCloudKey(()=>probeFake(withKey,fake.url));
      expect(probed.statusCode,probed.body).toBe(200);
      const capabilities=probed.json().capabilities as Capabilities;
      const hasCloudRoute=(bundle:typeof catalogue[number])=>bundle.manifest.routes.some(route=>route.execution==="comfy_cloud");
      const cloudPacks=catalogue.filter(hasCloudRoute).map(bundle=>bundle.manifest.id);
      expect(cloudPacks.length).toBeGreaterThan(0);
      for(const id of cloudPacks)expect(capabilities.find(entry=>entry.id===id)?.readiness,id)
        .toMatchObject({state:"unsupported",reasons:[CLOUD_PLAN_BLOCKED_REASON],missing:[]});
      const localPacks=catalogue.filter(bundle=>!hasCloudRoute(bundle)).map(bundle=>bundle.manifest.id);
      expect(localPacks.length).toBeGreaterThan(0);
      for(const id of localPacks)expect(capabilities.find(entry=>entry.id===id)?.readiness.reasons,id).not.toContain(CLOUD_PLAN_BLOCKED_REASON);
    }finally{await fake.close();}
  });
});
