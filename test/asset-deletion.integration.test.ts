import {afterAll,beforeAll,describe,it,expect,vi} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm,stat} from "node:fs/promises";
import {join} from "node:path";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {hashPassword} from "../server/crypto";
import {migrate} from "../server/db";
import {DiskStore} from "../server/storage";
import {composerAssets,composerResultAssets,type Call} from "../src/team/api";
import {execFileSync} from "node:child_process";
import {h3ReferenceDurationNote} from "../src/capabilities/router-models";

const connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("library asset deletion",()=>{
  const schema=`cf_asset_delete_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173",password="Fixture-only-Asset-delete-527!";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,storageRoot:string,workspaceId:string,ownerId:string,projectId:string,assetId:string,storageKey:string,ownerCookie:string,viewerCookie:string;
  const request=(method:"GET"|"POST"|"DELETE",path:string,cookie=ownerCookie,payload?:unknown):Promise<{statusCode:number;json:()=>any}>=>server.app.inject({method,url:path,headers:{origin,cookie},payload:payload as any}) as Promise<{statusCode:number;json:()=>any}>;
  const url=(tail:string)=>`/api/v1/workspaces/${workspaceId}/${tail}`;
  beforeAll(async()=>{
    root=new Pool({connectionString});await root.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    storageRoot=await mkdtemp(join(process.env.COMFYFIELD_TEST_TEMP_ROOT??(process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "","comfyfield-asset-delete-"));
    const owner=await bootstrap(pool,"asset-owner@example.test",password,"Assets");workspaceId=owner.workspaceId;ownerId=owner.userId;
    const viewerId=randomUUID();await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,'asset-viewer@example.test',$2)",[viewerId,await hashPassword(password)]);await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[workspaceId,viewerId]);
    server=await buildServer({databaseUrl:connectionString!,storageRoot,masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false},pool);await server.app.ready();
    for(const email of ["asset-owner@example.test","asset-viewer@example.test"]){const response=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email,password}});expect(response.statusCode).toBe(200);if(email.startsWith("asset-owner"))ownerCookie=String(response.headers["set-cookie"]).split(";")[0];else viewerCookie=String(response.headers["set-cookie"]).split(";")[0];}
    projectId=randomUUID();await pool.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Library',$3)",[projectId,workspaceId,ownerId]);
    const boundary="cf-asset-delete-boundary",bytes=await readFile("test/assets/render-test.png"),multipart=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"portrait.png\"\r\nContent-Type: image/png\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const uploaded=await server.app.inject({method:"POST",url:url(`assets?projectId=${projectId}`),headers:{origin,cookie:ownerCookie,"content-type":`multipart/form-data; boundary=${boundary}`},payload:multipart});expect(uploaded.statusCode).toBe(200);assetId=uploaded.json().id;storageKey=(await pool.query("SELECT storage_key FROM assets WHERE id=$1",[assetId])).rows[0].storage_key;
  },30000);
  afterAll(async()=>{await server?.app.close();await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}if(storageRoot)await rm(storageRoot,{recursive:true,force:true});});
  it("stores a bundled example video as a project asset and returns its original bytes",async()=>{
    const bytes=await readFile("public/reels/mj-03.mp4"),boundary="cf-example-video";
    const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="mj-03.mp4"\r\nContent-Type: video/mp4\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const uploaded=await server.app.inject({method:"POST",url:url(`assets?projectId=${projectId}`),headers:{origin,cookie:ownerCookie,"content-type":`multipart/form-data; boundary=${boundary}`},payload});
    expect(uploaded.statusCode).toBe(200);const saved=uploaded.json();expect(saved).toMatchObject({name:"mj-03.mp4",media_type:"video",content_type:"video/mp4"});
    expect(saved.metadata.durationSeconds).toBeGreaterThan(0);
    const listing=await request("GET",url(`assets?projectId=${projectId}`));expect(listing.json().items.map((item:any)=>item.id)).toContain(saved.id);
    const content=await server.app.inject({method:"GET",url:url(`assets/${saved.id}/content`),headers:{origin,cookie:ownerCookie}});expect(content.statusCode).toBe(200);expect(content.rawPayload).toEqual(bytes);
    expect((await request("DELETE",url(`assets/${saved.id}`))).statusCode).toBe(200);
  });
  it("records long upload duration for the H3 trim notice and tolerates unreadable media",async()=>{
    const file=join(storageRoot,"long-upload.mp4"),boundary="cf-duration";
    execFileSync(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-f","lavfi","-i","color=blue:size=120x80:rate=8:duration=16","-c:v","libx264","-y",file]);
    const upload=async(bytes:Buffer)=>server.app.inject({method:"POST",url:url(`assets?projectId=${projectId}`),headers:{origin,cookie:ownerCookie,"content-type":`multipart/form-data; boundary=${boundary}`},payload:Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)])});
    const long=await upload(await readFile(file));expect(long.statusCode).toBe(200);
    expect(h3ReferenceDurationNote(long.json().metadata.durationSeconds)).toContain("first 15 seconds");
    await pool.query("UPDATE assets SET metadata='{}'::jsonb WHERE workspace_id=$1 AND id=$2",[workspaceId,long.json().id]);
    const old=await request("GET",url(`assets/${long.json().id}?probeVideo=1`));expect(old.statusCode).toBe(200);
    expect(h3ReferenceDurationNote(old.json().metadata.durationSeconds)).toContain("first 15 seconds");
    expect(old.json().storage_key).toBeUndefined();
    const invalid=await upload(Buffer.from("not a video"));expect(invalid.statusCode).toBe(200);expect(invalid.json().metadata.durationSeconds).toBeUndefined();
    expect((await request("DELETE",url(`assets/${long.json().id}`))).statusCode).toBe(200);
    expect((await request("DELETE",url(`assets/${invalid.json().id}`))).statusCode).toBe(200);
  },30000);
  it("retrieves a selected older asset from the actual server without importing another project's asset",async()=>{
    const otherProject=randomUUID(),otherAsset=randomUUID(),newer=randomUUID();
    await pool.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Other',$3)",[otherProject,workspaceId,ownerId]);
    for(const [id,project,name] of [[otherAsset,otherProject,"other.png"],[newer,projectId,"newer.png"]])
      await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,created_at) VALUES($1,$2,$3,$4,'image','image/png',$5,$6,1,$7,now()+interval '1 minute')",[id,workspaceId,project,name,`${workspaceId}/${id}`,"a".repeat(64),ownerId]);
    const call:Call=async path=>{const response=await request("GET",`/api/v1${path}${path.includes("?projectId=")?"&limit=1":""}`);if(response.statusCode!==200)throw new Error(`HTTP ${response.statusCode}`);return response.json();};
    const result=await composerAssets(call,workspaceId,projectId,[assetId,otherAsset]);
    expect(result.items.map(asset=>asset.id)).toEqual(expect.arrayContaining([newer,assetId]));
    expect(result.items.map(asset=>asset.id)).not.toContain(otherAsset);
    const first=await request("GET",url(`assets?projectId=${projectId}&limit=1`));
    expect(first.statusCode).toBe(200);
    expect(first.json().items.map((asset:any)=>asset.id)).toEqual([newer]);
    expect(first.json().nextCursor).toBeTruthy();
    const second=await request("GET",url(`assets?projectId=${projectId}&limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`));
    expect(second.statusCode).toBe(200);
    expect(second.json().items.map((asset:any)=>asset.id)).toEqual([assetId]);
    const lookupCall:Call=async(path,method,body)=>{const response=await request((method??"GET") as "GET"|"POST",`/api/v1${path}`,ownerCookie,body);if(response.statusCode!==200)throw new Error(`HTTP ${response.statusCode}`);return response.json();};
    const outputs=await composerResultAssets(lookupCall,workspaceId,projectId,[assetId,otherAsset,assetId]);
    expect(outputs.map(asset=>asset.id)).toEqual([assetId]);
    await pool.query("UPDATE assets SET metadata=jsonb_build_object('libraryHidden',true) WHERE id=$1",[assetId]);
    expect(await composerResultAssets(lookupCall,workspaceId,projectId,[assetId])).toEqual([]);
    await pool.query("UPDATE assets SET metadata='{}'::jsonb WHERE id=$1",[assetId]);
  });
  it("accepts self-contained GLB derivatives, filters Library models and rejects invalid uploads",async()=>{
    const upload=async(bytes:Buffer,cookie=ownerCookie,parentId=assetId)=>{const boundary="cf-glb-test";return server.app.inject({method:"POST",url:url(`assets?projectId=${projectId}&kind=model3d&parentId=${parentId}`),headers:{origin,cookie,"content-type":`multipart/form-data; boundary=${boundary}`},payload:Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="model.glb"\r\nContent-Type: model/gltf-binary\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)])});};
    const json=Buffer.from(JSON.stringify({asset:{version:"2.0"},scenes:[{}],scene:0}).padEnd(64," ")),bytes=Buffer.alloc(20+json.length);bytes.writeUInt32LE(0x46546c67,0);bytes.writeUInt32LE(2,4);bytes.writeUInt32LE(bytes.length,8);bytes.writeUInt32LE(json.length,12);bytes.writeUInt32LE(0x4e4f534a,16);json.copy(bytes,20);
    expect((await upload(bytes,viewerCookie)).statusCode).toBe(403);
    expect((await upload(Buffer.from("not a model"))).statusCode).toBe(422);
    expect((await upload(bytes,ownerCookie,randomUUID())).statusCode).toBe(404);
    const saved=await upload(bytes);expect(saved.statusCode).toBe(200);expect(saved.json()).toMatchObject({media_type:"model3d",parent_id:assetId});
    const list=await request("GET",url(`assets?projectId=${projectId}&kind=model3d`));expect(list.statusCode).toBe(200);expect(list.json().items.map((a:any)=>a.id)).toContain(saved.json().id);
    expect((await request("DELETE",url(`assets/${saved.json().id}`))).statusCode).toBe(200);
  });
  it("requires creator access and protects files referenced by another asset",async()=>{
    expect((await request("DELETE",url(`assets/${assetId}`),viewerCookie)).statusCode).toBe(403);
    const child=randomUUID();await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id) VALUES($1,$2,$3,'version.png','image','image/png',$4,$5,1,$6,$7)",[child,workspaceId,projectId,`${workspaceId}/${child}`,"b".repeat(64),ownerId,assetId]);
    const removed=await request("DELETE",url(`assets/${assetId}`));expect(removed.statusCode).toBe(200);expect(removed.json()).toEqual({removed:true,retained:true});
    expect((await request("GET",url(`assets?projectId=${projectId}`))).json().items.map((item:any)=>item.id)).not.toContain(assetId);
    expect((await request("GET",url(`assets/${assetId}/content`))).statusCode).toBe(200);
    expect((await request("DELETE",url(`assets/${child}`))).statusCode).toBe(200);
    await pool.query("UPDATE assets SET metadata=metadata-'libraryHidden' WHERE id=$1",[assetId]);
  });
  it("protects legacy JSON run outputs and does not cross workspace boundaries",async()=>{
    const runId=randomUUID(),resultId=randomUUID();
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'result.png','image','image/png',$4,$5,1,$6)",[resultId,workspaceId,projectId,`${workspaceId}/${resultId}`,"c".repeat(64),ownerId]);
    await pool.query("INSERT INTO runs(id,workspace_id,project_id,created_by,capability_id,capability_version,route_id,state,invocation,request_hash,idempotency_key,output_ids) VALUES($1,$2,$3,$4,'fixture','1','local','succeeded','{}','fixture',$6,$5)",[runId,workspaceId,projectId,ownerId,JSON.stringify([resultId]),runId]);
    expect((await request("DELETE",url(`assets/${resultId.toUpperCase()}`))).statusCode).toBe(200);
    expect((await request("GET",url(`assets/${resultId}`))).statusCode).toBe(404);
    expect((await pool.query("SELECT output_ids FROM runs WHERE id=$1",[runId])).rows[0].output_ids).toEqual([]);
    await pool.query("DELETE FROM runs WHERE id=$1",[runId]);
    const other=randomUUID();
    await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Other fixture')",[other]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'creator')",[other,ownerId]);
    expect((await request("DELETE",`/api/v1/workspaces/${other}/assets/${assetId}`)).statusCode).toBe(404);
  });
  it("omits retained hidden outputs from the gallery without deleting run history",async()=>{
    const runId=randomUUID(),visibleId=randomUUID();
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'visible.png','image','image/png',$4,$5,1,$6)",[visibleId,workspaceId,projectId,`${workspaceId}/${visibleId}`,"d".repeat(64),ownerId]);
    await pool.query("UPDATE assets SET metadata=jsonb_build_object('libraryHidden',true) WHERE id=$1",[assetId]);
    await pool.query("INSERT INTO runs(id,workspace_id,project_id,created_by,capability_id,capability_version,route_id,state,invocation,request_hash,idempotency_key,output_ids) VALUES($1,$2,$3,$4,'fixture','1','local','succeeded','{}','fixture',$5,$6)",[runId,workspaceId,projectId,ownerId,runId,JSON.stringify([assetId,visibleId])]);
    const list=await request("GET",url(`runs?projectId=${projectId}`));const run=list.json().find((item:any)=>item.id===runId);
    expect(run.output_ids).toEqual([visibleId]);expect(run.output_content_type).toBe('image/png');
    const detail=await request("GET",url(`runs/${runId}`));expect(detail.json().output_ids).toEqual([assetId,visibleId]);
    await pool.query("DELETE FROM runs WHERE id=$1",[runId]);await pool.query("DELETE FROM assets WHERE id=$1",[visibleId]);await pool.query("UPDATE assets SET metadata=metadata-'libraryHidden' WHERE id=$1",[assetId]);
  });
  it("retains a durable cleanup receipt after disk failure and completes on retry",async()=>{
    const path=join(storageRoot,workspaceId,storageKey.split("/")[1]);
    await stat(path);
    const remove=vi.spyOn(DiskStore.prototype,"remove").mockRejectedValueOnce(Object.assign(new Error("Fixture disk busy"),{code:"EBUSY"}));
    try { expect((await request("DELETE",url(`assets/${assetId}`))).statusCode).toBe(503); }
    finally { remove.mockRestore(); }
    expect((await request("GET",url(`assets/${assetId}`))).statusCode).toBe(404);
    expect((await pool.query("SELECT completed_at FROM asset_deletions WHERE workspace_id=$1 AND asset_id=$2",[workspaceId,assetId])).rows[0].completed_at).toBeNull();
    expect((await request("GET",url(`assets?projectId=${projectId}`))).json().pendingDeletion).toEqual({id:assetId,name:"portrait.png"});
    expect((await request("GET",url(`assets?projectId=${projectId}`),viewerCookie)).json().pendingDeletion).toBeUndefined();
    expect((await request("DELETE",url(`projects/${projectId}`))).statusCode).toBe(409);
    await stat(path);
    expect((await request("DELETE",url(`assets/${assetId}`))).json()).toEqual({removed:true});
    expect((await request("GET",url(`assets/${assetId}`))).statusCode).toBe(404);
    await expect(stat(path)).rejects.toMatchObject({code:"ENOENT"});
    expect((await request("DELETE",url(`assets/${assetId}`))).json()).toEqual({removed:true});
    expect((await pool.query("SELECT completed_at FROM asset_deletions WHERE workspace_id=$1 AND asset_id=$2",[workspaceId,assetId])).rows[0].completed_at).not.toBeNull();
    expect((await request("GET",url(`assets?projectId=${projectId}`))).json().pendingDeletion).toBeUndefined();
  });
});
