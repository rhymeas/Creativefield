import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Pool} from "pg";
import {spawnSync} from "node:child_process";
import {randomBytes,randomUUID} from "node:crypto";
import {readFile,rm} from "node:fs/promises";
import {Readable} from "node:stream";
import path from "node:path";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import {inspectReplaceClip,REPLACE_CLIP_MAX_FRAMES,scailChunkCount} from "../server/replace-clip-check";
import {motionFixtures} from "./motion-fixtures";
import type {ServerConfig} from "../server/config";

const binariesAvailable=spawnSync(process.env.FFMPEG_PATH??"ffmpeg",["-version"],{windowsHide:true}).status===0
  &&spawnSync(process.env.FFPROBE_PATH??"ffprobe",["-version"],{windowsHide:true}).status===0;
let fixtures:Awaited<ReturnType<typeof motionFixtures>>;
beforeAll(async()=>{if(binariesAvailable)fixtures=await motionFixtures();});
afterAll(async()=>{
  if(fixtures&&path.resolve(fixtures.dir).startsWith(path.resolve((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform")+path.sep))
    await rm(fixtures.dir,{recursive:true,force:true});
});

describe("replace clip passes",()=>{
  it("gives a clip of up to 81 frames one pass and every 76 frames after that one more",()=>{
    expect([1,76,80,81].map(scailChunkCount)).toEqual([1,1,1,1]);
    expect([82,96,157].map(scailChunkCount)).toEqual([2,2,2]);
    expect(scailChunkCount(158)).toBe(3);
    expect(scailChunkCount(REPLACE_CLIP_MAX_FRAMES)).toBe(8);
    expect(scailChunkCount(REPLACE_CLIP_MAX_FRAMES+1)).toBe(9);
  });
});

describe.skipIf(!binariesAvailable)("replace clip frames",()=>{
  it("measures a real clip: 96 frames is two passes",async()=>{
    const clip=await fixtures.make("replace-96","testsrc2=size=64x64:rate=24",96),result=await inspectReplaceClip(clip);
    expect(result).toMatchObject({frames:96,chunks:2});
    expect(result.seconds).toBeCloseTo(4,2);
  });

  it("measures a clip at the eight-pass limit",async()=>{
    const clip=await fixtures.make("replace-613","testsrc2=size=64x64:rate=24",REPLACE_CLIP_MAX_FRAMES);
    expect(await inspectReplaceClip(clip)).toMatchObject({frames:REPLACE_CLIP_MAX_FRAMES,chunks:8});
  });

  it("refuses a clip longer than eight passes, and a file that is not a clip",async()=>{
    const clip=await fixtures.make("replace-long","testsrc2=size=64x64:rate=24",REPLACE_CLIP_MAX_FRAMES+24);
    await expect(inspectReplaceClip(clip)).rejects.toThrow(new RegExp(String(REPLACE_CLIP_MAX_FRAMES)));
    await expect(inspectReplaceClip(path.join(fixtures.dir,"missing.mp4"))).rejects.toMatchObject({statusCode:422});
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL||!binariesAvailable)("replace clip check route",()=>{
  const schema=`cf_replace_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173",password="Replace-fixture-password-28!";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,workspaceId:string,userId:string,projectId:string,cookie:string;
  const url=(tail:string)=>`/api/v1/workspaces/${workspaceId}/${tail}`;
  const clipCheck=(assetId:string)=>server.app.inject({method:"GET",url:url(`replace-clip-check?assetId=${assetId}`),headers:{origin,cookie}});
  async function asset(name:string,kind:string,type:string,bytes:Buffer){
    const saved=await server.store.put(workspaceId,Readable.from(bytes)),id=randomUUID();
    return (await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
      [id,workspaceId,projectId,name,kind,type,saved.key,saved.sha256,saved.bytes,userId])).rows[0];
  }
  async function video(name:string,frames:number){return asset(name,"video","video/mp4",await readFile(await fixtures.make(name,"testsrc2=size=64x64:rate=24",frames)));}

  beforeAll(async()=>{
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    workspaceId=(await bootstrap(pool,"replace-clip@example.test",password,"Replace clip")).workspaceId;
    userId=(await pool.query("SELECT id FROM users WHERE email='replace-clip@example.test'")).rows[0].id;
    const config:ServerConfig={databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot:fixtures.store.root,masterKey:randomBytes(32),publicOrigin:origin,
      host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:32*1024*1024,cookieSecure:false};
    server=await buildServer(config,pool);await server.app.ready();
    const login=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"replace-clip@example.test",password}});
    cookie=String(login.headers["set-cookie"]).split(";")[0];
    projectId=(await server.app.inject({method:"POST",url:url("projects"),headers:{origin,cookie},payload:{name:"Replace clip"}})).json().id;
  });
  afterAll(async()=>{
    await server?.app.close();await pool?.end();
    if(root){await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await root.end();}
  });

  it("names the frames, seconds and passes of a source clip",async()=>{
    const clip=await video("replace-route-96",96),response=await clipCheck(clip.id);
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json()).toMatchObject({frames:96,chunks:2});
    expect(response.json().seconds).toBeCloseTo(4,2);
  });

  it("refuses a clip longer than eight passes",async()=>{
    const clip=await video("replace-route-long",REPLACE_CLIP_MAX_FRAMES+24),response=await clipCheck(clip.id);
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain(String(REPLACE_CLIP_MAX_FRAMES));
  });

  it("refuses a missing clip, an image and a request without a clip id",async()=>{
    expect((await clipCheck(randomUUID())).statusCode).toBe(404);
    const image=await asset("Still","image","image/png",await readFile("test/assets/motion-character.png"));
    expect((await clipCheck(image.id)).statusCode).toBe(422);
    expect((await server.app.inject({method:"GET",url:url("replace-clip-check"),headers:{origin,cookie}})).statusCode).toBe(400);
  });
});
