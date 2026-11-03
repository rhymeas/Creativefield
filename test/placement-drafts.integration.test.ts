import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdir,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import {hashPassword} from "../server/crypto";
import type {ServerConfig} from "../server/config";
import type {PlacementDraft} from "../src/image/editor/placement-draft";

const connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("cross-device placement drafts",()=>{
  const schema=`cf_draft_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173",password="Fixture-only-password-528!";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,workspaceId:string,ownerId:string,projectId:string,otherProjectId:string,projectImageId:string,otherImageId:string,characterId:string,adminCookie:string,viewerCookie:string,foreignCookie:string,storageRoot:string;

  const url=(path:string,project=projectId,workspace=workspaceId)=>`/api/v1/workspaces/${workspace}/projects/${project}/${path}`;
  async function login(email:string){
    const response=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email,password}});
    expect(response.statusCode,response.body).toBe(200);
    return String(response.headers["set-cookie"]).split(";")[0];
  }
  async function request(method:"GET"|"POST"|"PUT"|"DELETE",path:string,payload?:any,cookie=adminCookie){
    return server.app.inject({method,url:path,headers:{origin,cookie},payload});
  }
  async function addAsset(project:string,name:string,mediaType="image",contentType="image/png"){
    const id=randomUUID();
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[
      id,workspaceId,project,name,mediaType,contentType,`${workspaceId}/${id}`,"a".repeat(64),1024,ownerId,JSON.stringify({width:512,height:768,source:"synthetic"}),
    ]);
    return id;
  }
  function draft(overrides:Partial<PlacementDraft>={}):PlacementDraft{
    return {version:1,userId:ownerId,workspaceId,projectId,assetId:projectImageId,characterId,capabilityId:"qwen-image-21-edit",capabilityVersion:"0.2.0",width:512,height:768,sceneHash:"a".repeat(64),mask:null,prompt:"Place the character in the scene.",...overrides};
  }

  beforeAll(async()=>{
    if(!connectionString)return;
    root=new Pool({connectionString});
    await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString,options:`-c search_path=${schema}`});
    await migrate(pool);
    await migrate(pool);
    const scratchRoot=process.env.COMFYFIELD_TEST_TEMP_ROOT??tmpdir();
    await mkdir(scratchRoot,{recursive:true});
    storageRoot=await mkdtemp(join(scratchRoot,"comfyfield-placement-drafts-"));
    const config:ServerConfig={databaseUrl:connectionString,storageRoot,masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false};
    ({workspaceId,userId:ownerId}=await bootstrap(pool,"admin@example.test",password,"Draft Studio"));
    const viewerId=randomUUID(),foreignId=randomUUID();
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3),($4,$5,$6)",[viewerId,"viewer@example.test",await hashPassword(password),foreignId,"foreign@example.test",await hashPassword(password)]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[workspaceId,viewerId]);
    server=await buildServer(config,pool);
    await server.app.ready();
    adminCookie=await login("admin@example.test");
    viewerCookie=await login("viewer@example.test");
    foreignCookie=await login("foreign@example.test");
    const project=await request("POST",`/api/v1/workspaces/${workspaceId}/projects`,{name:"Placement"});
    expect(project.statusCode,project.body).toBe(200);
    projectId=project.json().id;
    const other=await request("POST",`/api/v1/workspaces/${workspaceId}/projects`,{name:"Other"});
    expect(other.statusCode,other.body).toBe(200);
    otherProjectId=other.json().id;
    projectImageId=await addAsset(projectId,"project.png");
    otherImageId=await addAsset(otherProjectId,"other.png");
    const character=await request("POST",url("characters"),{idempotencyKey:randomUUID(),name:"Draft Character",referenceAssetIds:[projectImageId]});
    expect(character.statusCode,character.body).toBe(200);
    characterId=character.json().id;
  });

  afterAll(async()=>{
    await server?.app.close();
    await pool?.end();
    if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
    if(storageRoot)await rm(storageRoot,{recursive:true,force:true});
  });

  it("stores, updates, reads and deletes the current user's draft",async()=>{
    const path=url(`placement-drafts/${projectImageId}`);
    expect((await request("GET",path)).statusCode).toBe(404);
    const created=await request("PUT",path,draft());
    expect(created.statusCode,created.body).toBe(200);
    expect(created.json()).toMatchObject({draft:{projectId,assetId:projectImageId,characterId,prompt:"Place the character in the scene."}});
    const read=await request("GET",path);
    expect(read.statusCode,read.body).toBe(200);
    expect(read.json().draft.sceneHash).toBe("a".repeat(64));
    const updated=await request("PUT",path,draft({prompt:"Updated placement."}));
    expect(updated.statusCode,updated.body).toBe(200);
    expect(updated.json().draft.prompt).toBe("Updated placement.");
    expect((await request("DELETE",path)).statusCode).toBe(204);
    expect((await request("GET",path)).statusCode).toBe(404);
    expect((await request("DELETE",path)).statusCode).toBe(204);
  });

  it("rejects invalid schemas, scoped mismatches, viewers and foreign users",async()=>{
    const path=url(`placement-drafts/${projectImageId}`);
    const extra=await request("PUT",path,{...draft(),extra:true});
    expect(extra.statusCode).toBe(400);
    const mismatch=await request("PUT",path,draft({projectId:otherProjectId}));
    expect(mismatch.statusCode).toBe(422);
    const otherAsset=await request("PUT",path,draft({assetId:otherImageId}));
    expect(otherAsset.statusCode).toBe(422);
    const wrongCharacter=await request("PUT",path,draft({characterId:randomUUID()}));
    expect(wrongCharacter.statusCode).toBe(422);
    expect((await request("PUT",path,draft(),viewerCookie)).statusCode).toBe(403);
    expect((await request("GET",path,undefined,foreignCookie)).statusCode).toBe(403);
    expect((await request("GET",path,undefined,viewerCookie)).statusCode).toBe(404);
  });
});
