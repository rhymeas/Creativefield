import {HttpError} from "../auth";
import type {AiTextProvider,AiTextRequest,AiTextResult} from "../ai-text";

export type Worker={origin:string;api_prefix:string};

/** ComfyUI's own TextGenerate node with a Qwen3 text model the worker already has. Preferred order, first installed wins. */
const COMFY_PLANNERS=[{clip:"qwen_3_4b.safetensors",type:"flux2"},{clip:"qwen3vl_8b_int8_convrot.safetensors",type:"qwen_image"}];
const DEFAULT_MAX_TOKENS=1400;

/** TextGenerate has one prompt slot, so the system instruction and the user turn travel together. */
export function textGraph(pick:{clip:string;type:string},prompt:string,maxTokens:number){
  return {
    "1":{class_type:"CLIPLoader",inputs:{clip_name:pick.clip,type:pick.type,device:"default"}},
    "2":{class_type:"TextGenerate",inputs:{clip:["1",0],prompt,max_length:maxTokens,sampling_mode:"off",thinking:false}},
    "3":{class_type:"PreviewAny",inputs:{source:["2",0]}},
  };
}

/** Asks a local ComfyUI worker to write text. The only text path that needs no key and no network. */
export async function comfyGenerate(worker:Worker,prompt:string,maxTokens=DEFAULT_MAX_TOKENS):Promise<{model:string;text:string}>{
  const api=`${worker.origin}${worker.api_prefix??""}`;
  const json=async(path:string,init?:RequestInit)=>{
    const response=await fetch(`${api}${path}`,{...init,signal:AbortSignal.timeout(30000),redirect:"error"});
    if(!response.ok)throw new HttpError(503,`ComfyUI answered ${response.status}.`);
    return await response.json() as any;
  };
  const loader=await json("/object_info/CLIPLoader").catch(()=>null),generator=await json("/object_info/TextGenerate").catch(()=>null);
  const names:string[]=loader?.CLIPLoader?.input?.required?.clip_name?.[0]??[];
  const pick=COMFY_PLANNERS.find(candidate=>names.includes(candidate.clip));
  if(!generator?.TextGenerate||!pick)throw new HttpError(503,"Local text needs ComfyUI's TextGenerate node and a Qwen3 text model (qwen_3_4b.safetensors).");
  const queued=await json("/prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:textGraph(pick,prompt,maxTokens)})});
  if(!queued?.prompt_id)throw new HttpError(503,"ComfyUI did not accept the text request.");
  const until=Date.now()+180000;
  while(Date.now()<until){
    await new Promise(resolve=>setTimeout(resolve,1500));
    const entry=(await json(`/history/${encodeURIComponent(queued.prompt_id)}`))?.[queued.prompt_id];
    if(entry?.status?.status_str==="error")throw new HttpError(503,"ComfyUI failed while writing text.");
    const text=entry?.outputs?.["3"]?.text?.[0];
    if(typeof text==="string")return {model:`ComfyUI TextGenerate · ${pick.clip.replace(/\.safetensors$/,"")}`,text};
  }
  throw new HttpError(503,"Local text took longer than three minutes. Nothing was changed.");
}

export const localComfyProvider:AiTextProvider={
  id:"local-comfy",
  async generate(request:AiTextRequest,context):Promise<AiTextResult>{
    if(request.images?.length)throw new HttpError(503,"Local ComfyUI text cannot read images yet.");
    const worker=(await context.pool.query("SELECT origin,api_prefix FROM workers WHERE workspace_id=$1 AND enabled=true ORDER BY checked_at DESC NULLS LAST,id LIMIT 1",[request.workspaceId])).rows[0] as Worker|undefined;
    if(!worker)throw new HttpError(503,"Local text needs an enabled ComfyUI worker.");
    const answer=await comfyGenerate(worker,`${request.system}\n\n${request.prompt}`,request.maxTokens);
    return {provider:"local-comfy",model:answer.model,text:answer.text};
  },
};
