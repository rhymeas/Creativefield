import {tmpdir} from "node:os";
import {join} from "node:path";
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {afterEach,describe,expect,it,vi} from "vitest";
import {comfyGenerate,parsePlannedShots,planSystem,storyboardPlanRoutes} from "../server/storyboard-plan";

const workspace="6b1f8f8e-4a2b-4c3d-9e8f-0a1b2c3d4e5f";
const premise={premise:"A fox crosses a frozen lake at dawn.",count:3};

const shot=(index:number)=>({
  title:`Shot ${index}`,
  prompt:`A complete visual prompt for shot ${index}.`,
  durationSeconds:index+2,
  shotIntent:"Keep the subject readable",
  cameraIntent:"Slow push in",
});

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});

/** The three lookups a plan makes: the member, the saved provider choice, the local worker. */
function poolSaving(providerId?:string,online=false){
  return {query:async(sql:string)=>{
    if(sql.includes("FROM sessions"))return {rows:[{id:"u1",email:"writer@example.test"}]};
    if(sql.includes("FROM memberships"))return {rows:[{role:"creator"}]};
    if(sql.includes("FROM ai_text_settings"))return {rows:providerId?[{provider_id:providerId}]:[]};
    if(sql.includes("FROM workers"))return {rows:[{inventory:{online}}]};
    return {rows:[]};
  }} as unknown as Pool;
}

/** The route module registers one handler; the test calls it the way Fastify would. */
async function planRoute(pool:Pool){
  let handler:(request:any)=>Promise<any>=()=>{throw new Error("No storyboard plan route was registered.");};
  const app={post:(_path:string,fn:(request:any)=>Promise<any>)=>{handler=fn;}} as unknown as FastifyInstance;
  await storyboardPlanRoutes(app,pool);
  return (body:Record<string,unknown>)=>handler({cookies:{cf_session:"token"},params:{workspaceId:workspace},body});
}

function withKeyedProvider(){
  vi.stubEnv("COMFYFIELD_LLM_URL","https://api.example.test");
  vi.stubEnv("COMFYFIELD_LLM_MODEL","gpt-4o-mini");
  vi.stubEnv("COMFYFIELD_LLM_API_KEY","sk-test");
  vi.stubEnv("COMFYFIELD_CODEX_BIN",join(tmpdir(),"codex-not-installed-here"));
}

function withNothingHere(){
  for(const name of ["COMFYFIELD_LLM_URL","COMFYFIELD_LLM_MODEL","COMFYFIELD_LLM_API_KEY"])vi.stubEnv(name,"");
  vi.stubEnv("COMFYFIELD_CODEX_BIN",join(tmpdir(),"codex-not-installed-here"));
}

afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe("local storyboard plan contract",()=>{
  it("accepts exactly the requested number of structured shots",()=>{
    const shots=parsePlannedShots(JSON.stringify({shots:[1,2,3].map(shot)}),3);
    expect(shots).toHaveLength(3);expect(shots[2].title).toBe("Shot 3");
  });
  it("rejects malformed JSON without repairing it",()=>{
    expect(()=>parsePlannedShots("Here are your shots: ...",3)).toThrow(/invalid JSON/);
  });
  it("rejects the wrong shot count",()=>{
    expect(()=>parsePlannedShots(JSON.stringify({shots:[shot(1),shot(2)]}),3)).toThrow(/2 shots instead of 3/);
  });
  it("rejects a shot missing its prompt or duration",()=>{
    expect(()=>parsePlannedShots(JSON.stringify({shots:[{...shot(1),prompt:""}]}),1)).toThrow(/invalid shot plan/);
  });
  it("states the exact count in the system prompt, without claiming a local model",()=>{
    expect(planSystem(3)).toContain("exactly 3 entries");
    expect(planSystem(3)).not.toMatch(/local/i);
  });
  it("still offers the local ComfyUI text call that reference planning imports",()=>{
    expect(typeof comfyGenerate).toBe("function");
  });
});

describe("storyboard plan names its provider",()=>{
  it("plans on the chosen provider and returns it with its model",async()=>{
    withKeyedProvider();
    const sent:Array<{headers?:Record<string,string>;body:any}>=[];
    vi.stubGlobal("fetch",(async(_input:RequestInfo|URL,init?:RequestInit)=>{
      sent.push({headers:init?.headers as Record<string,string>,body:JSON.parse(String(init?.body))});
      return json({choices:[{message:{content:JSON.stringify({shots:[1,2,3].map(shot)})}}]});
    }) as unknown as typeof fetch);
    const plan=await (await planRoute(poolSaving("openai-compatible")))(premise) as {provider:string;model:string;shots:unknown[]};
    expect([plan.provider,plan.model,plan.shots.length]).toEqual(["openai-compatible","gpt-4o-mini",3]);
    expect(sent[0].headers?.Authorization).toBe("Bearer sk-test");
    expect(sent[0].body.response_format).toEqual({type:"json_object"});
  });

  it("says where AI text runs when no provider can plan here",async()=>{
    withNothingHere();
    await expect((await planRoute(poolSaving()))(premise)).rejects.toThrow(/Choose where AI text runs in Settings first/);
  });

  it("asks once more, then reports a second wrong answer instead of padding it",async()=>{
    withKeyedProvider();
    let calls=0;
    vi.stubGlobal("fetch",(async()=>{calls++;return json({choices:[{message:{content:"Here you go: three shots."}}]});}) as unknown as typeof fetch);
    await expect((await planRoute(poolSaving("openai-compatible")))(premise)).rejects.toThrow(/The shot planner returned invalid JSON/);
    expect(calls).toBe(2);
  });
});
