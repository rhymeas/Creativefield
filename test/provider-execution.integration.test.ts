import {beforeAll,afterAll,beforeEach,describe,it,expect} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,readFile,readdir} from "node:fs/promises";
import {Readable} from "node:stream";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import type {ServerConfig} from "../server/config";
import type {CapabilityBundle} from "../src/capabilities/types";
import {DirectRegistry} from "../server/providers/registry";
import {DirectExecutionService} from "../server/providers/execution";
import type {DirectAdapter,DirectBinding,Observation} from "../server/providers/types";

const database=process.env.TEST_DATABASE_URL;
describe.skipIf(!database)("durable direct provider lifecycle (injected fixtures, no external requests)",()=>{
  const schema=`cf_direct_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173",secret="fixture-secret-DO-NOT-EXPOSE",signedUrl="https://media.example.com/clip?signature=DO-NOT-EXPOSE";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,config:ServerConfig,workspaceId:string,projectId:string,cookie:string,video:Buffer;
  let posts=0,uploads=0,cancels=0,polls=0,downloads=0,drop=false,corrupt=false,outage=false,malformed=false,rejected=false,cancelKind="accepted",cancelInSubmit=false,cancelInPrepare=false,rotateInPrepare=false;
  const jobs=new Map<string,{id:string;state:Observation["state"]}>();
  const binding:DirectBinding={capabilityId:"fixture-direct",capabilityVersion:"1",routeId:"direct",adapterId:"fixture",adapterVersion:"1",provider:"wan",model:"fixture-model",upstreamProviders:[],apiOrigins:["https://api.example.com"],artifactOrigins:["https://media.example.com"]};
  const bundle:CapabilityBundle={manifest:{schemaVersion:2,id:binding.capabilityId,version:"1",title:"Fixture",category:"t2v",description:"Test only",inputs:[{id:"image",label:"Reference",type:"image",required:false}],outputs:[{id:"video",label:"Video",type:"video",required:true}],controls:[{id:"prompt",label:"Prompt",type:"string",default:"fixture",apiField:"prompt"},{id:"seed",label:"Seed",type:"integer",default:1,min:0,max:100,apiField:"seed"},{id:"disabled",label:"Unavailable",type:"boolean",disabledReason:"Not implemented"}],presets:[],routes:[{id:"direct",execution:"direct_provider",provider:"wan",upstreamProviders:[],implementation:"implemented",requirements:[],evidence:["injected fixture only"]}],coverage:{local:"planned",hosted:"implemented"},licenses:{software:"test",weights:[]},sources:[],tickets:[],audioPolicies:["mute"]}};
  const adapter:DirectAdapter={id:"fixture",version:"1",provider:"wan",recovery:"lookup",cancellation:"supported",validate:()=>({valid:true}),estimate:async()=>({kind:"unknown"}),
    prepareInputs:async(_inputs,ctx)=>{uploads++;if(cancelInPrepare)await api("POST",`runs/${ctx.requestId}/cancel`);if(rotateInPrepare)await credential();return {};},
    submit:async(_i,_p,ctx)=>{posts++;if(cancelInSubmit)await api("POST",`runs/${ctx.requestId}/cancel`);if(rejected)return {kind:"rejected",code:"rejected"};const id=randomUUID();jobs.set(ctx.requestId,{id,state:"pending"});if(drop)throw new Error(secret+signedUrl);if(malformed)return {kind:"accepted",remoteId:signedUrl};return {kind:"accepted",remoteId:id};},
    poll:async(id)=>{polls++;if(outage)throw new Error(secret+signedUrl);const state=[...jobs.values()].find(j=>j.id===id)!.state;return state==="failed"?{state,code:"rejected"}:{state};},
    cancel:async()=>{cancels++;return {kind:cancelKind as "accepted"};},recover:async ctx=>{const job=jobs.get(ctx.requestId);return job?{kind:"found",remoteId:job.id}:{kind:"unresolved"};},
    outputs:async()=>[{url:signedUrl,mediaType:"video",contentType:"video/mp4"}]};
  const registry=()=>new DirectRegistry([{binding,adapter,qualified:true}]);
  const transportFactory=(_b:DirectBinding,authorization:string)=>{expect(authorization).toBe(`Bearer ${secret}`);return {api:async()=>({}),artifact:async()=>{downloads++;return {body:Readable.from([corrupt?Buffer.from("invalid video"):video]),contentType:"video/mp4"};}};};
  function url(tail:string){return `/api/v1/workspaces/${workspaceId}/${tail}`;}
  async function api(method:"GET"|"POST"|"DELETE",tail:string,payload?:unknown){return server.app.inject({method,url:url(tail),headers:{origin,cookie},payload:payload as any});}
  function invocation(extra:Record<string,unknown>={}){return {projectId,idempotencyKey:randomUUID(),capabilityId:binding.capabilityId,version:"1",routeId:"direct",inputs:{},controls:{prompt:"Fixture scene"},audioPolicy:"mute",...extra};}
  async function enqueue(extra:Record<string,unknown>={}){const r=await api("POST","runs",invocation(extra));expect(r.statusCode,r.body).toBe(200);return r.json();}
  async function run(id:string){return (await api("GET",`runs/${id}`)).json();}
  async function dbRun(id:string){return (await pool.query("SELECT * FROM runs WHERE id=$1",[id])).rows[0];}
  async function due(){await pool.query("UPDATE provider_run_bindings SET next_poll_at=now()-interval '1 second'");}
  async function tick(){await due();await server.directExecution.tick();}
  async function credential(){return api("POST","provider-connections",{providerId:"wan",secret});}
  async function restart(custom=registry()){
    await server?.app.close();server=await buildServer(config,pool,{catalogue:[bundle],registry:custom,transportFactory});await server.app.ready();
  }
  beforeAll(async()=>{
    root=new Pool({connectionString:database});await root.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString:database,options:`-c search_path=${schema}`});await migrate(pool);
    config={databaseUrl:database!,storageRoot:await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/direct-test-"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false};
    workspaceId=(await bootstrap(pool,"direct@example.test","Fixture-password-long-27!","Direct tests")).workspaceId;
    await restart();
    const login=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"direct@example.test",password:"Fixture-password-long-27!"}});cookie=String(login.headers["set-cookie"]).split(";")[0];
    projectId=(await api("POST","projects",{name:"Provider test"})).json().id;video=await readFile(new URL("./assets/motion-drive.mp4",import.meta.url));
  },30000);
  beforeEach(async()=>{drop=false;corrupt=false;outage=false;malformed=false;rejected=false;cancelKind="accepted";cancelInSubmit=false;cancelInPrepare=false;rotateInPrepare=false;await pool.query("UPDATE runs SET state='failed' WHERE state NOT IN ('succeeded','failed','canceled')");await credential();});
  afterAll(async()=>{await server?.app.close();await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}});
  it("deduplicates concurrent admission, submits once across service instances and publishes verified media once",async()=>{
    const body=invocation(),[a,b]=await Promise.all([api("POST","runs",body),api("POST","runs",body)]);expect(a.statusCode,a.body).toBe(200);expect(a.json().id).toBe(b.json().id);expect((await api("POST","runs",{...body,controls:{prompt:"changed"}})).statusCode).toBe(409);
    const other=new DirectExecutionService(pool,server.store,config.masterKey,{registry:registry(),transportFactory}),count=posts;
    await Promise.all([server.directExecution.tick(),other.tick()]);expect(posts).toBe(count+1);await other.close();
    const id=a.json().id;expect((await run(id)).state).toBe("queued");expect((await run(id)).remote_id).toBeNull();jobs.get(id)!.state="succeeded";await tick();
    const done=await run(id);expect(done.state).toBe("succeeded");expect(done.output_ids).toHaveLength(1);expect((await api("GET",`assets/${done.output_ids[0]}/content`)).rawPayload).toEqual(video);await tick();expect((await run(id)).output_ids).toEqual(done.output_ids);expect(posts).toBe(count+1);
    expect((await api("GET",`runs/${id}/workflow`)).statusCode).toBe(404);
  });
  it("recovers response loss after restart without resubmitting",async()=>{
    drop=true;const created=await enqueue(),count=posts;await tick();expect((await run(created.id)).state).toBe("submission_unknown");await restart();await tick();expect((await run(created.id)).state).toBe("queued");expect(posts).toBe(count+1);
  });
  it("never retries unknown submission when lookup is unsupported",async()=>{
    const unsupported=new DirectRegistry([{binding,adapter:{...adapter,recovery:"unsupported"},qualified:true}]);await restart(unsupported);drop=true;
    const r=await enqueue(),count=posts;await tick();await tick();expect((await run(r.id)).state).toBe("submission_unknown");expect(posts).toBe(count+1);await restart();
  });
  it("does not repeat preparation after an interrupted process",async()=>{
    const r=await enqueue(),before=uploads;await pool.query("UPDATE runs SET state='submitting' WHERE id=$1",[r.id]);await pool.query("UPDATE provider_run_bindings SET phase='preparing' WHERE run_id=$1",[r.id]);await restart();await tick();expect((await run(r.id)).state).toBe("failed");expect(uploads).toBe(before);
  });
  it("cancels before submission and during preparation without generating",async()=>{
    const count=posts,r=await enqueue();expect((await api("POST",`runs/${r.id}/cancel`)).json().state).toBe("canceled");await tick();expect(posts).toBe(count);
    cancelInPrepare=true;const another=await enqueue();await tick();expect((await run(another.id)).state).toBe("canceled");expect(posts).toBe(count);
  });
  it("preserves cancel during submission and sends cancellation once until observed confirmation",async()=>{
    cancelInSubmit=true;const r=await enqueue(),count=cancels;await tick();expect((await run(r.id)).state).toBe("cancel_requested");await tick();expect((await run(r.id)).state).toBe("cancel_requested");await tick();expect(cancels).toBe(count+1);jobs.get(r.id)!.state="canceled";await tick();expect((await run(r.id)).state).toBe("canceled");
  });
  it("imports completion that wins cancellation and reports unsupported cancellation honestly",async()=>{
    const r=await enqueue();await tick();await api("POST",`runs/${r.id}/cancel`);jobs.get(r.id)!.state="succeeded";const count=cancels;await tick();expect((await run(r.id)).state).toBe("succeeded");expect(cancels).toBe(count);
    await restart(new DirectRegistry([{binding,adapter:{...adapter,cancellation:"unsupported"},qualified:true}]));const u=await enqueue();await tick();await api("POST",`runs/${u.id}/cancel`);await tick();expect((await run(u.id)).state).toBe("cancel_requested");expect((await run(u.id)).error).toContain("cannot cancel");expect(cancels).toBe(count);await restart();
  });
  it("suspends active runs after credential rotation/deletion and prevents upload-to-submit account switches",async()=>{
    const r=await enqueue();await tick();const count=polls;await credential();await tick();expect(polls).toBe(count);expect((await run(r.id)).error).toContain("credentials changed");
    const c=(await api("GET","provider-connections")).json()[0];const pending=await enqueue();await api("DELETE",`provider-connections/${c.id}`);const before=posts;await tick();expect(posts).toBe(before);expect((await run(pending.id)).state).toBe("pending");await credential();
    rotateInPrepare=true;const next=await enqueue();await tick();expect(posts).toBe(before);expect((await run(next.id)).state).toBe("failed");
  });
  it("pauses changed registry bindings without following a new model",async()=>{
    const r=await enqueue();await tick();const count=polls;await restart(new DirectRegistry([{binding:{...binding,model:"different"},adapter,qualified:true}]));await tick();expect(polls).toBe(count);expect((await run(r.id)).error).toContain("adapter");await restart();
  });
  it("backs off status outages, rejects malformed IDs, and does not expose upstream text",async()=>{
    const r=await enqueue();await tick();outage=true;await tick();const count=polls;await server.directExecution.tick();expect(polls).toBe(count);expect((await run(r.id)).state).toBe("queued");
    for(const tail of [`runs/${r.id}`,`runs/${r.id}/events`,`runs/${r.id}/provenance`,"runs"]){const text=(await api("GET",tail)).body;expect(text).not.toContain(secret);expect(text).not.toContain(signedUrl);expect(text).not.toContain("encrypted_secret");}
    outage=false;malformed=true;const bad=await enqueue();await tick();expect((await run(bad.id)).state).toBe("submission_unknown");expect((await dbRun(bad.id)).remote_id).toBeNull();
  });
  it("retries corrupt output import without another generation and cleans uncommitted files",async()=>{
    const r=await enqueue();await tick();jobs.get(r.id)!.state="succeeded";corrupt=true;const count=posts,files=await readdir(`${config.storageRoot}/${workspaceId}`);await tick();expect((await run(r.id)).state).toBe("queued");expect((await run(r.id)).error).toContain("verification");expect(await readdir(`${config.storageRoot}/${workspaceId}`)).toEqual(files);corrupt=false;await tick();expect((await run(r.id)).state).toBe("succeeded");expect(posts).toBe(count);expect(downloads).toBeGreaterThan(0);
  });
  it("fails closed on invalid controls, inputs, version, audio, worker and unqualified registry",async()=>{
    const count=posts;
    for(const extra of [{version:"2"},{workerId:randomUUID()},{controls:{unknown:true}},{controls:{seed:1.5}},{controls:{seed:101}},{controls:{disabled:true}},{inputs:{unknown:randomUUID()}},{inputs:{image:randomUUID()}},{projectId:randomUUID()},{audioPolicy:"preserve"}])expect((await api("POST","runs",invocation(extra))).statusCode).toBeGreaterThanOrEqual(400);
    await restart(new DirectRegistry());expect((await api("POST","runs",invocation())).statusCode).toBe(422);expect((await api("GET",`provider-readiness?capabilityId=${binding.capabilityId}&routeId=direct`)).json().state).toBe("unsupported");expect(posts).toBe(count);await restart();
  });
  it("resolves an Element asset into ordinary provider inputs and freezes its server-owned provenance",async()=>{
    const assetId=randomUUID(),elementId=randomUUID(),storageKey=`${workspaceId}/${assetId}`;
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'element reference','image','image/png',$4,$5,1,(SELECT created_by FROM projects WHERE id=$3))",[assetId,workspaceId,projectId,storageKey,"a".repeat(64)]);
    await pool.query("INSERT INTO elements(id,workspace_id,name,kind,description,created_by) VALUES($1,$2,'Reusable character','character','fixture',(SELECT created_by FROM projects WHERE id=$3))",[elementId,workspaceId,projectId]);
    await pool.query("INSERT INTO element_assets(workspace_id,element_id,asset_id) VALUES($1,$2,$3)",[workspaceId,elementId,assetId]);
    const admitted=await enqueue({elementInputs:{image:{elementId,assetId}}}),stored=await dbRun(admitted.id);
    expect(stored.route_id).toBe("direct");
    expect(stored.invocation.inputs).toEqual({image:assetId});
    expect(stored.invocation.elementInputSnapshots).toEqual({image:{validationVersion:1,inputPort:"image",elementId,elementKind:"character",assetId,assetSha256:"a".repeat(64),assetMediaType:"image",assetProjectId:projectId}});
    expect((await pool.query("SELECT asset_id,role FROM run_inputs WHERE workspace_id=$1 AND run_id=$2",[workspaceId,admitted.id])).rows).toEqual([{asset_id:assetId,role:"image"}]);
    expect((await api("POST","runs",invocation({inputs:{image:assetId},elementInputs:{image:{elementId,assetId}}}))).statusCode).toBe(400);
    expect((await api("POST","runs",invocation({elementInputs:{image:{elementId,assetId}},elementInputSnapshots:{image:{forged:true}}}))).statusCode).toBe(400);
  });
  it("reports definite rejection, remote failure and confirmed cancellation",async()=>{
    rejected=true;const r=await enqueue();await tick();expect((await run(r.id)).state).toBe("failed");rejected=false;
    const failed=await enqueue();await tick();jobs.get(failed.id)!.state="failed";await tick();expect((await run(failed.id)).state).toBe("failed");
    const canceled=await enqueue();await tick();cancelKind="confirmed";await api("POST",`runs/${canceled.id}/cancel`);await tick();expect((await run(canceled.id)).state).toBe("canceled");
  });
  it("preserves committed media when the COMMIT acknowledgement is lost",async()=>{
    const r=await enqueue();await tick();jobs.get(r.id)!.state="succeeded";await due();let injected=false;
    const ambiguousPool=new Proxy(pool,{get(target,key){if(key==="connect")return async()=>{
      const client=await target.connect();let publishing=false;
      return new Proxy(client,{get(c,k){if(k==="query")return async(sql:string,...args:unknown[])=>{
        if(typeof sql==="string"&&sql.includes("UPDATE runs SET state='succeeded'"))publishing=true;
        const value=await (c.query as any)(sql,...args);
        if(sql==="COMMIT"&&publishing&&!injected){injected=true;throw new Error("Acknowledgement lost");}return value;
      };const v=Reflect.get(c,k);return typeof v==="function"?v.bind(c):v;}});
    };const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
    const service=new DirectExecutionService(ambiguousPool,server.store,config.masterKey,{registry:registry(),transportFactory});await service.tick();await service.close();
    expect(injected).toBe(true);const done=await run(r.id);expect(done.state).toBe("succeeded");expect((await api("GET",`assets/${done.output_ids[0]}/content`)).rawPayload).toEqual(video);
  });
  it("returns the same admitted run after credential rotation and denies foreign workspace resources",async()=>{
    const body=invocation(),created=(await api("POST","runs",body)).json();await credential();expect((await api("POST","runs",body)).json().id).toBe(created.id);
    const foreign={workspaceId:randomUUID()},foreignUser=randomUUID();
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,'foreign-direct@example.test','unused-test-account')",[foreignUser]);
    await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Foreign tests')",[foreign.workspaceId]);
    const foreignProject=randomUUID(),assetId=randomUUID();
    await pool.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'foreign',$3)",[foreignProject,foreign.workspaceId,foreignUser]);
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'foreign','image','image/png',$4,'fixture',1,$5)",[assetId,foreign.workspaceId,foreignProject,`${foreign.workspaceId}/${assetId}`,foreignUser]);
    expect((await api("POST","runs",invocation({projectId:foreignProject}))).statusCode).toBe(404);
    expect((await api("POST","runs",invocation({inputs:{image:assetId}}))).statusCode).toBe(404);
    const forbidden=await server.app.inject({method:"GET",url:`/api/v1/workspaces/${foreign.workspaceId}/runs/${created.id}/provenance`,headers:{cookie}});expect(forbidden.statusCode).toBe(403);
  });
  it("reports missing credentials and stops mismatched encryption context without exposing ciphertext",async()=>{
    const connection=(await api("GET","provider-connections")).json()[0];await api("DELETE",`provider-connections/${connection.id}`);
    expect((await api("GET",`provider-readiness?capabilityId=${binding.capabilityId}&routeId=direct`)).json().state).toBe("credentials_required");expect((await api("POST","runs",invocation())).statusCode).toBe(422);
    await credential();const created=await enqueue();
    const {encryptProviderSecret}=await import("../server/crypto");const bad=encryptProviderSecret(secret,config.masterKey,{workspaceId:randomUUID(),providerId:"wan"});
    await pool.query("UPDATE provider_connections SET encrypted_secret=$1 WHERE workspace_id=$2",[bad,workspaceId]);const count=posts;await tick();expect(posts).toBe(count);const response=await api("GET",`runs/${created.id}`);expect(response.json().error).toContain("credentials");expect(response.body).not.toContain(bad);expect(response.body).not.toContain(secret);
  });
});
