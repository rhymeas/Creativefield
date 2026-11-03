import type {Pool} from "pg";
import {afterEach,describe,expect,it,vi} from "vitest";
import {generateText} from "../server/ai-text";
import {localComfyProvider,textGraph} from "../server/ai-text/local-comfy";

afterEach(()=>vi.unstubAllGlobals());

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});

/** A ComfyUI worker that only has the Qwen3 4B text model, and answers with one sentence. */
function localWorker(answer:string,onGraph?:(graph:any)=>void){
  return (async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);
    if(url.endsWith("/object_info/CLIPLoader"))return json({CLIPLoader:{input:{required:{clip_name:[["qwen_3_4b.safetensors"]]}}}});
    if(url.endsWith("/object_info/TextGenerate"))return json({TextGenerate:{}});
    if(url.endsWith("/prompt")){onGraph?.(JSON.parse(String(init?.body)).prompt);return json({prompt_id:"p1"});}
    if(url.includes("/history/"))return json({p1:{status:{status_str:"success"},outputs:{"3":{text:[answer]}}}});
    return json({},404);
  }) as unknown as typeof fetch;
}

const poolWith=(rows:unknown[])=>({query:async()=>({rows})}) as unknown as Pool;

describe("AI text seam",()=>{
  it("keeps the system instruction and the answer cap in one local prompt",()=>{
    const graph=textGraph({clip:"qwen_3_4b.safetensors",type:"flux2"},"Rules.\n\nPremise: A fox runs.",900);
    expect(graph["2"].inputs.prompt).toBe("Rules.\n\nPremise: A fox runs.");
    expect(graph["2"].inputs.max_length).toBe(900);
  });

  it("answers through the seam with the local worker and names its model",async()=>{
    let graph:any;
    vi.stubGlobal("fetch",localWorker("Three shots ready.",sent=>{graph=sent;}));
    const answer=await generateText("local-comfy",{workspaceId:"w1",system:"Rules.",prompt:"Premise: A fox runs.",maxTokens:900},{
      pool:poolWith([{origin:"http://worker:8188",api_prefix:""}]),
    });
    expect(answer).toEqual({provider:"local-comfy",model:"ComfyUI TextGenerate · qwen_3_4b",text:"Three shots ready."});
    expect(graph["2"].inputs.prompt).toBe("Rules.\n\nPremise: A fox runs.");
  });

  it("says plainly when the workspace has no enabled worker",async()=>{
    const ask=generateText("local-comfy",{workspaceId:"w1",system:"Rules.",prompt:"Premise: A fox runs."},{pool:poolWith([])});
    await expect(ask).rejects.toThrow(/enabled ComfyUI worker/);
  });

  it("refuses images until a provider can read them",async()=>{
    const ask=localComfyProvider.generate({workspaceId:"w1",system:"Look.",prompt:"What is in this frame?",images:[{mediaType:"image/png",bytes:new Uint8Array([1])}]},{pool:poolWith([])});
    await expect(ask).rejects.toThrow(/cannot read images yet/);
  });
});
