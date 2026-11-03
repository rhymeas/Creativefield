import path from "node:path";
import {tmpdir} from "node:os";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { randomBytes,randomUUID } from "node:crypto";
import { mkdir,mkdtemp,rm } from "node:fs/promises";
import { Pool } from "pg";
import sharp from "sharp";
import { buildServer } from "../server/app";
import { bootstrap } from "../server/auth";
import { hashPassword } from "../server/crypto";
import { migrate } from "../server/db";
import type { ServerConfig } from "../server/config";

const tempBase=path.resolve(process.env.COMFYFIELD_TEST_TEMP_ROOT ?? tmpdir());
const connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("marketing studio against real PostgreSQL",()=>{
  const schema=`cf_marketing_${randomUUID().replaceAll("-","")}`;
  const origin="http://localhost:5173",password="Fixture-only-password-527!";
  let adminPool:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,config:ServerConfig,storageRoot:string;
  let workspaceId:string,adminCookie:string,viewerCookie:string;
  const url=(tail:string)=>`/api/v1/workspaces/${workspaceId}/marketing/${tail}`;
  const request=(method:"GET"|"POST"|"PATCH",target:string,payload?:unknown,cookie=adminCookie)=>server.app.inject({method,url:target,headers:{origin,cookie},payload:payload as Record<string,unknown>});
  async function login(email:string){
    const response=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email,password}});
    expect(response.statusCode).toBe(200);return String(response.headers["set-cookie"]).split(";")[0];
  }
  async function upload(projectId:string,png:Buffer){
    const boundary=`cf-${randomUUID()}`;
    const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="product.png"\r\nContent-Type: image/png\r\n\r\n`),png,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response=await server.app.inject({method:"POST",url:`/api/v1/workspaces/${workspaceId}/assets?projectId=${projectId}`,headers:{origin,cookie:adminCookie,"content-type":`multipart/form-data; boundary=${boundary}`},payload});
    expect(response.statusCode).toBe(200);return response.json().id as string;
  }
  beforeAll(async()=>{
    await mkdir(tempBase,{recursive:true});
    storageRoot=await mkdtemp(path.join(tempBase,"cf-marketing-"));
    adminPool=new Pool({connectionString});await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);await migrate(pool);
    config={databaseUrl:connectionString!,storageRoot,masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:5*1024*1024,cookieSecure:false};
    workspaceId=(await bootstrap(pool,"admin-marketing@example.test",password,"Marketing Studio")).workspaceId;
    const viewerId=randomUUID();await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",[viewerId,"viewer-marketing@example.test",await hashPassword(password)]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[workspaceId,viewerId]);
    server=await buildServer(config,pool);await server.app.ready();adminCookie=await login("admin-marketing@example.test");viewerCookie=await login("viewer-marketing@example.test");
  },30000);
  afterAll(async()=>{
    await server?.app.close();await pool?.end();
    if(adminPool){await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);await adminPool.end();}
    if(storageRoot && path.dirname(path.resolve(storageRoot))===tempBase && path.basename(storageRoot).startsWith("cf-marketing-"))await rm(storageRoot,{recursive:true,force:true});
  });
  it("creates, authorizes, renders, replays, persists, and recovers immutable PNG variants",async()=>{
    expect((await request("GET",url("brand-kits"),undefined,"")).statusCode).toBe(401);
    const project=(await request("POST",`/api/v1/workspaces/${workspaceId}/projects`,{name:"Campaign"})).json();
    const sibling=(await request("POST",`/api/v1/workspaces/${workspaceId}/projects`,{name:"Sibling"})).json();
    const image=await sharp({create:{width:360,height:480,channels:4,background:"#2FA8FF"}}).png().toBuffer();
    const imageAssetId=await upload(project.id,image),siblingAssetId=await upload(sibling.id,image);
    const brandResponse=await request("POST",url("brand-kits"),{name:"Approved brand",primaryColor:"#2FA8FF",backgroundColor:"#F7F9FB",textColor:"#101418"});
    expect(brandResponse.statusCode).toBe(200);const brand=brandResponse.json();
    expect((await request("POST",url("products"),{projectId:project.id,name:"Wrong source",description:"",imageAssetId:siblingAssetId,additionalAssetIds:[]})).statusCode).toBe(422);
    const productResponse=await request("POST",url("products"),{projectId:project.id,name:"Bottle",description:"Approved reference",imageAssetId,additionalAssetIds:[]});
    expect(productResponse.statusCode).toBe(200);const product=productResponse.json();
    const briefBody={projectId:project.id,brandKitId:brand.id,productId:product.id,objective:"Launch the approved product",format:"square_1080",headline:"Made for focused work",body:"A durable product story composed from approved local assets.",cta:"Review product",variantCount:2};
    const briefResponse=await request("POST",url("briefs"),briefBody);expect(briefResponse.statusCode).toBe(200);const brief=briefResponse.json();
    const renderBody={projectId:project.id,briefId:brief.id,idempotencyKey:"marketing-integration-001"};
    expect((await request("POST",url("renders"),renderBody,viewerCookie)).statusCode).toBe(403);
    expect((await request("GET",url(`briefs?projectId=${project.id}`),undefined,viewerCookie)).statusCode).toBe(200);
    const rendered=await request("POST",url("renders"),renderBody);expect(rendered.statusCode).toBe(200);expect(rendered.json().repeated).toBe(false);
    expect(rendered.json().variants).toHaveLength(2);expect(rendered.json().variants.every((variant:{state:string})=>variant.state==="succeeded")).toBe(true);
    const first=rendered.json().variants[0];expect(JSON.stringify(first)).not.toContain("storage_key");
    const content=await server.app.inject({method:"GET",url:`/api/v1/workspaces/${workspaceId}/assets/${first.outputAssetId}/content`,headers:{cookie:viewerCookie}});
    expect(content.statusCode).toBe(200);expect(content.rawPayload.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));expect(await sharp(content.rawPayload).metadata()).toMatchObject({format:"png",width:1080,height:1080});
    const replay=await request("POST",url("renders"),renderBody);expect(replay.statusCode).toBe(200);expect(replay.json().repeated).toBe(true);expect(replay.json().variants.map((variant:{id:string})=>variant.id)).toEqual(rendered.json().variants.map((variant:{id:string})=>variant.id));
    const patched=await request("PATCH",url(`briefs/${brief.id}`),{revision:brief.revision,...briefBody,projectId:undefined,headline:"A revised campaign"});
    expect(patched.statusCode).toBe(200);expect((await request("POST",url("renders"),renderBody)).statusCode).toBe(409);
    const source=rendered.json().variants[1];const recoveryId=randomUUID();
    await pool.query(`INSERT INTO marketing_variants(id,workspace_id,project_id,brief_id,created_by,variant_index,snapshot,recipe_id,recipe_version,recipe_sha256,state,idempotency_key,payload_hash)
      SELECT $1,workspace_id,project_id,brief_id,created_by,variant_index,snapshot,recipe_id,recipe_version,recipe_sha256,'queued','marketing-recovery-fixture',$2 FROM marketing_variants WHERE id=$3`,[recoveryId,"f".repeat(64),source.id]);
    await server.app.close();server=await buildServer(config,pool);await server.app.ready();await server.marketing.recover();
    const recovered=(await pool.query("SELECT state,output_asset_id FROM marketing_variants WHERE id=$1",[recoveryId])).rows[0];expect(recovered.state).toBe("succeeded");expect(recovered.output_asset_id).toBeTruthy();
    const persisted=await request("GET",url(`variants?projectId=${project.id}`));expect(persisted.statusCode).toBe(200);expect(persisted.json().some((variant:{id:string})=>variant.id===first.id)).toBe(true);
  },45000);
});
