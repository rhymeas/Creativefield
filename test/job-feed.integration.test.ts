import {beforeAll,afterAll,describe,it,expect} from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import {Pool} from "pg";
import {randomUUID} from "node:crypto";
import {migrate} from "../server/db";
import {bootstrap} from "../server/auth";
import {hashToken} from "../server/crypto";
import {jobFeedRoutes} from "../server/job-feed";

const connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("job SSE over authenticated HTTP and PostgreSQL",()=>{
  const schema=`cf_jobs_${randomUUID().replaceAll("-","")}`,app=Fastify(),token=randomUUID();
  let root:Pool,pool:Pool,address:string,workspace:string,foreign:string;
  const ids:string[]=Array.from({length:12},()=>randomUUID());
  beforeAll(async()=>{
    root=new Pool({connectionString});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    const user=await bootstrap(pool,"jobs@example.test","Fixture-password-long-27!","Jobs fixture");workspace=user.workspaceId;foreign=randomUUID();
    await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Foreign fixture')",[foreign]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),user.userId]);
    const project=randomUUID();await pool.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Fixture',$3)",[project,workspace,user.userId]);
    const worker=randomUUID(),source=randomUUID();await pool.query("INSERT INTO workers(id,workspace_id,name,origin) VALUES($1,$2,'Fixture worker',$3)",[worker,workspace,`http://worker-${randomUUID()}.test`]);
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'portrait.png','image','image/png',$4,'fixture',1,$5)",[source,workspace,project,`fixture/${randomUUID()}`,user.userId]);
    await pool.query("INSERT INTO pose_previews(id,workspace_id,project_id,source_asset_id,source_sha256,worker_id,created_by,request_hash,state) VALUES($1,$2,$3,$4,'fixture',$5,$6,'fixture','preparing')",[randomUUID(),workspace,project,source,worker,user.userId]);
    const insert=async(keys:string[],state:string)=>pool.query(`INSERT INTO runs(id,workspace_id,project_id,created_by,capability_id,capability_version,route_id,state,invocation,request_hash,idempotency_key,created_at)
      SELECT id,$1,$2,$3,'fixture','1','local',$5,'{}','fixture',id::text,CASE WHEN $5='queued' THEN now()-interval '1 day' ELSE now() END FROM unnest($4::uuid[]) AS t(id)`,[workspace,project,user.userId,keys,state]);
    await insert(ids,"queued");await insert(Array.from({length:201},()=>randomUUID()),"succeeded");
    await app.register(cookie);jobFeedRoutes(app,pool,id=>ids.includes(id)?{value:3,max:12}:undefined);
    address=await app.listen({host:"127.0.0.1",port:0});
  });
  afterAll(async()=>{await app.close();await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}});
  it("rejects unauthenticated/foreign reads and closes a revoked stream",async()=>{
    const url=(id:string)=>`${address}/api/v1/workspaces/${id}/jobs/stream`;
    expect((await fetch(url(workspace))).status).toBe(401);
    expect((await fetch(url(foreign),{headers:{cookie:`cf_session=${token}`}})).status).toBe(403);
    const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),8000);
    try{
      const response=await fetch(url(workspace),{headers:{cookie:`cf_session=${token}`},signal:abort.signal});
      expect(response.status).toBe(200);expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const reader=response.body!.getReader(),decoder=new TextDecoder();
      const frame=async()=>{let text="";for(let i=0;i<10;i++){const chunk=await reader.read();if(chunk.done)break;text+=decoder.decode(chunk.value,{stream:true});if(text.includes("\n\n"))break;}return text;};
      let text=await frame();
      expect(text).toContain("event: jobs");const data=JSON.parse(text.split("data: ")[1].split("\n")[0]);
      expect(data.total).toBe(13);expect(data.runs).toHaveLength(8);expect(data.runs.every((run:{state:string})=>run.state==="queued")).toBe(true);
      expect(data.preparations).toMatchObject([{state:"preparing",source_name:"portrait.png"}]);
      expect(Object.values(data.progress)).toEqual(Array(8).fill(.25));
      expect(text).not.toMatch(/request_hash|invocation|token_hash|remote_id/);
      await pool.query("DELETE FROM sessions WHERE token_hash=$1",[hashToken(token)]);
      text=await frame();expect(text).toContain("event: access-denied");
      expect((await reader.read()).done).toBe(true);
    }finally{clearTimeout(timeout);abort.abort();}
  },10000);
});
