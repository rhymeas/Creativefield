import {afterAll,beforeAll,describe,expect,it} from "vitest";
import Fastify,{type FastifyInstance} from "fastify";
import cookie from "@fastify/cookie";
import {Pool} from "pg";
import {createServer,type Server} from "node:http";
import {randomUUID} from "node:crypto";
import {migrate} from "../server/db";
import {hashToken} from "../server/crypto";
import {HttpError} from "../server/auth";
import {RUN_SCRIPT,runFileName,runGraphRoutes,withSubmittedIds} from "../server/comfy-editor";
import type {EditorWorkflow} from "../src/workflow/api-to-ui";
import {editorSource,runFromHash} from "../src/team/nodes/ComfyNodes";

const connectionString=process.env.TEST_DATABASE_URL;

/* "#nodes/run/<run id>" is what the "Go to nodes workflow" link on a running card opens. */
describe("the run hash route",()=>{
  it("reads the run id out of the hash",()=>{
    const id=randomUUID();
    expect(runFromHash(`#nodes/run/${id}`)).toBe(id);
    expect(runFromHash(`#nodes/run/${id.slice(1)}`)).toBeNull();
    expect(runFromHash("#nodes/run/not-a-run")).toBeNull();
    expect(runFromHash("#nodes/feature/t2v")).toBeNull();
    expect(runFromHash("#nodes")).toBeNull();
  });
  it("carries the run to the editor address and keeps the other options",()=>{
    const id=randomUUID();
    expect(editorSource("http://127.0.0.1:8788/comfy/ws",{version:3,run:id}))
      .toBe(`http://127.0.0.1:8788/comfy/ws?v=3&comfyfield_run=${id}`);
    expect(editorSource("http://127.0.0.1:8788/comfy/ws",{version:1,feature:"t2v"}))
      .toBe("http://127.0.0.1:8788/comfy/ws?v=1&comfyfield_feature=t2v");
  });
});

