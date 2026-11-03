import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {randomBytes} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import type {Pool} from "pg";
import {buildServer} from "../server/app";
import type {ServerConfig} from "../server/config";

/* On 2026-10-26 uploads failed with "Request origin is not allowed" because the app
   was opened at http://localhost:8787 while PUBLIC_ORIGIN is http://127.0.0.1:8787.
   These cases pin the onRequest guard in server/app.ts: a write must come from the
   exact public origin, while reads stay open to any origin. */
const publicOrigin="http://127.0.0.1:8787",localhostOrigin="http://localhost:8787",forbidden="Request origin is not allowed";

describe("origin guard",()=>{
  // The guard runs before every handler, so no request here needs the database.
  const pool={query:async()=>({rows:[],rowCount:0})} as unknown as Pool;
  let server:Awaited<ReturnType<typeof buildServer>>,storageRoot:string;
  beforeAll(async()=>{
    storageRoot=await mkdtemp(join(process.env.COMFYFIELD_TEST_TEMP_ROOT??(process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "","comfyfield-origin-guard-"));
    const config:ServerConfig={databaseUrl:"postgresql://unused@127.0.0.1:5432/unused",storageRoot,masterKey:randomBytes(32),publicOrigin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false};
    server=await buildServer(config,pool);await server.app.ready();
  },30000);
  afterAll(async()=>{await server?.app.close();if(storageRoot)await rm(storageRoot,{recursive:true,force:true});});
  const post=(origin?:string)=>server.app.inject({method:"POST",url:"/api/v1/auth/logout",...(origin?{headers:{origin}}:{})});
  it("accepts a write from the exact public origin",async()=>{
    const response=await post(publicOrigin);
    expect(response.statusCode).toBe(200);expect(response.json()).toEqual({signedOut:true});
  });
  it("refuses a write from localhost on the same port",async()=>{
    const response=await post(localhostOrigin);
    expect(response.statusCode).toBe(403);expect(response.json()).toEqual({error:forbidden});
  });
  it("refuses a write without an origin header",async()=>{
    const response=await post();
    expect(response.statusCode).toBe(403);expect(response.json()).toEqual({error:forbidden});
  });
  it("allows a read from a foreign origin",async()=>{
    const response=await server.app.inject({method:"GET",url:"/api/v1/health",headers:{origin:localhostOrigin}});
    expect(response.statusCode).toBe(200);expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});
