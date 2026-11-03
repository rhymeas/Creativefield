import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {readFile,rm} from "node:fs/promises";
import {Readable} from "node:stream";
import path from "node:path";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import {MOTION_CLIP_MAX_SECONDS} from "../server/motion-clip-check";
import {motionFixtures} from "./motion-fixtures";
import type {ServerConfig} from "../server/config";

describe.skipIf(!process.env.TEST_DATABASE_URL)("motion clip check",()=>{
  const schema=`cf_clip_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173",password="Clip-fixture-password-28!";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,f:Awaited<ReturnType<typeof motionFixtures>>,workspaceId:string,userId:string,projectId:string,cookie:string;
  const url=(tail:string)=>`/api/v1/workspaces/${workspaceId}/${tail}`;
  const clipCheck=(assetId:string)=>server.app.inject({method:"GET",url:url(`motion-clip-check?assetId=${assetId}`),headers:{origin,cookie}});
  async function asset(name:string,kind:string,type:string,bytes:Buffer){
    const saved=await server.store.put(workspaceId,Readable.from(bytes)),id=randomUUID();
    return (await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
      [id,workspaceId,projectId,name,kind,type,saved.key,saved.sha256,saved.bytes,userId])).rows[0];
  }
  async function video(name:string,frames:number){return asset(name,"video","video/mp4",await readFile(await f.make(name,"testsrc2=size=64x64:rate=24",frames)));}

  beforeAll(async()=>{
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    f=await motionFixtures();
    workspaceId=(await bootstrap(pool,"clip-check@example.test",password,"Clip check")).workspaceId;
    userId=(await pool.query("SELECT id FROM users WHERE email='clip-check@example.test'")).rows[0].id;
    const config:ServerConfig={databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot:f.store.root,masterKey:randomBytes(32),publicOrigin:origin,
      host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:32*1024*1024,cookieSecure:false};
    server=await buildServer(config,pool);await server.app.ready();
    const login=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"clip-check@example.test",password}});
    cookie=String(login.headers["set-cookie"]).split(";")[0];
    projectId=(await server.app.inject({method:"POST",url:url("projects"),headers:{origin,cookie},payload:{name:"Clip check"}})).json().id;
  });
  afterAll(async()=>{
    await server?.app.close();await pool?.end();
    if(root){await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await root.end();}
    if(f&&path.resolve(f.dir).startsWith(path.resolve((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform")+path.sep))await rm(f.dir,{recursive:true,force:true});
  });

  it("names the frames, seconds and chunks of a driving clip",async()=>{
    const clip=await video("clip-200",200),response=await clipCheck(clip.id);
    expect(response.statusCode,response.body).toBe(200);
    const body=response.json();
    expect(body.frames).toBe(200);expect(body.chunks).toBe(3);expect(body.seconds).toBeCloseTo(200/24,2);
  });

  it("accepts a clip right at the eight-chunk limit",async()=>{
    const clip=await video("clip-641",641),response=await clipCheck(clip.id);
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json()).toMatchObject({frames:641,chunks:8});
  });

  it("refuses a clip longer than the composer can render",async()=>{
    const clip=await video("clip-40s",960),response=await clipCheck(clip.id);
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain(MOTION_CLIP_MAX_SECONDS.toFixed(1));
  });

  it("refuses a missing clip, an image and a request without a clip id",async()=>{
    expect((await clipCheck(randomUUID())).statusCode).toBe(404);
    const image=await asset("Still","image","image/png",await readFile("test/assets/motion-character.png"));
    expect((await clipCheck(image.id)).statusCode).toBe(422);
    expect((await server.app.inject({method:"GET",url:url("motion-clip-check"),headers:{origin,cookie}})).statusCode).toBe(400);
  });
});
