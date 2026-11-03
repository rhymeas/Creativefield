import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Pool} from "pg";
import type {PoolClient} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp} from "node:fs/promises";
import {buildServer} from "../server/app";
import {bootstrap,HttpError} from "../server/auth";
import {loadServerCatalogue} from "../server/catalogue";
import {comfyCloudKey} from "../server/config";
import {hashToken} from "../server/crypto";
import {migrate} from "../server/db";
import {prepareInvocation,type RunRequest} from "../server/run-submission";
import type {CapabilityBundle} from "../src/capabilities/types";

const origin="http://localhost:5173",fakeKey="fake-comfy-cloud-key-for-tests";
const needsOwnComputer="This one needs your own computer. Pick This computer to run it.";
type Server=Awaited<ReturnType<typeof buildServer>>;

/** A worker that claims a complete inventory, so only the cloud rule can refuse a run. */
const readyInventory={online:true,nodes:[],models:[],credentials:[],objectInfoChecked:true,checkedModelFolders:[]};
function fakeClient(worker:Record<string,unknown>){
  const statements:string[]=[];
  const client={query:async(sql:string)=>{
    statements.push(sql);
    if(sql.includes("FROM projects"))return{rowCount:1,rows:[{id:randomUUID()}]};
    if(sql.includes("FROM workers"))return{rowCount:1,rows:[{checked_at:new Date().toISOString(),inventory:readyInventory,...worker}]};
    return{rowCount:0,rows:[]};
  }};
  return{client:client as unknown as PoolClient,statements};
}
function requestFor(bundle:CapabilityBundle,workerId:string):RunRequest{
  return{projectId:randomUUID(),workerId,idempotencyKey:`cloud-refuse-${randomUUID()}`,capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{},controls:{},audioPolicy:"mute"};
}
async function refusal(catalogue:CapabilityBundle[],capabilityId:string,worker:Record<string,unknown>){
  const bundle=catalogue.find(candidate=>candidate.manifest.id===capabilityId);
  if(!bundle)throw new Error(`Missing capability ${capabilityId}`);
  const {client,statements}=fakeClient(worker);
  try{await prepareInvocation(client,catalogue,randomUUID(),requestFor(bundle,randomUUID()));return{error:null as unknown,statements};}
  catch(error){return{error,statements};}
}

describe("a cloud worker refuses workflows that need this computer",()=>{
  let catalogue:CapabilityBundle[];
  beforeAll(async()=>{catalogue=await loadServerCatalogue();});
  const cloud={kind:"cloud"},local={kind:"local"};

  it.each(["sam31-video-mask","wan21-vace-masked-edit","flux2-klein-preserve-edit"])("refuses %s before any run row exists",async capabilityId=>{
    const {error,statements}=await refusal(catalogue,capabilityId,cloud);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(422);
    expect((error as HttpError).message).toBe(needsOwnComputer);
    expect(statements.filter(sql=>sql.includes("INSERT INTO runs"))).toEqual([]);
  });

  it("still admits a plain picture workflow on the cloud worker",async()=>{
    const {error,statements}=await refusal(catalogue,"sam3-image-segment",cloud);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).message).not.toBe(needsOwnComputer);
    expect(statements.filter(sql=>sql.includes("INSERT INTO runs"))).toEqual([]);
  });

  it("lets the same workflow reach the local worker",async()=>{
    const {error}=await refusal(catalogue,"sam31-video-mask",local);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).message).not.toBe(needsOwnComputer);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("cloud refusal over HTTP leaves no run behind",()=>{
  const schema=`cf_refuse_${randomUUID().replaceAll("-","")}`;
  let root:Pool,pool:Pool,server:Server,workspace:string,cookie:string,projectId:string,workerId:string;
  async function api(method:"GET"|"POST",tail:string,payload?:unknown){return server.app.inject({method,url:`/api/v1/workspaces/${workspace}/${tail}`,headers:{origin,cookie},payload:payload as any});}
  beforeAll(async()=>{
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    workspace=(await bootstrap(pool,"cloud-refuse@fixture.test","Fixture-password-only-123!","Cloud refuse")).workspaceId;
    const user=randomUUID(),token=randomBytes(32).toString("hex");
    await pool.query("INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users LIMIT 1",[user,`${user}@fixture.test`]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[workspace,user]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),user]);
    cookie=`cf_session=${token}`;
    server=await buildServer({databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot:await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-refuse-"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false,comfyCloudApiKey:comfyCloudKey({COMFY_CLOUD_API_KEY:fakeKey})},pool);
    await server.app.ready();
    projectId=(await api("POST","projects",{name:"Cloud refuse"})).json().id;
    const added=await api("POST","workers",{name:"Comfy Cloud",origin:"https://cloud.comfy.org",kind:"cloud",apiPrefix:"/api"});
    expect(added.statusCode,added.body).toBe(200);workerId=added.json().id;
  });
  afterAll(async()=>{
    if(server){await Promise.all([server.execution.close(),server.storyboards.close(),server.workerMonitor.close()]);await server.app.close();}
    await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
  });
  it("answers a mask workflow with the plain reason and stores nothing",async()=>{
    const bundle=server.catalogue.find(candidate=>candidate.manifest.id==="sam31-video-mask")!;
    const refused=await api("POST","runs",{projectId,workerId,idempotencyKey:`cloud-refuse-${randomUUID()}`,capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{},controls:{},audioPolicy:"mute"});
    expect(refused.statusCode,refused.body).toBe(422);
    expect(refused.json().error).toBe(needsOwnComputer);
    expect((await pool.query("SELECT state FROM runs")).rowCount).toBe(0);
    expect((await pool.query("SELECT state FROM run_events")).rowCount).toBe(0);
  });
});