describe.skipIf(!connectionString)("a run's graph in the isolated editor",()=>{
  const schema=`cf_run_view_${randomUUID().replaceAll("-","")}`;
  const workspace=randomUUID(),other=randomUUID(),member=randomUUID(),foreign=randomUUID();
  const token=randomUUID(),foreignToken=randomUUID();
  const project=randomUUID(),run=randomUUID(),waiting=randomUUID(),gone=randomUUID();
  let root:Pool,pool:Pool,app:FastifyInstance,worker:Server;
  const auth=(value:string=token)=>({cookie:`cf_session=${value}`});
  const url=(runId:string,workspaceId:string=workspace)=>`/comfyfield-run-graph/${workspaceId}/${runId}`;

  /* The graph the run submitted, in ComfyUI's API format, exactly as runs.graph holds it. */
  const submitted={
    "3":{class_type:"LoadImage",inputs:{image:"a.png"}},
    "6":{class_type:"VAEDecode",inputs:{samples:["9",0]}},
    "9":{class_type:"KSampler",inputs:{api_key:"sk-live-123",seed:7}},
    "12":{class_type:"SaveVideo",inputs:{images:["6",0],fps:24,filename_prefix:"run"}},
  };
  /* What the worker reports about those node classes. */
  const info={
    LoadImage:{input:{required:{image:[["a.png","b.png"],{}]}},output:["IMAGE"],output_name:["IMAGE"]},
    KSampler:{input:{required:{api_key:["STRING",{default:""}],seed:["INT",{default:0}]}},output:["LATENT"],output_name:["LATENT"]},
    VAEDecode:{input:{required:{samples:["LATENT",{}]}},output:["IMAGE"],output_name:["IMAGE"]},
    SaveVideo:{input:{required:{images:["IMAGE",{}],fps:["INT",{default:24}],filename_prefix:["STRING",{default:"video"}]}},output:["STRING"],output_name:["video"]},
  };

  beforeAll(async()=>{
    root=new Pool({connectionString});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    for(const [id,email] of [[member,"run-member@example.test"],[foreign,"run-foreign@example.test"]])
      await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'fixture-no-login')",[id,email]);
    for(const [id,name] of [[workspace,"Run view"],[other,"Other"]])await pool.query("INSERT INTO workspaces(id,name) VALUES($1,$2)",[id,name]);
    for(const [ws,user,role] of [[workspace,member,"viewer"],[other,foreign,"creator"]])
      await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",[ws,user,role]);
    for(const [user,value] of [[member,token],[foreign,foreignToken]])
      await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(value),user]);
    await pool.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Run view',$3)",[project,workspace,member]);
    worker=createServer((request,response)=>{
      if(request.url==="/object_info"){response.setHeader("content-type","application/json");response.end(JSON.stringify(info));return;}
      response.statusCode=404;response.end("{}");
    });
    await new Promise<void>(resolve=>worker.listen(0,"127.0.0.1",resolve));
    const workerOrigin=`http://127.0.0.1:${(worker.address() as {port:number}).port}`;
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,api_prefix,enabled) VALUES($1,$2,'worker',$3,'',true)",[randomUUID(),workspace,workerOrigin]);
    for(const [id,graph,remote] of [[run,JSON.stringify(submitted),"prompt-1"],[waiting,null,null],[gone,JSON.stringify(submitted),null]])
      await pool.query(`INSERT INTO runs(id,workspace_id,project_id,created_by,capability_id,capability_version,route_id,state,invocation,graph,remote_id,request_hash,idempotency_key)
        VALUES($1,$2,$3,$4,'t2v','1.0.0','main','running','{"routeId":"main"}',$5,$6,$7,$7)`,
        [id,workspace,project,member,graph,remote,randomUUID()]);
    await pool.query("UPDATE runs SET deleted_at=now() WHERE id=$1",[gone]);
    app=Fastify();await app.register(cookie);
    app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof HttpError?error.statusCode:500).send({error:error instanceof Error?error.message:"route error"}));
    await runGraphRoutes(app,pool);await app.ready();
  });
  afterAll(async()=>{
    await app?.close();
    if(worker)await new Promise<void>(resolve=>worker.close(()=>resolve()));
    await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
  });

  it("answers only a member of the run's workspace",async()=>{
    expect((await app.inject({url:url(run)})).statusCode).toBe(401);
    expect((await app.inject({url:url(run),headers:{cookie:"cf_session=not-a-session"}})).statusCode).toBe(401);
    expect((await app.inject({url:url(run),headers:auth(foreignToken)})).statusCode).toBe(403);
    expect((await app.inject({url:url(run,other),headers:auth()})).statusCode).toBe(403);
    expect((await app.inject({url:url(run),headers:auth()})).statusCode).toBe(200);
  });

  it("serves the exact graph the run submitted, with no secret in it",async()=>{
    const response=await app.inject({url:url(run),headers:auth()});
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body=response.json() as {name:string;workflow:{nodes:Array<{id:number;type:string;widgets_values:unknown[];inputs:Array<{name:string;link:number|null}>}>;links:unknown[]}};
    expect(body.name).toBe(runFileName(run));
    // The node ids are the submitted ones, so ComfyUI's own highlight and progress bar reach the right node.
    expect(body.workflow.nodes.map(node=>[node.id,node.type]))
      .toEqual([[3,"LoadImage"],[6,"VAEDecode"],[9,"KSampler"],[12,"SaveVideo"]]);
    expect(body.workflow.links).toEqual([[1,9,0,6,0,"LATENT"],[2,6,0,12,0,"IMAGE"]]);
    const byId=new Map(body.workflow.nodes.map(node=>[node.id,node]));
    expect(byId.get(3)!.widgets_values).toEqual(["a.png"]);
    expect(byId.get(6)!.inputs[0]).toMatchObject({name:"samples",link:1});
    expect(byId.get(9)!.widgets_values).toEqual(["",7]);
    expect(byId.get(12)!.widgets_values).toEqual([24,"run"]);
    expect(response.body).not.toContain("sk-live-123");
    expect(response.body).not.toContain("api_key");
  });

  it("says so when there is no graph to show",async()=>{
    expect((await app.inject({url:url(waiting),headers:auth()})).statusCode).toBe(404);
    expect((await app.inject({url:url(gone),headers:auth()})).statusCode).toBe(404);
    expect((await app.inject({url:url(randomUUID()),headers:auth()})).statusCode).toBe(404);
    expect((await app.inject({url:url("not-a-run"),headers:auth()})).statusCode).toBe(400);
  });

  it("serves the editor script that opens the run",async()=>{
    const response=await app.inject({url:"/comfyfield-run.js"});
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/javascript");
    expect(response.body).toContain("comfyfield_run");
    expect(response.body).toContain("/comfyfield-run-graph/");
    expect(RUN_SCRIPT).toBe(response.body);
  });
});

describe("ids the run submitted",()=>{
  it("keeps them, and gives a node the editor added a free one",()=>{
    const workflow={
      last_node_id:3,last_link_id:2,
      nodes:[
        {id:1,type:"LoadImage",inputs:[{name:"image",type:"STRING",link:2}],outputs:[{name:"IMAGE",type:"IMAGE",links:[1]}]},
        {id:2,type:"PrimitiveStringMultiline",inputs:[],outputs:[{name:"STRING",type:"STRING",links:[2]}]},
        {id:3,type:"SaveVideo",inputs:[{name:"images",type:"IMAGE",link:1}],outputs:[]},
      ],
      links:[[1,1,0,3,0,"IMAGE"],[2,2,0,1,0,"STRING"]] as Array<[number,number,number,number,number,string]>,
      groups:[] as [],config:{},extra:{comfyfield:{ids:{"1":"3","2":"~inline:3:image","3":"12"}}},version:0.4,
    } as unknown as EditorWorkflow;
    const moved=withSubmittedIds(workflow);
    expect(moved.nodes.map(node=>node.id)).toEqual([3,1,12]);
    expect(moved.links).toEqual([[1,3,0,12,0,"IMAGE"],[2,1,0,3,0,"STRING"]]);
    expect(moved.last_node_id).toBe(12);
    expect(moved.extra.comfyfield.ids).toEqual({"3":"3","1":"~inline:3:image","12":"12"});
  });
});
