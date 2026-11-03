import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp} from "node:fs/promises";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {CLOUD_KEY_REFUSED_REASON} from "../server/cloud-account";
import {CLOUD_KEY_REASON,CLOUD_PLAN_BLOCKED_REASON} from "../server/cloud-readiness";
import {hashToken} from "../server/crypto";
import {migrate} from "../server/db";
import {startFakeComfyCloud,type FakeComfyCloud} from "./helpers/fake-comfy-cloud";

/* Who is behind the Comfy Cloud key: the name, email, workspace and credits Comfy's own user
   menu shows. Read against a fake cloud, never the live one: no job and no credits. */

const origin="http://localhost:5173",fakeKey="fake-cloud-key-for-account-tests";
const freeTier="API key authentication is not available for free tier accounts";
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");
const config=(storageRoot:string,comfyCloudApiKey?:string)=>({databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot,masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false,...(comfyCloudApiKey?{comfyCloudApiKey}:{})});
type Server=Awaited<ReturnType<typeof buildServer>>;
type Account={connected:boolean;name?:string;email?:string;avatarUrl?:string;workspace?:string;credits?:number;canSubmit?:boolean;reason?:string;addCreditsUrl?:string};

describe.skipIf(!process.env.TEST_DATABASE_URL)("the Comfy account behind the cloud key",()=>{
  const schema=`cf_cloud_account_${randomUUID().replaceAll("-","")}`;
  const savedBase=process.env.COMFY_CLOUD_ACCOUNT_API;
  let root:Pool,pool:Pool,server:Server,otherServer:Server,workspace:string,emptyWorkspace:string,cookie:string,userId:string;
  let fake:FakeComfyCloud,workerId:string;
  const logs:string[]=[],consoleMocks:{mockRestore:()=>void}[]=[];

  async function accountOf(workspaceId:string,on:Server=server):Promise<{statusCode:number;body:string;json:()=>Account}>{
    const response=await on.app.inject({method:"GET",url:`/api/v1/workspaces/${workspaceId}/cloud-account`,headers:{origin,cookie}});
    return {statusCode:response.statusCode,body:response.body,json:()=>response.json() as Account};
  }
  async function addUser(role:string|null):Promise<{cookie:string;userId:string}>{
    const id=randomUUID(),token=randomBytes(32).toString("hex");
    await pool.query("INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users LIMIT 1",[id,`${id}@fixture.test`]);
    if(role)await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",[workspace,id,role]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),id]);
    return {cookie:`cf_session=${token}`,userId:id};
  }
  async function addWorkspace(name:string):Promise<string>{
    const id=randomUUID();
    await pool.query("INSERT INTO workspaces(id,name) VALUES($1,$2)",[id,name]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[id,userId]);
    return id;
  }
  const accountReads=()=>fake.requests.filter(request=>request.path.startsWith("/customers/")||request.path==="/api/workspaces/current");

  beforeAll(async()=>{
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    workspace=(await bootstrap(pool,"cloud-account@fixture.test","Fixture-password-only-123!","Cloud account")).workspaceId;
    const session=await addUser("admin");cookie=session.cookie;userId=session.userId;
    emptyWorkspace=await addWorkspace("No cloud worker");
    /* The key is a made-up one for a local fake; the account it reports is the fake's own. */
    fake=await startFakeComfyCloud({key:fakeKey,image:png,account:{name:"Fake Person",email:"person@example.test",cents:2000,workspace:"Team Workspace"}});
    process.env.COMFY_CLOUD_ACCOUNT_API=fake.url;
    for(const level of ["log","info","warn","error","debug"] as const)
      consoleMocks.push(vi.spyOn(console,level).mockImplementation((...args:unknown[])=>{logs.push(args.map(arg=>typeof arg==="string"?arg:JSON.stringify(arg)).join(" "));}));
    server=await buildServer(config(await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-account-"),fakeKey),pool);await server.app.ready();
    otherServer=await buildServer(config(await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-account-"),"a-key-comfy-cloud-does-not-know"),pool);await otherServer.app.ready();
    /* POST /workers accepts only https://cloud.comfy.org, so the fake is wired at the row. */
    workerId=randomUUID();
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,api_prefix,kind,enabled,inventory) VALUES($1,$2,'Comfy Cloud fake',$3,'/api','cloud',true,$4)",[workerId,workspace,fake.url,JSON.stringify({online:true,modelInventory:"cloud"})]);
  });

  afterAll(async()=>{
    for(const mock of consoleMocks)mock.mockRestore();
    if(fake)await fake.close();
    for(const instance of [server,otherServer])if(instance){await Promise.all([instance.execution.close(),instance.storyboards.close(),instance.workerMonitor.close()]);await instance.app.close();}
    await pool?.end();
    if(savedBase===undefined)delete process.env.COMFY_CLOUD_ACCOUNT_API;else process.env.COMFY_CLOUD_ACCOUNT_API=savedBase;
    if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
  });

  it("answers nothing for a workspace with no Comfy Cloud worker",async()=>{
    const before=fake.requests.length;
    const body=await accountOf(emptyWorkspace);
    expect(body.statusCode,body.body).toBe(200);
    expect(body.json()).toEqual({connected:false});
    expect(fake.requests.length).toBe(before);
  });

  it("names the Comfy account behind the key, and counts its credits",async()=>{
    const body=await accountOf(workspace);
    expect(body.statusCode,body.body).toBe(200);
    expect(body.json()).toMatchObject({connected:true,name:"Fake Person",email:"person@example.test",workspace:"Team Workspace",credits:4220});
    expect(body.json().addCreditsUrl).toBe(`${fake.url}/?settings=plan-credits`);
    /* 2,000 cents is $20, which Comfy counts as 4,220 credits (211 to the dollar). */
    expect(body.json().credits).toBe(Math.round((2000*211)/100));
  });

  it("gives a picture only to a browser session, so a key leaves it out",async()=>{
    expect((await accountOf(workspace)).json().avatarUrl).toBeUndefined();
  });

  it("sends the key in a header, and never in a URL, a body or a log line",async()=>{
    await accountOf(workspace);
    const reads=accountReads();
    expect(reads.length).toBeGreaterThan(0);
    for(const request of reads){
      expect(request.authorized).toBe(true);
      expect(request.headers["x-api-key"]).toBe(fakeKey);
      expect(request.path).not.toContain(fakeKey);
      expect(request.body).not.toContain(fakeKey);
    }
    expect(reads.some(request=>request.path==="/customers/me")).toBe(true);
    expect(reads.some(request=>request.path==="/customers/balance")).toBe(true);
    expect(reads.some(request=>request.path==="/api/workspaces/current")).toBe(true);
    expect(logs.join("\n")).not.toContain(fakeKey);
  });

  it("keeps the response itself free of the key",async()=>{
    const body=await accountOf(workspace);
    expect(body.body).not.toContain(fakeKey);
    expect(body.body).not.toContain("a-key-comfy-cloud-does-not-know");
  });

  it("asks Comfy Cloud at most once a minute",async()=>{
    const before=accountReads().length;
    await accountOf(workspace);await accountOf(workspace);
    const after=accountReads().length;
    expect(after-before).toBeLessThanOrEqual(1);
    /* Whatever the first look read is reused, so the next look asks nothing. */
    await accountOf(workspace);
    expect(accountReads().length).toBe(after);
  });

  it("says plainly when the plan may not submit runs",async()=>{
    await pool.query("UPDATE workers SET inventory=$1 WHERE id=$2",[JSON.stringify({online:true,modelInventory:"cloud",canSubmit:false,submitBlockedReason:freeTier}),workerId]);
    expect((await accountOf(workspace)).json()).toMatchObject({connected:true,canSubmit:false,reason:freeTier});
    await pool.query("UPDATE workers SET inventory=$1 WHERE id=$2",[JSON.stringify({online:true,modelInventory:"cloud",canSubmit:true}),workerId]);
    const submitting=(await accountOf(workspace)).json();
    expect(submitting).toMatchObject({connected:true,canSubmit:true});
    expect(submitting.reason).toBeUndefined();
  });

  it("falls back to the plan sentence when the probe recorded no reason",async()=>{
    await pool.query("UPDATE workers SET inventory=$1 WHERE id=$2",[JSON.stringify({online:true,modelInventory:"cloud",canSubmit:false}),workerId]);
    expect((await accountOf(workspace)).json().reason).toBe(CLOUD_PLAN_BLOCKED_REASON);
    await pool.query("UPDATE workers SET inventory=$1 WHERE id=$2",[JSON.stringify({online:true,modelInventory:"cloud"}),workerId]);
  });

  it("says a key Comfy Cloud will not take is not connected",async()=>{
    const refused=await accountOf(workspace,otherServer);
    expect(refused.statusCode,refused.body).toBe(200);
    expect(refused.json()).toEqual({connected:false,reason:CLOUD_KEY_REFUSED_REASON});
  });

  it("says this server has no key at all",async()=>{
    const keyless=await buildServer(config(await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-account-")),pool);
    try{
      await keyless.app.ready();
      const none=await accountOf(workspace,keyless);
      expect(none.statusCode,none.body).toBe(200);
      expect(none.json()).toEqual({connected:false,reason:CLOUD_KEY_REASON});
    }finally{
      await Promise.all([keyless.execution.close(),keyless.storyboards.close(),keyless.workerMonitor.close()]);
      await keyless.app.close();
    }
  });

  it("needs no job and spends no credits",()=>{
    expect(fake.jobCount()).toBe(0);
    expect(fake.requests.some(request=>request.method!=="GET")).toBe(false);
    expect(fake.requests.some(request=>request.path==="/api/v2/jobs"||request.path==="/api/prompt")).toBe(false);
  });

  it("lets a viewer see it and refuses someone outside the workspace",async()=>{
    const viewer=await addUser("viewer");
    const seen=await server.app.inject({method:"GET",url:`/api/v1/workspaces/${workspace}/cloud-account`,headers:{origin,cookie:viewer.cookie}});
    expect(seen.statusCode,seen.body).toBe(200);
    expect(seen.json()).toMatchObject({connected:true,name:"Fake Person"});
    const outsider=await addUser(null);
    const refused=await server.app.inject({method:"GET",url:`/api/v1/workspaces/${workspace}/cloud-account`,headers:{origin,cookie:outsider.cookie}});
    expect(refused.statusCode,refused.body).toBe(403);
  });
});
