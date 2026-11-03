import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {Readable} from "node:stream";
import sharp from "sharp";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {loadServerCatalogue} from "../server/catalogue";
import {migrate} from "../server/db";
import {encodeMonoWav} from "../src/team/audio/microphone";
import type {CapabilityBundle} from "../src/capabilities/types";

const connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("lip-sync admission against real PostgreSQL",()=>{
  const schema=`cf_lip_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173";
  let admin:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,bundle:CapabilityBundle,root:string;
  let ws:string,project:string,other:string,worker:string,owner:string,cookie:string,portrait:string,audio:string;
  const api=(tail:string,payload:unknown)=>server.app.inject({method:"POST",url:`/api/v1/workspaces/${ws}/${tail}`,headers:{origin,cookie},payload:payload as any});
  async function asset(kind:string,bytes:Buffer,projectId=project){
    const stored=await server.store.put(ws,Readable.from(bytes)),id=randomUUID(),type=kind==="image"?"image/png":"audio/wav";
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}')",[id,ws,projectId,"fixture",kind,type,stored.key,stored.sha256,stored.bytes,owner]);return id;
  }
  const payload=(overrides:Record<string,unknown>={})=>({projectId:project,workerId:worker,idempotencyKey:randomUUID(),capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{start_image:portrait,source_audio:audio},controls:{length:1.6,audio_start:.5},audioPolicy:"replace",consent:{voice:true},...overrides});
  const count=async()=>Number((await pool.query("SELECT count(*)::int AS n FROM runs")).rows[0].n);
  beforeAll(async()=>{
    admin=new Pool({connectionString});await admin.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    root=await mkdtemp(path.join(tmpdir(),"comfyfield-lip-admit-"));
    ws=(await bootstrap(pool,"lip@example.test","Fixture-password-92874!","Lip tests")).workspaceId;
    const catalogue=await loadServerCatalogue();bundle=catalogue.find(b=>b.manifest.id==="lip-sync")!;bundle.manifest.routes[0].implementation="implemented";bundle.manifest.coverage.local="implemented";
    server=await buildServer({databaseUrl:connectionString!,storageRoot:root,masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false},pool,{catalogue});await server.app.ready();
    const login=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"lip@example.test",password:"Fixture-password-92874!"}});cookie=String(login.headers["set-cookie"]).split(";")[0];
    project=(await api("projects",{name:"Lip fixture"})).json().id;other=(await api("projects",{name:"Other fixture"})).json().id;owner=(await pool.query("SELECT created_by FROM projects WHERE id=$1",[project])).rows[0].created_by;
    worker=(await api("workers",{name:"Fixture worker",origin:"http://127.0.0.1:9",apiPrefix:""})).json().id;
    const req=bundle.manifest.routes[0].requirements;await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:req.filter(r=>r.kind==="node").map(r=>r.name),models:req.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),credentials:[]}),worker]);
    portrait=await asset("image",await sharp({create:{width:32,height:32,channels:3,background:"red"}}).png().toBuffer());
    audio=await asset("audio",Buffer.from(await encodeMonoWav([new Float32Array(16000*3)],16000).blob.arrayBuffer()));
  },30000);
  afterAll(async()=>{await server?.execution.close();await server?.app.close();await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}if(root){if(!path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep+"comfyfield-lip-admit-"))throw new Error("Unexpected cleanup path");await rm(root,{recursive:true,force:true});}});
  it("requires explicit voice permission before creating a run",async()=>{
    const before=await count(),res=await api("runs",payload({consent:{voice:false}}));expect(res.statusCode).toBe(422);expect(res.body).toMatch(/permission/);expect(await count()).toBe(before);
  });
  it("rejects unavailable windows, malformed WAV and foreign-project audio before queueing",async()=>{
    const before=await count();expect((await api("runs",payload({controls:{length:2,audio_start:2}}))).statusCode).toBe(422);
    const malformed=await asset("audio",Buffer.from("bad audio"));expect((await api("runs",payload({inputs:{start_image:portrait,source_audio:malformed}}))).statusCode).toBe(422);
    const foreign=await asset("audio",Buffer.from(await encodeMonoWav([new Float32Array(16000*3)],16000).blob.arrayBuffer()),other);
    expect((await api("runs",payload({inputs:{start_image:portrait,source_audio:foreign}}))).statusCode).toBe(404);expect(await count()).toBe(before);
  });
  it("freezes consent and inputs and deduplicates an acknowledged run",async()=>{
    const request=payload(),first=await api("runs",request);expect(first.statusCode).toBe(200);const second=await api("runs",request);expect(second.statusCode).toBe(200);expect(second.json().id).toBe(first.json().id);
    const row=(await pool.query("SELECT invocation FROM runs WHERE id=$1",[first.json().id])).rows[0];expect(row.invocation).toMatchObject({consent:{voice:true},inputs:{source_audio:audio},controls:{length:1.6,audio_start:.5},audioPolicy:"replace"});
  });
});
