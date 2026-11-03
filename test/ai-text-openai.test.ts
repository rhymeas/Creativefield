import type {Pool} from "pg";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {generateText} from "../server/ai-text";
import {aiTextConfig} from "../server/config";
import {completionUrl,userContent} from "../server/ai-text/openai-compatible";

afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

beforeEach(()=>{
  vi.stubEnv("COMFYFIELD_LLM_URL","https://api.deepseek.com/v1");
  vi.stubEnv("COMFYFIELD_LLM_MODEL","deepseek-chat");
  vi.stubEnv("COMFYFIELD_LLM_API_KEY","test-key");
});

const key="test-key";
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
const answer=(text:string)=>json({choices:[{message:{content:text}}]});
const pool={} as Pool;
const request={workspaceId:"w1",system:"Rules.",prompt:"Premise: A fox runs.",maxTokens:900};

/** Records each call so a test can read the URL, the headers and the body it sent. */
function stubApi(...replies:Array<()=>Response>){
  const calls:Array<{url:string;init:RequestInit}>=[];
  vi.stubGlobal("fetch",(async(input:RequestInfo|URL,init?:RequestInit)=>{
    calls.push({url:String(input),init:init??{}});
    const reply=replies[Math.min(calls.length-1,replies.length-1)];
    return reply();
  }) as unknown as typeof fetch);
  return calls;
}

const bodyOf=(call:{init:RequestInit})=>JSON.parse(String(call.init.body));
const status=(error:unknown)=>(error as {statusCode?:number}).statusCode;

describe("keyed OpenAI-compatible text",()=>{
  it("adds /v1 only when the base does not already end with it",()=>{
    expect(completionUrl("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(completionUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(completionUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/v1/chat/completions");
  });

  it("sends the key as a bearer token and returns the model's answer",async()=>{
    const calls=stubApi(()=>answer("Three shots ready."));
    const result=await generateText("openai-compatible",request,{pool});
    expect(result).toEqual({provider:"openai-compatible",model:"deepseek-chat",text:"Three shots ready."});
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect((calls[0].init.headers as Record<string,string>).Authorization).toBe(`Bearer ${key}`);
    const body=bodyOf(calls[0]);
    expect(body.model).toBe("deepseek-chat");
    expect(body.max_tokens).toBe(900);
    expect(body.messages[0]).toEqual({role:"system",content:"Rules."});
    expect(body.messages[1]).toEqual({role:"user",content:"Premise: A fox runs."});
    expect(body.response_format).toBeUndefined();
  });

  it.each([400,422])("drops JSON mode once when the server refuses it with %i",async refused=>{
    const calls=stubApi(()=>new Response("",{status:refused}),()=>answer('{"shots":[]}'));
    const result=await generateText("openai-compatible",{...request,json:true},{pool});
    expect(result.text).toBe('{"shots":[]}');
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0]).response_format).toEqual({type:"json_object"});
    expect(bodyOf(calls[1]).response_format).toBeUndefined();
    expect((calls[1].init.headers as Record<string,string>).Authorization).toBe(`Bearer ${key}`);
  });

  it("keeps JSON mode when the server accepts it",async()=>{
    const calls=stubApi(()=>answer('{"shots":[]}'));
    await generateText("openai-compatible",{...request,json:true},{pool});
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]).response_format).toEqual({type:"json_object"});
  });

  it("turns a refused key into one plain sentence",async()=>{
    stubApi(()=>new Response("",{status:401}));
    const error=await generateText("openai-compatible",request,{pool}).catch(found=>found);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The text API refused the key. Check COMFYFIELD_LLM_API_KEY.");
    expect((error as Error).message).not.toContain(key);
    expect(status(error)).toBe(502);
  });

  it("says plainly when the endpoint answers with a server error",async()=>{
    stubApi(()=>new Response("",{status:500}));
    const error=await generateText("openai-compatible",request,{pool}).catch(found=>found);
    expect((error as Error).message).toBe("The text API answered 500.");
    expect(status(error)).toBe(502);
  });

  it("sends an image as a data URL beside the prompt",()=>{
    const content=userContent("What is in this frame?",[{mediaType:"image/png",bytes:new Uint8Array([1,2,3])}]);
    expect(Array.isArray(content)).toBe(true);
    const parts=content as Array<{type:string;image_url?:{url:string}}>;
    expect(parts[0]).toEqual({type:"text",text:"What is in this frame?"});
    expect(parts[1].image_url?.url).toBe(`data:image/png;base64,${Buffer.from([1,2,3]).toString("base64")}`);
    expect(userContent("Premise: A fox runs.")).toBe("Premise: A fox runs.");
  });

  it("sends no key header when the endpoint needs none",async()=>{
    vi.stubEnv("COMFYFIELD_LLM_API_KEY","");
    const calls=stubApi(()=>answer("Local answer."));
    const result=await generateText("openai-compatible",request,{pool});
    expect(result.model).toBe("deepseek-chat");
    expect((calls[0].init.headers as Record<string,string>).Authorization).toBeUndefined();
  });

  it("says plainly when no endpoint is configured",async()=>{
    vi.stubEnv("COMFYFIELD_LLM_URL","");
    vi.stubEnv("COMFYFIELD_LLM_MODEL","");
    vi.stubEnv("COMFYFIELD_LLM_API_KEY","");
    const error=await generateText("openai-compatible",request,{pool}).catch(found=>found);
    expect((error as Error).message).toBe("AI text needs COMFYFIELD_LLM_URL and COMFYFIELD_LLM_MODEL.");
    expect(status(error)).toBe(503);
  });
});

describe("AI text endpoint settings",()=>{
  it("needs a full web address and a model, and trims a trailing slash",()=>{
    expect(aiTextConfig({COMFYFIELD_LLM_URL:"https://api.openai.com/",COMFYFIELD_LLM_MODEL:"gpt-4o-mini",COMFYFIELD_LLM_API_KEY:"k"}))
      .toEqual({url:"https://api.openai.com",model:"gpt-4o-mini",apiKey:"k"});
    expect(()=>aiTextConfig({COMFYFIELD_LLM_URL:"api.openai.com",COMFYFIELD_LLM_MODEL:"gpt-4o-mini"})).toThrow(/absolute HTTP\(S\) address/);
    expect(()=>aiTextConfig({COMFYFIELD_LLM_URL:"ftp://api.openai.com",COMFYFIELD_LLM_MODEL:"gpt-4o-mini"})).toThrow(/http or https/);
    expect(()=>aiTextConfig({COMFYFIELD_LLM_URL:"https://api.openai.com?key=secret",COMFYFIELD_LLM_MODEL:"gpt-4o-mini"})).toThrow(/query/);
  });

  it("asks for the missing pair instead of guessing",()=>{
    expect(aiTextConfig({})).toBeUndefined();
    expect(()=>aiTextConfig({COMFYFIELD_LLM_API_KEY:"k"})).toThrow(/COMFYFIELD_LLM_URL is needed/);
    expect(()=>aiTextConfig({COMFYFIELD_LLM_URL:"https://api.openai.com"})).toThrow(/COMFYFIELD_LLM_MODEL is needed/);
    // A message never repeats the value it read.
    try{aiTextConfig({COMFYFIELD_LLM_URL:"not a url",COMFYFIELD_LLM_MODEL:"m"});}
    catch(error){expect((error as Error).message).not.toContain("not a url");}
  });
});
