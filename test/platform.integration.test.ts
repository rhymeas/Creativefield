import { beforeAll,afterAll,describe,it,expect } from "vitest";
import { Pool } from "pg";
import { randomBytes,randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { buildServer } from "../server/app";
import { migrate } from "../server/db";
import { bootstrap } from "../server/auth";
import { hashPassword,decryptProviderSecret } from "../server/crypto";
import type { ServerConfig } from "../server/config";
import sharp from "sharp";

const connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("team platform against real PostgreSQL",()=>{
  const schema=`cf_test_${randomUUID().replaceAll("-","")}`;
  let adminPool:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,config:ServerConfig;
  let workspaceId:string,adminCookie:string,viewerCookie:string,foreignWs:string,foreignCookie:string,projectId:string,assetId:string;
  const origin="http://localhost:5173";
  const pass="Fixture-only-password-527!";
  function request(method:"GET"|"POST"|"PUT"|"PATCH"|"DELETE",url:string,payload?:unknown,cookie=adminCookie) {
    return server.app.inject({method,url,headers:{origin,cookie},payload:payload as Record<string,unknown>});
  }
  function url(tail:string,workspace=workspaceId) {return `/api/v1/workspaces/${workspace}/${tail}`;}
  async function login(email:string) {
    const r=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email,password:pass}});
    expect(r.statusCode).toBe(200);
    return String(r.headers["set-cookie"]).split(";")[0];
  }
  beforeAll(async()=>{
    adminPool=new Pool({connectionString}); await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString,options:`-c search_path=${schema}`});
    await migrate(pool); await migrate(pool);
    config={databaseUrl:connectionString!,storageRoot:await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/media-test-"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false};
    workspaceId=(await bootstrap(pool,"admin@example.test",pass,"Studio A")).workspaceId;
    const foreignUser=randomUUID();foreignWs=randomUUID();
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",[foreignUser,"other@example.test",await hashPassword(pass)]);
    await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Studio B')",[foreignWs]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[foreignWs,foreignUser]);
    config.nodeEditorOrigin="http://localhost:8788";
    server=await buildServer(config,pool);await server.app.ready();
    adminCookie=await login("admin@example.test");foreignCookie=await login("other@example.test");
  },30000);
  afterAll(async()=>{
    await server?.app.close();await pool?.end();
    if(adminPool){await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);await adminPool.end();}
  });
  it("creates one-use invitations and enforces session/origin/role boundaries",async()=>{
    expect((await server.app.inject({method:"GET",url:url("projects")})).statusCode).toBe(401);
    expect((await server.app.inject({method:"POST",url:url("projects"),headers:{cookie:adminCookie,origin:"https://attacker.invalid"},payload:{name:"x"}})).statusCode).toBe(403);
    const inv=await request("POST",url("invitations"),{email:"viewer@example.test",role:"viewer"});expect(inv.statusCode).toBe(200);
    const accept={token:inv.json().token,password:pass};
    expect((await request("POST","/api/v1/invitations/accept",accept)).statusCode).toBe(200);
    expect((await request("POST","/api/v1/invitations/accept",accept)).statusCode).toBe(400);
    viewerCookie=await login("viewer@example.test");
    expect((await request("POST",url("projects"),{name:"forbidden"},viewerCookie)).statusCode).toBe(403);
    expect((await request("GET",url("projects"),undefined,foreignCookie)).statusCode).toBe(403);
  });
  it("persists projects and catalogues across application restart",async()=>{
    const created=await request("POST",url("projects"),{name:"Durable project"});expect(created.statusCode).toBe(200);projectId=created.json().id;
    await server.app.close(); server=await buildServer(config,pool);await server.app.ready();
    const list=await request("GET",url("projects"));expect(list.json().some((p:{id:string})=>p.id===projectId)).toBe(true);
    const catalogue=await request("GET",url("catalogue"));
    expect(new Set(catalogue.json().map((capability:{id:string})=>capability.id)).size).toBe(catalogue.json().length);
    expect(catalogue.json().find((c:{id:string})=>c.id==="wan21-vace-masked-edit").coverage.local).toBe("implemented");
    expect(catalogue.json().find((c:{id:string})=>c.id==="sam21-video-mask").coverage.local).toBe("experimental");
    expect(catalogue.json().find((c:{id:string})=>c.id==="camera").coverage.local).toBe("implemented");
    expect(catalogue.json().find((c:{id:string})=>c.id==="lip-sync").coverage.local).toBe("implemented");
    expect(catalogue.json().find((c:{id:string})=>c.id==="qwen-image-21-t2i").coverage.local).toBe("implemented");
    expect(catalogue.json().find((c:{id:string})=>c.id==="qwen-image-21-edit").coverage.local).toBe("implemented");
    expect(catalogue.json().find((c:{id:string})=>c.id==="replace-object").coverage.local).toBe("planned");
  });
  it("lists invitation metadata and makes revoked or expired codes unusable",async()=>{
    const revoked=await request("POST",url("invitations"),{email:"revoked@example.test",role:"creator"});expect(revoked.statusCode).toBe(200);
    const list=await request("GET",url("invitations"));expect(list.statusCode).toBe(200);expect(list.body).not.toContain(revoked.json().token);expect(list.body).not.toContain("token_hash");
    const id=list.json().find((i:{email:string})=>i.email==="revoked@example.test").id;
    expect((await request("DELETE",url(`invitations/${id}`),undefined,viewerCookie)).statusCode).toBe(403);
    expect((await request("DELETE",url(`invitations/${id}`))).statusCode).toBe(200);
    expect((await request("POST","/api/v1/invitations/accept",{token:revoked.json().token,password:pass})).statusCode).toBe(400);
    const expired=await request("POST",url("invitations"),{email:"expired@example.test",role:"viewer"});
    await pool.query("UPDATE invitations SET expires_at=now()-interval '1 second' WHERE email='expired@example.test'");
    expect((await request("POST","/api/v1/invitations/accept",{token:expired.json().token,password:pass})).statusCode).toBe(400);
  });
  it("stores media under generated paths and prevents foreign reads/references",async()=>{
    const boundary="cf-fixture-boundary";
    const png=await sharp({create:{width:1,height:1,channels:4,background:{r:255,g:255,b:255,alpha:1}}}).png().toBuffer();
    const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../fixture.png"\r\nContent-Type: image/png\r\n\r\n`),png,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const uploaded=await server.app.inject({method:"POST",url:url(`assets?projectId=${projectId}`),headers:{origin,cookie:adminCookie,"content-type":`multipart/form-data; boundary=${boundary}`},payload});
    expect(uploaded.statusCode).toBe(200);assetId=uploaded.json().id;
    expect(uploaded.json().metadata.imageValidation).toMatchObject({validationVersion:1,format:"png",width:1,height:1,semantic:"image"});
    expect(uploaded.json()).not.toHaveProperty("storage_key");
    const metadata=await request("GET",url(`assets/${assetId}`));expect(metadata.statusCode).toBe(200);expect(metadata.json().id).toBe(assetId);expect(metadata.json()).not.toHaveProperty("storage_key");expect(metadata.json().provenance.imageValidation.semantic).toBe("image");
    const otherProject=(await request("POST",url("projects"),{name:"Other local project"})).json().id;
    const crossParent=await server.app.inject({method:"POST",url:url(`assets?projectId=${otherProject}&parentId=${assetId}&kind=layer`),headers:{origin,cookie:adminCookie,"content-type":`multipart/form-data; boundary=${boundary}`},payload});
    expect(crossParent.statusCode).toBe(404);
    const layer=await server.app.inject({method:"POST",url:url(`assets?projectId=${projectId}&parentId=${assetId}&kind=layer`),headers:{origin,cookie:adminCookie,"content-type":`multipart/form-data; boundary=${boundary}`},payload});
    expect(layer.statusCode).toBe(200);expect(layer.json().metadata.imageValidation.semantic).toBe("layer");
    const layerDetail=await request("GET",url(`assets/${layer.json().id}`));expect(layerDetail.json().relations).toEqual([{asset_id:assetId,role:"parent",ordinal:0,metadata:{}}]);
    const viewerUpload=await server.app.inject({method:"POST",url:url(`assets?projectId=${projectId}`),headers:{origin,cookie:viewerCookie,"content-type":`multipart/form-data; boundary=${boundary}`},payload});
    expect(viewerUpload.statusCode).toBe(403);
    expect((await request("GET",url(`assets/${assetId}`,foreignWs),undefined,foreignCookie)).statusCode).toBe(404);
    const download=await request("GET",url(`assets/${assetId}/content`));expect(download.rawPayload).toEqual(png);
    const partial=await server.app.inject({method:"GET",url:url(`assets/${assetId}/content`),headers:{cookie:adminCookie,range:"bytes=1-7"}});expect(partial.statusCode).toBe(206);expect(partial.rawPayload).toEqual(png.subarray(1,8));expect(partial.headers["content-range"]).toBe(`bytes 1-7/${png.length}`);
    const head=await server.app.inject({method:"HEAD",url:url(`assets/${assetId}/content`),headers:{cookie:adminCookie}});expect(head.statusCode).toBe(200);expect(head.rawPayload.length).toBe(0);expect(head.headers["content-length"]).toBe(String(png.length));
    expect((await server.app.inject({method:"GET",url:url(`assets/${assetId}/content`),headers:{cookie:adminCookie,range:"bytes=999-"}})).statusCode).toBe(416);
    expect((await request("GET",url(`assets/${assetId}/content`,foreignWs),undefined,foreignCookie)).statusCode).toBe(404);
    const foreignProject=await request("POST",url("projects",foreignWs),{name:"Other"},foreignCookie);
    expect((await request("POST",url("storyboards"),{name:"Cross",projectId:foreignProject.json().id})).statusCode).toBe(404);
    expect((await request("POST",url("elements",foreignWs),{name:"Cross",kind:"character",assetIds:[assetId]},foreignCookie)).statusCode).toBe(404);
  });
  it("saves referenced Elements and ordered storyboards with optimistic revisions",async()=>{
    const e=await request("POST",url("elements"),{name:"Character",kind:"character",assetIds:[assetId]});expect(e.statusCode).toBe(200);
    const elements=await request("GET",url(`elements?projectId=${projectId}`));expect(elements.statusCode).toBe(200);expect(elements.json()[0]).toMatchObject({id:e.json().id,name:"Character",kind:"character",asset_ids:[assetId],assets:[{id:assetId,project_id:projectId,media_type:"image"}]});
    expect((await request("GET",url(`elements?projectId=${randomUUID()}`))).statusCode).toBe(404);
    const board=await request("POST",url("storyboards"),{name:"Board",projectId});expect(board.statusCode).toBe(200);
    const path=url(`storyboards/${board.json().id}/shots`);
    const payload={revision:1,shots:[{prompt:"First",settings:{title:"Opening shot"},durationSeconds:4,assets:[{role:"start_image",assetId}]},{prompt:"Second",durationSeconds:6}]};
    expect((await request("PUT",path,payload)).json().revision).toBe(2);
    expect((await request("PUT",path,payload)).statusCode).toBe(409);
    const read=await request("GET",url(`storyboards/${board.json().id}`));expect(read.json().shots.map((s:{prompt:string})=>s.prompt)).toEqual(["First","Second"]);
    expect(read.json().shots[0].settings.title).toBe("Opening shot");
    const boundBoard=await request("POST",url("storyboards"),{name:"Element board",projectId});expect(boundBoard.statusCode).toBe(200);
    const bound=await request("PUT",url(`storyboards/${boundBoard.json().id}/shots`),{revision:1,shots:[{prompt:"Bound",durationSeconds:4,settings:{elementInputs:{start_image:{elementId:e.json().id,assetId}}}}]});
    expect(bound.statusCode,bound.body).toBe(200);
  });
  it("persists titled planning cards before prompts and rejects oversized titles without advancing the board",async()=>{
    const created=await request("POST",url("storyboards"),{name:"Title-only plan",projectId});
    expect(created.statusCode).toBe(200);
    const id=created.json().id,path=url(`storyboards/${id}/shots`);
    const shot={prompt:"",settings:{title:"x".repeat(500)},durationSeconds:4};
    expect((await request("PUT",path,{revision:1,shots:[shot]})).json().revision).toBe(2);
    expect((await request("PUT",path,{revision:2,shots:[{...shot,settings:{title:"x".repeat(501)}}]})).statusCode).toBe(400);
    const read=(await request("GET",url(`storyboards/${id}`))).json();
    expect(read.revision).toBe(2);expect(read.shots[0]).toMatchObject({prompt:"",settings:{title:"x".repeat(500)}});
  });
  it("paginates equal and submillisecond asset timestamps without skips",async()=>{
    for(const timestamp of ["2030-01-01T00:00:00.000100Z","2030-01-01T00:00:00.000200Z","2030-01-01T00:00:00.000200Z","2030-01-01T00:00:00.000200Z","2030-01-01T00:00:00.000900Z"]){
      const id=randomUUID();await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,created_at) SELECT $1,workspace_id,project_id,'Pagination fixture',media_type,content_type,$2,sha256,bytes,created_by,$3::timestamptz FROM assets WHERE id=$4",[id,`${workspaceId}/${id}`,timestamp,assetId]);
    }
    const seen:string[]=[];let cursor:string|null=null;
    do {const response=await request("GET",url(`assets?limit=2${cursor?`&cursor=${cursor}`:""}`));expect(response.statusCode).toBe(200);const page=response.json();seen.push(...page.items.map((a:{id:string})=>a.id));cursor=page.nextCursor;}while(cursor&&seen.length<20);
    const expected=(await pool.query("SELECT id FROM assets WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC",[workspaceId])).rows.map(a=>a.id);expect(seen).toEqual(expected);
    expect((await request("GET",url("assets?cursor=bad"))).statusCode).toBe(400);
  });
  it("encrypts independent keys without readback and rejects the forbidden provider",async()=>{
    const secret="TEST-fixture-key-not-real";
    const saved=await request("POST",url("provider-connections"),{providerId:"wan",secret});expect(saved.statusCode).toBe(200);expect(saved.body).not.toContain(secret);
    const list=await request("GET",url("provider-connections"));expect(list.body).not.toContain(secret);expect(list.body).not.toContain("encrypted_secret");
    const encrypted=(await pool.query("SELECT encrypted_secret FROM provider_connections WHERE workspace_id=$1",[workspaceId])).rows[0].encrypted_secret;
    expect(encrypted).not.toContain(secret);
    expect(decryptProviderSecret(encrypted,config.masterKey,{workspaceId,providerId:"wan"})).toBe(secret);
    expect(()=>decryptProviderSecret(encrypted,config.masterKey,{workspaceId:foreignWs,providerId:"wan"})).toThrow();
    expect((await request("POST",url("provider-connections"),{providerId:"higgsfield",secret})).statusCode).toBe(400);
    expect((await request("POST",url("workers"),{name:"Forbidden",origin:"https://api.higgsfield.ai"})).statusCode).toBe(400);
    expect((await request("GET",url("provider-connections"),undefined,viewerCookie)).statusCode).toBe(403);
  });
  it("imports browser projects idempotently without claiming media import",async()=>{
    const payload={sourceId:"fixture-import",scope:"/comfy",projects:[{name:"Legacy",promptIds:["old-prompt","old-prompt"]}]};
    const a=await request("POST",url("imports/browser-projects"),payload);expect(a.statusCode).toBe(200);expect(a.json().mediaImported).toBe(false);
    const b=await request("POST",url("imports/browser-projects"),payload);expect(b.json().repeated).toBe(true);expect(b.json().projectIds).toEqual(a.json().projectIds);
    expect((await request("POST",url("imports/browser-projects"),{...payload,scope:"other"})).statusCode).toBe(409);
  });
  it("keeps worker scripts off the application origin and authorizes editor redirects",async()=>{
    const target=`${config.nodeEditorOrigin}/comfy/${workspaceId}/`;
    expect((await request("GET",url("node-editor"))).json()).toEqual({url:target});
    expect((await request("GET",url("node-editor"),undefined,viewerCookie)).statusCode).toBe(403);
    expect((await request("GET",url("node-editor"),undefined,foreignCookie)).statusCode).toBe(403);
    const legacy=await request("GET",`/comfy/${workspaceId}/`);
    expect(legacy.statusCode).toBe(302);expect(legacy.headers.location).toBe(target);
    expect((await request("POST",`/comfy/${workspaceId}/prompt`,{prompt:{}})).statusCode).toBe(404);
    expect((await request("GET","/extensions/a.js")).statusCode).toBe(404);
    const foreignWrite=await server.app.inject({method:"POST",url:url("projects"),headers:{cookie:adminCookie,origin:config.nodeEditorOrigin},payload:{name:"blocked-extension-write"}});
    expect(foreignWrite.statusCode).toBe(403);
  });
});
