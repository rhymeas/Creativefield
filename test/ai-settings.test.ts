import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Pool} from "pg";
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from "vitest";
import type {AiTextConfig} from "../server/config";
import {aiTextSettings,availableProviders,codexInstalled,codexSignedIn,generateText,localTextReady,setActiveTextProvider} from "../server/ai-text";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {hashToken} from "../server/crypto";
import {migrate} from "../server/db";
import {aiTextStateLabel,chooseAiText,loadAiText,type Call} from "../src/team/api";

afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

type Answer=(sql:string,values?:unknown[])=>{rows:unknown[]};
const fakePool=(answer:Answer)=>({query:async(sql:string,values?:unknown[])=>answer(sql,values)}) as unknown as Pool;
const config=(extra:Partial<AiTextConfig>={}):AiTextConfig=>({url:"https://api.example.test/v1",model:"gpt-4o-mini",...extra});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});

describe("where AI text runs",()=>{
  it("leaves out every provider that cannot work on this machine",()=>{
    expect(availableProviders({localWorker:false,config:undefined,codex:false,signedIn:false})).toEqual([]);
  });

  it("says each provider's real state in one short line",()=>{
    const list=availableProviders({localWorker:true,config:config(),codex:true,signedIn:false});
    expect(list.map(provider=>[provider.id,provider.label,provider.state])).toEqual([
      ["local-comfy","Local ComfyUI","ready"],
      ["openai-compatible","API key","needs_key"],
      ["chatgpt","ChatGPT","needs_sign_in"],
    ]);
    expect(list[1].detail).toMatch(/COMFYFIELD_LLM_API_KEY/);
    expect(list[2].detail).toMatch(/codex login/);
  });

  it("needs no key for an endpoint on this machine, or when a key is set",()=>{
    const local=availableProviders({localWorker:false,config:{url:"http://127.0.0.1:8080/v1",model:"qwen"},codex:false,signedIn:false});
    const keyed=availableProviders({localWorker:false,config:config({apiKey:"sk-live-secret"}),codex:false,signedIn:false});
    expect(local[0].state).toBe("ready");
    expect(local[0].detail).toBe("qwen");
    expect(keyed[0].state).toBe("ready");
  });

  it("never sends a key to the panel",()=>{
    const shown=JSON.stringify(availableProviders({localWorker:true,config:config({apiKey:"sk-live-secret"}),codex:true,signedIn:true}));
    expect(shown).not.toContain("sk-live-secret");
  });

  it("keeps the workspace choice and falls back when it can no longer run",async()=>{
    const saved=(providerId:string)=>fakePool(sql=>sql.includes("SELECT provider_id")?{rows:[{provider_id:providerId}]}:sql.includes("SELECT inventory")?{rows:[{inventory:{online:true}}]}:{rows:[]});
    await expect(aiTextSettings(saved("local-comfy"),"w1",{})).resolves.toMatchObject({active:"local-comfy"});
    // ChatGPT was picked once, but Codex is not here now: the active provider is the one that can run.
    await expect(aiTextSettings(saved("chatgpt"),"w1",{})).resolves.toMatchObject({active:"local-comfy"});
  });

  it("says nothing can run here when no provider exists yet",async()=>{
    const empty=fakePool(sql=>sql.includes("SELECT provider_id")?{rows:[{provider_id:"chatgpt"}]}:{rows:[]});
    await expect(aiTextSettings(empty,"w1",{})).resolves.toEqual({providers:[],active:undefined});
  });

  it("saves the choice for one workspace",async()=>{
    const seen:Array<{sql:string;values?:unknown[]}>=[];
    await setActiveTextProvider(fakePool((sql,values)=>{seen.push({sql,values});return {rows:[]};}),"w1","chatgpt");
    expect(seen[0].sql).toMatch(/CREATE TABLE IF NOT EXISTS ai_text_settings/);
    expect(seen[1].sql).toMatch(/INSERT INTO ai_text_settings/);
    expect(seen[1].values).toEqual(["w1","chatgpt"]);
  });

  it("reads a worker that is offline, or missing, as not ready",async()=>{
    await expect(localTextReady(fakePool(()=>({rows:[{inventory:{online:false}}]})),"w1")).resolves.toBe(false);
    await expect(localTextReady(fakePool(()=>({rows:[]})),"w1")).resolves.toBe(false);
  });
});

