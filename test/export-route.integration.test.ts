import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {execFile,spawnSync} from "node:child_process";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {promisify} from "node:util";
import {Pool} from "pg";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {hashPassword} from "../server/crypto";
import {migrate} from "../server/db";
import type {ServerConfig} from "../server/config";

const execute=promisify(execFile);
const tempBase=path.resolve(process.env.COMFYFIELD_TEST_TEMP_ROOT ?? tmpdir());
const connectionString=process.env.TEST_DATABASE_URL;
const binariesAvailable=spawnSync(process.env.FFMPEG_PATH??"ffmpeg",["-version"],{windowsHide:true}).status===0&&spawnSync(process.env.FFPROBE_PATH??"ffprobe",["-version"],{windowsHide:true}).status===0;

describe.skipIf(!connectionString||!binariesAvailable)("export profile route against real PostgreSQL and FFmpeg",()=>{
  const schema=`cf_export_${randomUUID().replaceAll("-","")}`;
  const origin="http://localhost:5173",password="Fixture-only-password-528!";
  let adminPool:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,config:ServerConfig,storageRoot:string;
  let workspaceId:string,adminCookie:string,viewerCookie:string,projectId:string;
  const url=(tail:string)=>`/api/v1/workspaces/${workspaceId}/${tail}`;
  const request=(method:"GET"|"POST",target:string,payload?:unknown,cookie=adminCookie)=>server.app.inject({method,url:target,headers:{origin,cookie},payload:payload as Record<string,unknown>});
  async function login(email:string){
    const response=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email,password}});
    expect(response.statusCode).toBe(200);return String(response.headers["set-cookie"]).split(";")[0];
  }
  async function upload(file:Buffer,filename:string,contentType:string){
    const boundary=`cf-${randomUUID()}`;
    const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),file,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response=await server.app.inject({method:"POST",url:url(`assets?projectId=${projectId}`),headers:{origin,cookie:adminCookie,"content-type":`multipart/form-data; boundary=${boundary}`},payload});
    expect(response.statusCode).toBe(200);return response.json().id as string;
  }
  beforeAll(async()=>{
    await mkdir(tempBase,{recursive:true});
    storageRoot=await mkdtemp(path.join(tempBase,"cf-export-"));
    adminPool=new Pool({connectionString});await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    config={databaseUrl:connectionString!,storageRoot,masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:32*1024*1024,cookieSecure:false};
    workspaceId=(await bootstrap(pool,"admin-export@example.test",password,"Export profile route")).workspaceId;
    const viewerId=randomUUID();await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",[viewerId,"viewer-export@example.test",await hashPassword(password)]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[workspaceId,viewerId]);
    server=await buildServer(config,pool);await server.app.ready();adminCookie=await login("admin-export@example.test");viewerCookie=await login("viewer-export@example.test");
    projectId=(await request("POST",url("projects"),{name:"Campaign"})).json().id;
  },30000);
  afterAll(async()=>{
    await server?.app.close();await pool?.end();
    if(adminPool){await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);await adminPool.end();}
    if(storageRoot && path.dirname(path.resolve(storageRoot))===tempBase && path.basename(storageRoot).startsWith("cf-export-"))await rm(storageRoot,{recursive:true,force:true});
  });

  it("refuses viewers, unknown assets and undeclared profiles",async()=>{
    const asset=randomUUID();
    expect((await request("POST",url(`assets/${asset}/exports`),{profileId:"mp4-h264-1080p24"},viewerCookie)).statusCode).toBe(403);
    expect((await request("POST",url(`assets/${asset}/exports`),{profileId:"mp4-h264-1080p24"})).statusCode).toBe(404);
    expect((await request("POST",url(`assets/${asset}/exports`),{profileId:"mp4-h264-1080p30"})).statusCode).toBe(400);
    expect((await request("POST",url(`assets/${asset}/exports`),{})).statusCode).toBe(400);
  },30000);

  it("makes a 1080p 24 FPS MP4 with no audio and links it to the source asset",async()=>{
    const fixture=path.join(storageRoot,"source.mp4"),poster=path.join(storageRoot,"poster.png");
    // The sine track is deliberately longer than the picture: the profile must still mute it.
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","testsrc2=s=320x180:r=30:d=0.5","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=0.8","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-c:a","pcm_s16le",fixture],{timeout:20_000,windowsHide:true});
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","color=c=red:s=16x16:d=0.1","-frames:v","1",poster],{timeout:20_000,windowsHide:true});
    const sourceId=await upload(await readFile(fixture),"source.mp4","video/mp4"),imageId=await upload(await readFile(poster),"poster.png","image/png");
    expect((await request("POST",url(`assets/${imageId}/exports`),{profileId:"mp4-h264-1080p24"})).statusCode).toBe(400);

    const exported=await request("POST",url(`assets/${sourceId}/exports`),{profileId:"mp4-h264-1080p24"});
    expect(exported.statusCode).toBe(200);
    const asset=exported.json();
    expect(asset).toMatchObject({project_id:projectId,media_type:"video",content_type:"video/mp4",parent_id:sourceId});
    expect(asset.name).toMatch(/\(1080p MP4\)$/);
    expect(Number(asset.bytes)).toBeGreaterThan(0);
    expect(asset.metadata.export.profile).toMatchObject({id:"mp4-h264-1080p24",version:1,width:1920,height:1080,fps:24,audio:"mute"});
    expect(JSON.stringify(asset)).not.toContain("storage_key");
    const row=(await pool.query("SELECT project_id,media_type FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,asset.id])).rows[0];
    expect(row).toEqual({project_id:projectId,media_type:"video"});

    const content=await server.app.inject({method:"GET",url:url(`assets/${asset.id}/content?download=1`),headers:{origin,cookie:adminCookie}});
    expect(content.statusCode).toBe(200);
    expect(String(content.headers["content-disposition"])).toContain("attachment");
    const probeFile=path.join(storageRoot,"exported.mp4");await writeFile(probeFile,content.rawPayload);
    const probe=JSON.parse((await execute(process.env.FFPROBE_PATH??"ffprobe",["-v","error","-show_streams","-of","json",probeFile],{encoding:"utf8",timeout:20_000,windowsHide:true})).stdout) as {streams:Record<string,unknown>[]};
    expect(probe.streams.filter(stream=>stream.codec_type==="audio")).toHaveLength(0);
    expect(probe.streams.filter(stream=>stream.codec_type==="video")).toHaveLength(1);
    expect(probe.streams[0]).toMatchObject({codec_name:"h264",width:1920,height:1080,pix_fmt:"yuv420p",r_frame_rate:"24/1",avg_frame_rate:"24/1"});
  },60000);
});
