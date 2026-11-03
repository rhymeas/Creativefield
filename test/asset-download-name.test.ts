import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import {downloadName,dispositionHeader} from "../server/resources";

const when=new Date("2026-10-27T09:30:00Z");

describe("download file names",()=>{
  it("names a worker output after its project, workflow and minute",()=>{
    const name=downloadName({name:"Flux2-Klein_00032_.png",content_type:"image/png",created_at:when},"Night Runner","Character replace");
    expect(name).toEqual({utf8:"night-runner-character-replace-2026-10-27-0930.png",ascii:"night-runner-character-replace-2026-10-27-0930.png"});
  });
  it("keeps an upload name that already reads well",()=>{
    expect(downloadName({name:"portrait.png",content_type:"image/png",created_at:when},"Night Runner","upload")).toEqual({utf8:"portrait.png",ascii:"portrait.png"});
  });
  it("renames a long digit run even when it looks like a photo",()=>{
    expect(downloadName({name:"image-1792885667649.webp",content_type:"image/webp",created_at:when},"Night Runner",null).utf8).toBe("night-runner-upload-2026-10-27-0930.webp");
  });
  it("renames a uuid-ish name",()=>{
    expect(downloadName({name:"3f2b8c1e-9d4a-4c6b-8f0e-7a1b2c3d4e5f.png",content_type:"image/png",created_at:when},"Night Runner","Depth pass").utf8).toBe("night-runner-depth-pass-2026-10-27-0930.png");
  });
  it("keeps the readable project name in the UTF-8 name and sends plain ASCII in the filename",()=>{
    const name=downloadName({name:"scail2-character-replace_00052_.mp4",content_type:"video/mp4",created_at:when},"Café Crème","Scail2 character replace");
    expect(name.utf8).toBe("café-crème-scail2-character-replace-2026-10-27-0930.mp4");
    expect(name.ascii).toBe("cafe-creme-scail2-character-replace-2026-10-27-0930.mp4");
    expect(dispositionHeader("attachment",name)).toBe(`attachment; filename="cafe-creme-scail2-character-replace-2026-10-27-0930.mp4"; filename*=UTF-8''caf%C3%A9-cr%C3%A8me-scail2-character-replace-2026-10-27-0930.mp4`);
  });
  it("does not put a folder path into a downloaded name",()=>{
    expect(downloadName({name:"../portrait.png",content_type:"image/png",created_at:when},"Night Runner","upload").ascii).toBe("night-runner-upload-2026-10-27-0930.png");
  });
  it("escapes quotes and backslashes in the quoted filename",()=>{
    const name=downloadName({name:`say "cheese" now.png`,content_type:"image/png",created_at:when},"Night Runner","upload");
    expect(name.utf8).toBe(`say "cheese" now.png`);
    expect(dispositionHeader("inline",name)).toBe(`inline; filename="say \\"cheese\\" now.png"; filename*=UTF-8''say%20%22cheese%22%20now.png`);
    expect(dispositionHeader("attachment",{ascii:`a\\b.png`,utf8:`a\\b.png`})).toBe(`attachment; filename="a\\\\b.png"; filename*=UTF-8''a%5Cb.png`);
  });
});

const connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("asset content download names",()=>{
  const schema=`cf_download_name_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173",password="Fixture-only-Download-name-527!";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,storageRoot:string,workspaceId:string,ownerId:string,projectId:string,cookie:string;
  const url=(tail:string)=>`/api/v1/workspaces/${workspaceId}/${tail}`;
  const upload=async(filename:string)=>{
    const boundary=`download${randomUUID()}`,bytes=await readFile("test/assets/render-test.png");
    const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response=await server.app.inject({method:"POST",url:url(`assets?projectId=${projectId}`),headers:{origin,cookie,"content-type":`multipart/form-data; boundary=${boundary}`},payload});
    expect(response.statusCode,response.body).toBe(200);
    return response.json().id as string;
  };
  beforeAll(async()=>{
    root=new Pool({connectionString});await root.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    storageRoot=await mkdtemp(join(process.env.COMFYFIELD_TEST_TEMP_ROOT??(process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "","comfyfield-download-name-"));
    const owner=await bootstrap(pool,"download-owner@example.test",password,"Downloads");workspaceId=owner.workspaceId;ownerId=owner.userId;
    server=await buildServer({databaseUrl:connectionString!,storageRoot,masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false},pool);await server.app.ready();
    const login=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"download-owner@example.test",password}});expect(login.statusCode).toBe(200);cookie=String(login.headers["set-cookie"]).split(";")[0];
    projectId=randomUUID();await pool.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Café Crème',$3)",[projectId,workspaceId,ownerId]);
  },30000);
  afterAll(async()=>{await server?.app.close();await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}if(storageRoot)await rm(storageRoot,{recursive:true,force:true});});
  it("keeps an upload name that reads well for both inline and download",async()=>{
    const id=await upload("portrait.png");
    const download=await server.app.inject({method:"GET",url:url(`assets/${id}/content?download=1`),headers:{origin,cookie}});
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toBe(`attachment; filename="portrait.png"; filename*=UTF-8''portrait.png`);
    const inline=await server.app.inject({method:"GET",url:url(`assets/${id}/content`),headers:{origin,cookie}});
    expect(inline.headers["content-disposition"]).toBe(`inline; filename="portrait.png"; filename*=UTF-8''portrait.png`);
  });
  it("names a run output after the project, its workflow and the minute, for inline and download alike",async()=>{
    const id=await upload("second.png");
    await pool.query("UPDATE assets SET name='Flux2-Klein_00032_.png' WHERE id=$1",[id]);
    const revisionId=randomUUID();
    await pool.query("INSERT INTO workflow_revisions(id,workspace_id,capability_id,version,sha256,manifest,graph) VALUES($1,$2,'flux2-klein-edit','1.0.0',$3,$4,'{}')",[revisionId,workspaceId,"a".repeat(64),JSON.stringify({id:"flux2-klein-edit",title:"Flux2 Klein edit"})]);
    const runId=randomUUID();
    await pool.query("INSERT INTO runs(id,workspace_id,project_id,workflow_revision_id,created_by,capability_id,capability_version,route_id,state,invocation,request_hash,idempotency_key,output_ids) VALUES($1,$2,$3,$4,$5,'flux2-klein-edit','1.0.0','local','succeeded','{}','fixture',$7,$6)",[runId,workspaceId,projectId,revisionId,ownerId,JSON.stringify([id]),runId]);
    const created_at=(await pool.query("SELECT created_at FROM assets WHERE id=$1",[id])).rows[0].created_at as Date;
    const moment=created_at.toISOString().slice(0,10)+"-"+created_at.toISOString().slice(11,16).replace(":","");
    const download=await server.app.inject({method:"GET",url:url(`assets/${id}/content?download=1`),headers:{origin,cookie}});
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toBe(`attachment; filename="cafe-creme-flux2-klein-edit-${moment}.png"; filename*=UTF-8''caf%C3%A9-cr%C3%A8me-flux2-klein-edit-${moment}.png`);
    const inline=await server.app.inject({method:"GET",url:url(`assets/${id}/content`),headers:{origin,cookie}});
    expect(inline.headers["content-disposition"]).toBe(`inline; filename="cafe-creme-flux2-klein-edit-${moment}.png"; filename*=UTF-8''caf%C3%A9-cr%C3%A8me-flux2-klein-edit-${moment}.png`);
  });
});