describe("the saved provider is the one that answers",()=>{
  it("asks for a choice when nothing can run here",async()=>{
    vi.stubEnv("COMFYFIELD_LLM_URL","");vi.stubEnv("COMFYFIELD_LLM_MODEL","");vi.stubEnv("COMFYFIELD_LLM_API_KEY","");vi.stubEnv("COMFYFIELD_CODEX_BIN","/no/codex/here");
    const ask=generateText("active",{workspaceId:"w1",system:"Rules.",prompt:"Hi"},{pool:fakePool(()=>({rows:[]}))});
    await expect(ask).rejects.toThrow(/Choose where AI text runs/);
  });

  it("answers through the provider the workspace chose",async()=>{
    vi.stubGlobal("fetch",(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.endsWith("/object_info/CLIPLoader"))return json({CLIPLoader:{input:{required:{clip_name:[["qwen_3_4b.safetensors"]]}}}});
      if(url.endsWith("/object_info/TextGenerate"))return json({TextGenerate:{}});
      if(url.endsWith("/prompt"))return json({prompt_id:"p1"});
      if(url.includes("/history/"))return json({p1:{status:{status_str:"success"},outputs:{"3":{text:["Three shots ready."]}}}});
      return json({},404);
    }) as unknown as typeof fetch);
    const pool=fakePool(sql=>sql.includes("SELECT provider_id")?{rows:[{provider_id:"local-comfy"}]}:sql.includes("inventory")?{rows:[{inventory:{online:true}}]}:{rows:[{origin:"http://worker:8188",api_prefix:""}]});
    const answer=await generateText("active",{workspaceId:"w1",system:"Rules.",prompt:"A fox runs."},{pool});
    expect(answer.provider).toBe("local-comfy");
    expect(answer.text).toBe("Three shots ready.");
  });
});

describe("what this machine can do",()=>{
  it("finds codex on PATH, under either platform's file names",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"ai-settings-path-"));
    expect(codexInstalled({PATH:dir},"linux")).toBe(false);
    await writeFile(join(dir,"codex"),"");
    expect(codexInstalled({PATH:dir},"linux")).toBe(true);
    expect(codexInstalled({PATH:dir},"win32")).toBe(false);
    await writeFile(join(dir,"codex.cmd"),"");
    expect(codexInstalled({PATH:dir},"win32")).toBe(true);
  });

  it("takes a named codex binary instead of the PATH",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"ai-settings-bin-"));
    const missing=join(dir,"codex-does-not-exist");
    expect(codexInstalled({COMFYFIELD_CODEX_BIN:missing})).toBe(false);
    await writeFile(missing,"");
    expect(codexInstalled({COMFYFIELD_CODEX_BIN:missing})).toBe(true);
  });

  it("reads a ChatGPT sign-in from the Codex home, not an API-key login",async()=>{
    const home=await mkdtemp(join(tmpdir(),"ai-settings-codex-"));
    expect(codexSignedIn({CODEX_HOME:home})).toBe(false);
    await writeFile(join(home,"auth.json"),JSON.stringify({OPENAI_API_KEY:"sk-not-a-plan"}));
    expect(codexSignedIn({CODEX_HOME:home})).toBe(false);
    await writeFile(join(home,"auth.json"),JSON.stringify({tokens:{access_token:"chatgpt-plan-token"}}));
    expect(codexSignedIn({CODEX_HOME:home})).toBe(true);
  });
});

describe("settings requests",()=>{
  it("loads and saves the choice on the AI text route",async()=>{
    const seen:Array<{path:string;method?:string;body?:unknown}>=[];
    const call=(async(path:string,method?:string,body?:unknown)=>{seen.push({path,method,body});return {providers:[],active:"chatgpt"};}) as Call;
    await loadAiText(call,"w one");
    await chooseAiText(call,"w one","chatgpt");
    expect(seen).toEqual([
      {path:"/workspaces/w%20one/ai-text",method:undefined,body:undefined},
      {path:"/workspaces/w%20one/ai-text",method:"POST",body:{providerId:"chatgpt"}},
    ]);
  });

  it("says each state in one short word",()=>{
    expect([aiTextStateLabel("ready"),aiTextStateLabel("needs_key"),aiTextStateLabel("needs_sign_in")]).toEqual(["Ready","Needs a key","Sign in needed"]);
  });
});

const origin="http://localhost:5173";

