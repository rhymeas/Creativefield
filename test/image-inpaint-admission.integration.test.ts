import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp} from "node:fs/promises";
import {Readable} from "node:stream";
import sharp from "sharp";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {loadServerCatalogue} from "../server/catalogue";
import {migrate} from "../server/db";
import type {ServerConfig} from "../server/config";
import type {CapabilityBundle} from "../src/capabilities/types";

const connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("aligned still image/mask admission against real PostgreSQL",()=>{
  const schema=`cf_admit_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173";
  let admin:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,bundle:CapabilityBundle;
  let workspaceId:string,projectId:string,otherProjectId:string,workerId:string,owner:string,cookie:string;
  function url(tail:string){return `/api/v1/workspaces/${workspaceId}/${tail}`;}
  async function api(method:"GET"|"POST",tail:string,payload?:unknown){return server.app.inject({method,url:url(tail),headers:{origin,cookie},payload:payload as any});}
  function receipt(semantic:string,width:number,height:number){return {imageValidation:{validationVersion:1,format:"png",width,height,hasAlpha:false,semantic}};}
  async function pngAsset(mediaType:"image"|"mask",width:number,height:number,metadata:Record<string,unknown>,project=projectId,contentType="image/png"){
    const bytes=await sharp({create:{width,height,channels:4,background:{r:40,g:80,b:120,alpha:1}}}).png().toBuffer();
    const stored=await server.store.put(workspaceId,Readable.from(bytes)),id=randomUUID();
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[id,workspaceId,project,`${mediaType}-${width}x${height}.png`,mediaType,contentType,stored.key,stored.sha256,stored.bytes,owner,JSON.stringify(metadata)]);
    return {id,sha256:stored.sha256};
  }
  function submission(sourceId:string,maskId:string){
    return {projectId,workerId,idempotencyKey:randomUUID(),capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_image:sourceId,edit_mask:maskId},controls:{prompt:"Replace the selected area",negative:"",seed:7,steps:2,denoise:1},audioPolicy:"mute"};
  }
  async function runCount(){return Number((await pool.query("SELECT count(*)::int AS n FROM runs WHERE workspace_id=$1 AND capability_id=$2",[workspaceId,bundle.manifest.id])).rows[0].n);}
  beforeAll(async()=>{
    admin=new Pool({connectionString});await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    const config:ServerConfig={databaseUrl:connectionString!,storageRoot:await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/admission-test-"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false};
    workspaceId=(await bootstrap(pool,"admission@example.test","Fixture-password-long-27!","Admission tests")).workspaceId;
    const shipped=await loadServerCatalogue();
    const catalogue=shipped.map(candidate=>{
      if(candidate.manifest.id!=="image-edit-sd21-inpaint")return candidate;
      const clone=structuredClone(candidate);clone.manifest.routes[0].implementation="implemented";return clone;
    });
    server=await buildServer(config,pool,{catalogue});await server.app.ready();
    bundle=catalogue.find(candidate=>candidate.manifest.id==="image-edit-sd21-inpaint")!;
    expect(bundle.manifest.imageInputContract?.dimensionMultiple).toBe(8);
    const login=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"admission@example.test",password:"Fixture-password-long-27!"}});
    cookie=String(login.headers["set-cookie"]).split(";")[0];
    projectId=(await api("POST","projects",{name:"Admission fixture"})).json().id;
    otherProjectId=(await api("POST","projects",{name:"Other fixture"})).json().id;
    owner=(await pool.query("SELECT created_by FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,projectId])).rows[0].created_by;
    workerId=(await api("POST","workers",{name:"Admission worker",origin:"http://127.0.0.1:9",apiPrefix:""})).json().id;
    const requirements=bundle.manifest.routes[0].requirements;
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:requirements.filter(r=>r.kind==="node").map(r=>r.name),models:requirements.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),credentials:[]}),workerId]);
  },30000);
  afterAll(async()=>{await server?.execution.close();await server?.app.close();await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});

  it("accepts aligned receipts and freezes the admission snapshot",async()=>{
    const source=await pngAsset("image",16,16,receipt("image",16,16));
    const mask=await pngAsset("mask",16,16,receipt("mask",16,16));
    const res=await api("POST","runs",submission(source.id,mask.id));
    expect(res.statusCode,res.body).toBe(200);expect(res.json().state).toBe("pending");
    const invocation=(await pool.query("SELECT invocation FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,res.json().id])).rows[0].invocation;
    expect(invocation.imageInputSnapshot).toEqual({validationVersion:1,contract:"aligned_still_image_mask_v1",sourceAssetId:source.id,sourceSha256:source.sha256,maskAssetId:mask.id,maskSha256:mask.sha256,width:16,height:16,dimensionMultiple:8,semantics:"white_edits_black_preserves"});
    expect((await pool.query("SELECT state FROM run_artifact_slots WHERE workspace_id=$1 AND run_id=$2",[workspaceId,res.json().id])).rows).toEqual([{state:"planned"}]);
  });

  it("rejects mismatched and non-multiple-of-8 dimensions before creating a run",async()=>{
    const before=await runCount();
    const source=await pngAsset("image",16,16,receipt("image",16,16));
    const mismatched=await pngAsset("mask",16,32,receipt("mask",16,32));
    expect((await api("POST","runs",submission(source.id,mismatched.id))).statusCode).toBe(422);
    const small=await pngAsset("image",12,12,receipt("image",12,12));
    const smallMask=await pngAsset("mask",12,12,receipt("mask",12,12));
    expect((await api("POST","runs",submission(small.id,smallMask.id))).statusCode).toBe(422);
    expect(await runCount()).toBe(before);
  });

  it("rejects wrong semantics and non-PNG assets with forged receipts",async()=>{
    const before=await runCount();
    const source=await pngAsset("image",16,16,receipt("image",16,16));
    const wrongMask=await pngAsset("mask",16,16,receipt("image",16,16));
    expect((await api("POST","runs",submission(source.id,wrongMask.id))).statusCode).toBe(422);
    const wrongSource=await pngAsset("image",16,16,receipt("mask",16,16));
    const mask=await pngAsset("mask",16,16,receipt("mask",16,16));
    expect((await api("POST","runs",submission(wrongSource.id,mask.id))).statusCode).toBe(422);
    const jpeg=await pngAsset("image",16,16,receipt("image",16,16),projectId,"image/jpeg");
    expect((await api("POST","runs",submission(jpeg.id,mask.id))).statusCode).toBe(422);
    expect(await runCount()).toBe(before);
  });

  it("rejects missing and malformed receipts before creating a run",async()=>{
    const before=await runCount();
    const source=await pngAsset("image",16,16,receipt("image",16,16));
    const missing=await pngAsset("mask",16,16,{});
    expect((await api("POST","runs",submission(source.id,missing.id))).statusCode).toBe(422);
    const malformed=await pngAsset("mask",16,16,{imageValidation:{validationVersion:1,format:"png",width:"16",height:16,hasAlpha:false,semantic:"mask"}});
    expect((await api("POST","runs",submission(source.id,malformed.id))).statusCode).toBe(422);
    const forged=await pngAsset("mask",16,16,{imageValidation:{validationVersion:1,format:"png",width:16,height:16,hasAlpha:false,semantic:"mask",decoder:"forged"}});
    expect((await api("POST","runs",submission(source.id,forged.id))).statusCode).toBe(422);
    const wrongVersion=await pngAsset("mask",16,16,{imageValidation:{validationVersion:2,format:"png",width:16,height:16,hasAlpha:false,semantic:"mask"}});
    expect((await api("POST","runs",submission(source.id,wrongVersion.id))).statusCode).toBe(422);
    expect(await runCount()).toBe(before);
  });

  it("preserves project scoping from input resolution",async()=>{
    const foreign=await pngAsset("image",16,16,receipt("image",16,16),otherProjectId);
    const mask=await pngAsset("mask",16,16,receipt("mask",16,16));
    expect((await api("POST","runs",submission(foreign.id,mask.id))).statusCode).toBe(404);
  });
});
