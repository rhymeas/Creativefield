import {afterAll,beforeAll,describe,it,expect} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdir,mkdtemp,rm,stat,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {hashPassword} from "../server/crypto";
import {migrate} from "../server/db";

const connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("run deletion",()=>{
  const schema=`cf_run_delete_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173",password="Fixture-only-Run-delete-527!";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,storageRoot:string,workspaceId:string,ownerId:string,projectId:string,ownerCookie:string,viewerCookie:string;
  const request=(method:"GET"|"DELETE",path:string,cookie=ownerCookie):Promise<{statusCode:number;json:()=>any}>=>server.app.inject({method,url:path,headers:{origin,cookie}}) as Promise<{statusCode:number;json:()=>any}>;
  const url=(tail:string)=>`/api/v1/workspaces/${workspaceId}/${tail}`;
  const insertAsset=async()=>{
    const id=randomUUID(),key=`${workspaceId}/${randomUUID()}`;
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'result.png','image','image/png',$4,$5,4,$6)",[id,workspaceId,projectId,key,"a".repeat(64),ownerId]);
    await mkdir(join(storageRoot,workspaceId),{recursive:true});
    await writeFile(join(storageRoot,workspaceId,key.split("/")[1]),"result");
    return {id,key};
  };
  const insertRun=async(state:string,outputIds:string[]=[])=>{
    const id=randomUUID();
    await pool.query("INSERT INTO runs(id,workspace_id,project_id,created_by,capability_id,capability_version,route_id,state,invocation,request_hash,idempotency_key,output_ids) VALUES($1,$2,$3,$4,'fixture','1','local',$5,'{}','fixture',$6,$7)",[id,workspaceId,projectId,ownerId,state,id,JSON.stringify(outputIds)]);
    return id;
  };
  const asset=(id:string)=>pool.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,id]).then(result=>result.rowCount);
  const deletedAt=(id:string)=>pool.query("SELECT deleted_at FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,id]).then(result=>result.rows[0].deleted_at);
  beforeAll(async()=>{
    root=new Pool({connectionString});await root.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    storageRoot=await mkdtemp(join(process.env.COMFYFIELD_TEST_TEMP_ROOT??(process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "","comfyfield-run-delete-"));
    const owner=await bootstrap(pool,"run-owner@example.test",password,"Runs");workspaceId=owner.workspaceId;ownerId=owner.userId;
    const viewerId=randomUUID();await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,'run-viewer@example.test',$2)",[viewerId,await hashPassword(password)]);await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[workspaceId,viewerId]);
    server=await buildServer({databaseUrl:connectionString!,storageRoot,masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false},pool);await server.app.ready();
    for(const email of ["run-owner@example.test","run-viewer@example.test"]){const response=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email,password}});expect(response.statusCode).toBe(200);if(email.startsWith("run-owner"))ownerCookie=String(response.headers["set-cookie"]).split(";")[0];else viewerCookie=String(response.headers["set-cookie"]).split(";")[0];}
    projectId=randomUUID();await pool.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Results',$3)",[projectId,workspaceId,ownerId]);
  },30000);
  afterAll(async()=>{await server?.app.close();await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}if(storageRoot)await rm(storageRoot,{recursive:true,force:true});});
  it("deletes a succeeded result and its own output file",async()=>{
    const output=await insertAsset(),runId=await insertRun("succeeded",[output.id]);
    expect((await request("DELETE",url(`runs/${runId}`),viewerCookie)).statusCode).toBe(403);
    expect((await request("DELETE",url(`runs/${runId}`))).statusCode).toBe(204);
    expect(await deletedAt(runId)).not.toBeNull();
    expect(await asset(output.id)).toBe(0);
    await expect(stat(join(storageRoot,output.key))).rejects.toMatchObject({code:"ENOENT"});
    expect((await pool.query("SELECT completed_at FROM asset_deletions WHERE workspace_id=$1 AND asset_id=$2",[workspaceId,output.id])).rows[0].completed_at).not.toBeNull();
    expect((await request("DELETE",url(`runs/${runId}`))).statusCode).toBe(404);
  });
  it("deletes a failed result",async()=>{
    const runId=await insertRun("failed");
    expect((await request("DELETE",url(`runs/${runId}`))).statusCode).toBe(204);
    expect(await deletedAt(runId)).not.toBeNull();
  });
  it("refuses a queued or running result and asks to cancel it first",async()=>{
    for(const state of ["queued","running"]){
      const output=await insertAsset(),runId=await insertRun(state,[output.id]);
      const refused=await request("DELETE",url(`runs/${runId}`));
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe("Cancel this run first.");
      expect(await deletedAt(runId)).toBeNull();
      expect(await asset(output.id)).toBe(1);
    }
  });
  it("does not cross workspace boundaries",async()=>{
    const runId=await insertRun("succeeded"),other=randomUUID();
    await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Other fixture')",[other]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'creator')",[other,ownerId]);
    expect((await request("DELETE",`/api/v1/workspaces/${other}/runs/${runId}`)).statusCode).toBe(404);
    expect(await deletedAt(runId)).toBeNull();
  });
  it("keeps an output that another run or a storyboard still uses",async()=>{
    const shared=await insertAsset(),first=await insertRun("succeeded",[shared.id]),second=await insertRun("succeeded",[shared.id]);
    expect((await request("DELETE",url(`runs/${first}`))).statusCode).toBe(204);
    expect(await asset(shared.id)).toBe(1);
    expect((await pool.query("SELECT 1 FROM asset_deletions WHERE workspace_id=$1 AND asset_id=$2",[workspaceId,shared.id])).rowCount).toBe(0);
    expect((await request("DELETE",url(`runs/${second}`))).statusCode).toBe(204);
    expect(await asset(shared.id)).toBe(0);
    const still=await insertAsset(),stillRun=await insertRun("succeeded",[still.id]),board=randomUUID();
    await pool.query("INSERT INTO storyboards(id,workspace_id,project_id,name,created_by) VALUES($1,$2,$3,'Board',$4)",[board,workspaceId,projectId,ownerId]);
    const shotId=randomUUID();
    await pool.query("INSERT INTO shots(id,workspace_id,storyboard_id,ordinal,prompt,duration_seconds,plan_key) VALUES($1,$2,$3,0,'Shot',1,$4)",[shotId,workspaceId,board,randomUUID()]);
    await pool.query("INSERT INTO shot_assets(workspace_id,shot_id,asset_id,role) VALUES($1,$2,$3,'start_image')",[workspaceId,shotId,still.id]);
    expect((await request("DELETE",url(`runs/${stillRun}`))).statusCode).toBe(204);
    expect(await asset(still.id)).toBe(1);
    expect(await deletedAt(stillRun)).not.toBeNull();
  });
  // The runs list itself lives in server/execution.ts, which is outside this task's files: its query
  // still answers a deleted run until that list adds `deleted_at IS NULL`.
  it.todo("the runs list stops showing a deleted run");
});