describe.skipIf(!process.env.TEST_DATABASE_URL)("the AI text setting over the API",()=>{
  const schema=`cf_ai_${randomUUID().replaceAll("-","")}`;
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,workspace:string,cookie:string,codexHome:string,codexBin:string;
  const envKeys=["COMFYFIELD_LLM_URL","COMFYFIELD_LLM_MODEL","COMFYFIELD_LLM_API_KEY","COMFYFIELD_CODEX_BIN","CODEX_HOME"];
  const before:Record<string,string|undefined>={};
  const api=(method:"GET"|"POST",payload?:Record<string,unknown>)=>server.app.inject({method,url:`/api/v1/workspaces/${workspace}/ai-text`,headers:{origin,cookie},payload});
  const states=async()=>(await api("GET")).json() as {providers:Array<{id:string;state:string;detail:string}>;active?:string};
  beforeAll(async()=>{
    const scratch=await mkdtemp(join(tmpdir(),"ai-settings-api-"));
    codexHome=join(scratch,"codex-home");codexBin=join(scratch,"codex");
    await mkdir(codexHome);await writeFile(codexBin,"");
    for(const key of envKeys)before[key]=process.env[key];
    process.env.COMFYFIELD_LLM_URL="https://text.example.test/v1";process.env.COMFYFIELD_LLM_MODEL="gpt-4o-mini";
    delete process.env.COMFYFIELD_LLM_API_KEY;
    process.env.CODEX_HOME=codexHome;process.env.COMFYFIELD_CODEX_BIN=codexBin;
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    workspace=(await bootstrap(pool,"ai-text@fixture.test","Fixture-password-only-123!","AI text")).workspaceId;
    const user=randomUUID(),token=randomBytes(32).toString("hex");
    await pool.query("INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users LIMIT 1",[user,`${user}@fixture.test`]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[workspace,user]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),user]);
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,inventory,checked_at) VALUES($1,$2,'This computer','http://127.0.0.1:8188',$3,now())",[randomUUID(),workspace,JSON.stringify({online:true,nodes:[],models:[],credentials:[]})]);
    cookie=`cf_session=${token}`;
    server=await buildServer({databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot:scratch,masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false},pool);
    await server.app.ready();
  });
  afterAll(async()=>{
    if(server){await Promise.all([server.execution.close(),server.storyboards.close(),server.workerMonitor.close()]);await server.app.close();}
    for(const key of envKeys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}
    await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
  });

  it("lists the providers that can run here, each with its real state",async()=>{
    const listed=await api("GET");
    expect(listed.statusCode,listed.body).toBe(200);
    expect((listed.json() as {providers:Array<{id:string;state:string;detail:string}>}).providers.map(provider=>[provider.id,provider.state])).toEqual([["local-comfy","ready"],["openai-compatible","needs_key"],["chatgpt","needs_sign_in"]]);
    expect(listed.body).not.toContain("COMFYFIELD_LLM_API_KEY=");
  });

  it("refuses a provider that cannot run yet and keeps no choice for it",async()=>{
    const refused=await api("POST",{providerId:"chatgpt"});
    expect(refused.statusCode,refused.body).toBe(409);
    expect((await pool.query("SELECT workspace_id FROM ai_text_settings")).rowCount).toBe(0);
  });

  it("stores the admin's choice per workspace and uses it once the provider is ready",async()=>{
    const chosen=await api("POST",{providerId:"local-comfy"});
    expect(chosen.statusCode,chosen.body).toBe(200);
    expect((chosen.json() as {active?:string}).active).toBe("local-comfy");
    expect((await pool.query("SELECT provider_id FROM ai_text_settings WHERE workspace_id=$1",[workspace])).rows[0].provider_id).toBe("local-comfy");
    await writeFile(join(codexHome,"auth.json"),JSON.stringify({tokens:{access_token:"chatgpt-plan-token"}}));
    const chatgpt=await api("POST",{providerId:"chatgpt"});
    expect(chatgpt.statusCode,chatgpt.body).toBe(200);
    const ready=await states();
    expect(ready.active).toBe("chatgpt");
    expect(ready.providers.find(provider=>provider.id==="chatgpt")?.state).toBe("ready");
  });

  it("drops back to a provider that still works when the chosen one stops",async()=>{
    await rm(join(codexHome,"auth.json"));
    const listed=await states();
    expect(listed.providers.find(provider=>provider.id==="chatgpt")?.state).toBe("needs_sign_in");
    expect(listed.active).toBe("local-comfy");
  });

  it("shows a viewer no AI text setting to change",async()=>{
    const viewerToken=randomBytes(32).toString("hex"),viewer=randomUUID();
    await pool.query("INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users LIMIT 1",[viewer,`${viewer}@fixture.test`]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[workspace,viewer]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(viewerToken),viewer]);
    const asViewer=await server.app.inject({method:"GET",url:`/api/v1/workspaces/${workspace}/ai-text`,headers:{origin,cookie:`cf_session=${viewerToken}`}});
    expect(asViewer.statusCode).toBe(403);
  });
});
