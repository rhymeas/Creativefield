import {HttpError} from "../auth";
import {aiTextConfig,type AiTextConfig} from "../config";
import type {AiTextImage,AiTextProvider,AiTextRequest,AiTextResult} from "../ai-text";

const DEFAULT_MAX_TOKENS=1400;
const TIMEOUT_MS=90000;

/** Where chat completions live. A base that already ends in /v1 is used as written. */
export function completionUrl(base:string){
  const trimmed=base.replace(/\/+$/,"");
  return trimmed.endsWith("/v1")?`${trimmed}/chat/completions`:`${trimmed}/v1/chat/completions`;
}

type ChatPart={type:"text";text:string}|{type:"image_url";image_url:{url:string}};

/** Images travel inside the body as data URLs, so a still or a decoded frame needs no upload step. */
export function userContent(prompt:string,images?:readonly AiTextImage[]):string|ChatPart[]{
  if(!images?.length)return prompt;
  return [
    {type:"text",text:prompt},
    ...images.map(image=>({type:"image_url" as const,image_url:{url:`data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`}})),
  ];
}

export function chatBody(config:AiTextConfig,request:AiTextRequest,json:boolean){
  return {
    model:config.model,
    max_tokens:request.maxTokens??DEFAULT_MAX_TOKENS,
    ...(json?{response_format:{type:"json_object"}}:{}),
    messages:[{role:"system",content:request.system},{role:"user",content:userContent(request.prompt,request.images)}],
  };
}

/** One plain sentence for the app's Notice. A key or a response body is never repeated here. */
function failure(status:number){
  if(status===401||status===403)return new HttpError(502,"The text API refused the key. Check COMFYFIELD_LLM_API_KEY.");
  if(status===429)return new HttpError(502,"The text API is busy. Try again in a minute.");
  return new HttpError(502,`The text API answered ${status}.`);
}

/** Any keyed OpenAI-compatible endpoint. Text, and images when the model can read them. */
export const openAiCompatibleProvider:AiTextProvider={
  id:"openai-compatible",
  async generate(request):Promise<AiTextResult>{
    let config:AiTextConfig;
    try{
      const found=aiTextConfig();
      if(!found)throw new Error("AI text needs COMFYFIELD_LLM_URL and COMFYFIELD_LLM_MODEL.");
      config=found;
    }catch(error){throw new HttpError(503,(error as Error).message);}
    const ask=async(json:boolean)=>{
      try{
        return await fetch(completionUrl(config.url),{
          method:"POST",
          headers:{"Content-Type":"application/json",...(config.apiKey?{Authorization:`Bearer ${config.apiKey}`}:{})},
          body:JSON.stringify(chatBody(config,request,json)),
          signal:AbortSignal.timeout(TIMEOUT_MS),
          redirect:"error",
        });
      }catch(error){
        throw new HttpError(503,`Could not reach the text API. Check COMFYFIELD_LLM_URL. (${(error as Error).message})`);
      }
    };
    let response=await ask(request.json===true);
    // Compatible servers can reject JSON mode while still answering strict JSON; ask once more without it.
    if(request.json===true&&(response.status===400||response.status===422))response=await ask(false);
    if(!response.ok)throw failure(response.status);
    const body=await response.json() as {choices?:Array<{message?:{content?:unknown}}>}|null;
    const content=body?.choices?.[0]?.message?.content;
    if(typeof content!=="string"||!content.trim())throw new HttpError(502,"The text API returned no text.");
    return {provider:"openai-compatible",model:config.model,text:content};
  },
};
