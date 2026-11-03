import {afterAll,beforeAll,describe,expect,it} from "vitest";
import Fastify,{type FastifyInstance} from "fastify";
import cookie from "@fastify/cookie";
import {Pool} from "pg";
import {createServer,type Server} from "node:http";
import {randomUUID} from "node:crypto";
import WebSocket,{WebSocketServer} from "ws";
import {migrate} from "../server/db";
import {hashToken} from "../server/crypto";
import {HttpError} from "../server/auth";
import {comfyProxyRoutes} from "../server/comfy-proxy";
import {readFileSync} from "node:fs";

const connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("workspace node-editor proxy boundaries",()=>{
  const schema=`cf_node_proxy_${randomUUID().replaceAll("-","")}`;
  const workspaceA=randomUUID(),workspaceB=randomUUID(),userA=randomUUID(),userB=randomUUID(),viewer=randomUUID();
  const tokenA=randomUUID(),tokenB=randomUUID(),tokenViewer=randomUUID();
  const seen:Array<{worker:string;url:string;cookie?:string;authorization?:string;origin?:string;ws:boolean}>=[];
  let root:Pool,pool:Pool,app:FastifyInstance,origin:string;
  const workers:Array<{server:Server;wss:WebSocketServer;origin:string}>=[];
  const base=(ws:string=workspaceA)=>`/comfy/${ws}`;
  const auth=(token:string=tokenA)=>({cookie:`cf_session=${token}; unrelated_secret=must-not-forward`,authorization:"Bearer must-not-forward"});
  async function fakeWorker(label:string){
    const record=(req:import("node:http").IncomingMessage,ws=false)=>seen.push({worker:label,url:req.url!,cookie:req.headers.cookie,authorization:req.headers.authorization,origin:req.headers.origin,ws});
    const server=createServer((req,res)=>{
      record(req);res.setHeader("set-cookie","cf_session=worker-injection; Path=/");
      if(req.url==="/"){res.setHeader("content-type","text/html");res.end("<!doctype html><html><head><script type=\"module\" src=\"/app.js\"></script></head><body>"+label+"</body></html>");}
      else{res.setHeader("content-type","application/json");res.end(JSON.stringify({worker:label,path:req.url}));}
    });
    const wss=new WebSocketServer({server});
    wss.on("connection",(socket,req)=>{record(req,true);socket.send(label);socket.on("message",message=>socket.send(message));});
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    workers.push({server,wss,origin});return origin;
  }
  async function socketResult(ws:string,token:string|undefined,requestOrigin=origin){
    return new Promise<{status:number;message?:string}>(resolve=>{
      const socket=new WebSocket(origin.replace("http:","ws:")+base(ws)+"/ws?clientId=fixture",{headers:{origin:requestOrigin,...(token?auth(token):{})},handshakeTimeout:5000});
      socket.on("message",data=>{socket.close();resolve({status:101,message:data.toString()});});
      socket.on("unexpected-response",(_req,res)=>{res.resume();socket.terminate();resolve({status:res.statusCode!});});
      socket.on("error",()=>{});
    });
  }
  beforeAll(async()=>{
    root=new Pool({connectionString});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    for(const [id,email] of [[userA,"nodes-a@example.test"],[userB,"nodes-b@example.test"],[viewer,"nodes-viewer@example.test"]])
      await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'fixture-no-login')",[id,email]);
    for(const [id,name] of [[workspaceA,"A"],[workspaceB,"B"]])await pool.query("INSERT INTO workspaces(id,name) VALUES($1,$2)",[id,name]);
    for(const [ws,user,role] of [[workspaceA,userA,"admin"],[workspaceB,userB,"creator"],[workspaceA,viewer,"viewer"]])
      await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",[ws,user,role]);
    for(const [user,token] of [[userA,tokenA],[userB,tokenB],[viewer,tokenViewer]])
      await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),user]);
    const originA=await fakeWorker("A"),originB=await fakeWorker("B");
    for(const [ws,url] of [[workspaceA,originA],[workspaceB,originB]])
      await pool.query("INSERT INTO workers(id,workspace_id,name,origin,api_prefix,enabled) VALUES($1,$2,'worker',$3,'',true)",[randomUUID(),ws,url]);
    app=Fastify();await app.register(cookie);
    app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof HttpError?error.statusCode:500).send({error:error instanceof Error?error.message:"Proxy error"}));
    // Resolve publicOrigin before registering the proxy; the listening socket
    // uses the same bound server, without an ephemeral-port race.
    await new Promise<void>(resolve=>app.server.listen(0,"127.0.0.1",resolve));
    origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
    await comfyProxyRoutes(app,pool,origin);await app.ready();
  });
  afterAll(async()=>{
    await app?.close();
    for(const worker of workers){for(const client of worker.wss.clients)client.terminate();await new Promise<void>(resolve=>worker.wss.close(()=>resolve()));await new Promise<void>(resolve=>worker.server.close(()=>resolve()));}
    await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
  });
  it("never opens the cloud website as the embedded node editor",async()=>{
    const cloudId=randomUUID(),cloudOrigin=await fakeWorker("cloud");
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,api_prefix,enabled,kind) VALUES($1,$2,'A cloud worker',$3,'',true,'cloud')",[cloudId,workspaceA,cloudOrigin]);
    const before=seen.length;
    try{
      expect((await app.inject({url:base()+"/",headers:auth()})).statusCode).toBe(200);
      expect((await app.inject({url:base()+"/assets/app.js",headers:auth()})).statusCode).toBe(200);
      expect((await app.inject({url:base()+"/user.css",headers:auth()})).statusCode).toBe(200);
      expect(seen.slice(before).length).toBeGreaterThan(0);
      expect(seen.slice(before).every(request=>request.worker==="A")).toBe(true);
    }finally{await pool.query("DELETE FROM workers WHERE id=$1",[cloudId]);}
  });

  it("checks membership on root, assets, mutable endpoints and viewer requests",async()=>{
    const before=seen.length;
    for(const suffix of ["/","/queue","/assets/app.js","/view?filename=private.png"]){
      expect((await app.inject({url:base()+suffix})).statusCode).toBe(401);
      expect((await app.inject({url:base()+suffix,headers:auth(tokenB)})).statusCode).toBe(403);
      expect((await app.inject({url:base()+suffix,headers:auth(tokenViewer)})).statusCode).toBe(403);
    }
    expect((await app.inject({method:"POST",url:base()+"/prompt",headers:auth(tokenB),payload:{prompt:{}}})).statusCode).toBe(403);
    expect(seen).toHaveLength(before);
  });

  it("exports saved reference preparation only for members, without contacting the worker",async()=>{
    const runId=randomUUID(),projectId=randomUUID();
    await pool.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Inspection',$3)",[projectId,workspaceA,userA]);
    const graph=JSON.parse(readFileSync("native-workflows/scail2-character-replace/template.api.json","utf8"));
    await pool.query("INSERT INTO runs(id,workspace_id,project_id,created_by,capability_id,capability_version,route_id,state,idempotency_key,request_hash,invocation,graph) VALUES($1,$2,$3,$4,'scail2-character-replace','0.5.1','local','succeeded',$5,'fixture-inspection','{}',$6)",[runId,workspaceA,projectId,userA,randomUUID(),JSON.stringify(graph)]);
    const url=`/api/v1/workspaces/${workspaceA}/runs/${runId}/reference-inspection`,before=seen.length;
    expect((await app.inject({url})).statusCode).toBe(401);
    expect((await app.inject({url,headers:auth(tokenB)})).statusCode).toBe(403);
    const response=await app.inject({url,headers:auth(tokenA)});
    expect(response.statusCode,response.body).toBe(200);
    expect(Object.values(response.json().graph).filter((n:any)=>n.class_type==="SaveImage")).toHaveLength(4);
    expect(seen).toHaveLength(before);
    expect((await pool.query("SELECT count(*)::int AS n FROM runs WHERE project_id=$1",[projectId])).rows[0].n).toBe(1);
  });
  it("routes simultaneous workspaces independently and strips worker credentials/cookies",async()=>{
    const responses=await Promise.all([
      app.inject({url:base()+"/queue",headers:auth()}),
      app.inject({url:base(workspaceB)+"/queue",headers:auth(tokenB)}),
    ]);
    expect(responses.map(r=>r.json().worker)).toEqual(["A","B"]);
    for(const response of responses){expect(response.headers["set-cookie"]).toBeUndefined();expect(response.headers["x-content-type-options"]).toBe("nosniff");}
    for(const request of seen.slice(-2)){expect(request.cookie).toBeUndefined();expect(request.authorization).toBeUndefined();}
    const page=await app.inject({url:base()+"/",headers:auth()});expect(page.body).toContain("comfyfield-theme.css");
    expect(page.body.indexOf("comfyfield-node-mode.js")).toBeLessThan(page.body.indexOf("/app.js"));
    const mode=await app.inject({url:"/comfyfield-node-mode.js"});expect(mode.statusCode).toBe(200);expect(mode.body).toContain("Comfy.VueNodes.Enabled");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
  });
  it("qualifies absolute imports by a validated workspace referer without a fallback",async()=>{
    for(const alias of ["/scripts/app.js","/extensions/a.js","/extensions"]){
      expect((await app.inject({url:alias,headers:auth()})).statusCode).toBe(403);
      expect((await app.inject({url:alias,headers:{...auth(),referer:origin+base(workspaceB)+"/assets/index.js"}})).statusCode).toBe(403);
      const response=await app.inject({url:alias,headers:{...auth(),referer:origin+base()+"/assets/index.js"}});
      expect(response.statusCode).toBe(302);expect(response.headers.location).toBe(base()+alias);
      expect((await app.inject({url:response.headers.location!,headers:auth()})).json().worker).toBe("A");
    }
  });
  it("authenticates real WebSocket upgrades, rejects foreign origins and strips credentials",async()=>{
    expect(await socketResult(workspaceA,undefined)).toEqual({status:401});
    expect(await socketResult(workspaceA,tokenB)).toEqual({status:403});
    expect(await socketResult(workspaceA,tokenA,"https://foreign.example")).toEqual({status:403});
    expect(await socketResult(workspaceA,tokenA)).toEqual({status:101,message:"A"});
    expect(await socketResult(workspaceB,tokenB)).toEqual({status:101,message:"B"});
    const sockets=seen.filter(entry=>entry.ws);
    expect(sockets.map(entry=>entry.worker)).toEqual(["A","B"]);
    for(const request of sockets){expect(request.cookie).toBeUndefined();expect(request.authorization).toBeUndefined();expect(request.origin).toBe(workers[request.worker==="A"?0:1].origin);}
  });
  it("fails closed immediately when a worker or membership is revoked",async()=>{
    await pool.query("UPDATE workers SET enabled=false WHERE workspace_id=$1",[workspaceA]);
    const before=seen.length;
    expect((await app.inject({url:base()+"/queue",headers:auth()})).statusCode).toBe(503);
    expect(await socketResult(workspaceA,tokenA)).toEqual({status:503});
    await pool.query("DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",[workspaceB,userB]);
    expect((await app.inject({url:base(workspaceB)+"/queue",headers:auth(tokenB)})).statusCode).toBe(403);
    expect(seen).toHaveLength(before);
  });
});
