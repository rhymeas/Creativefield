import {createHash} from "node:crypto";
import sharp from "sharp";
import {VISION_CLIP, visionGraph} from "./reference-describe";
import type {Worker} from "./ai-text/local-comfy";

/** The boxes refer to the oriented image, normalized to 0..1000.  Only a clearly isolated,
 * complete front view of repeated views of the SAME character can be cropped automatically. */
export type CharacterReferenceAnalysis =
  | {kind:"single"}
  | {kind:"repeated"; box:[number,number,number,number]}
  | {kind:"ambiguous"; reason:string};
export type PreparedCharacterReference =
  | {kind:"unchanged"; bytes:Buffer; mediaType:string}
  | {kind:"isolated"; bytes:Buffer; mediaType:"image/png"; box:[number,number,number,number]}
  | {kind:"ambiguous"; reason:string};

/** Only character ports of the two local OpenJutsu workflows should be isolated. */
export function needsOpenJutsuReferencePreparation(workflowId:string,role:string):boolean {
  return workflowId==="openjutsu-h3-swap"&&role==="character_image"
    ||workflowId==="openjutsu-h3-advanced"&&/^reference_image(?:_[234])?$/.test(role);
}

export const CHARACTER_SHEET_INSTRUCTION = `Analyze this reference picture for video character replacement. Reply only in JSON. If it contains exactly one character, reply {"kind":"single"}. If it is a character sheet showing multiple full-body views of the SAME character and a single complete front-facing view is clearly separated from every other character, reply {"kind":"repeated","box":[left,top,right,bottom]}, using integers 0 to 1000 normalized to the image dimensions for a tight bounding box around the complete front-view character, including head, hands, and feet. Do not include text or another character. If different characters appear, a full front view is not clearly separate, the picture is crowded, or you are uncertain, reply {"kind":"ambiguous"}. Do not guess.`;

/** Parse only the exact bounded contract. Malformed responses cannot silently become a crop. */
export function parseCharacterReferenceAnalysis(answer:string):CharacterReferenceAnalysis {
  let value:unknown;
  try {
    const trimmed=answer.trim();
    const clean=trimmed.startsWith("```json")&&trimmed.endsWith("```")?trimmed.slice(7,-3).trim():trimmed;
    value=JSON.parse(clean);
  } catch {return {kind:"ambiguous",reason:"The character reference could not be read reliably."};}
  if(!value||typeof value!=="object"||Array.isArray(value))return {kind:"ambiguous",reason:"The character reference could not be read reliably."};
  const record=value as Record<string,unknown>;
  if(record.kind==="single")return {kind:"single"};
  if(record.kind!=="repeated")return {kind:"ambiguous",reason:"Choose a picture with one clearly visible character."};
  const b=record.box;
  if(!Array.isArray(b)||b.length!==4||!b.every(n=>Number.isInteger(n)&&n>=0&&n<=1000))return {kind:"ambiguous",reason:"The character sheet did not have a reliable front-view boundary."};
  const [left,top,right,bottom]=b as [number,number,number,number];
  // An implausibly narrow or tiny box cannot describe a complete character.
  if(right-left<60||bottom-top<150)return {kind:"ambiguous",reason:"The character sheet did not have a reliable front-view boundary."};
  return {kind:"repeated",box:[left,top,right,bottom]};
}

/** Isolates one existing front-view instead of asking the image model to invent a new identity.
 * If identity or bounds are unclear, return an explicit failure; never silently send the full sheet. */
export async function prepareCharacterReference(bytes:Buffer,mediaType:string,analyze:(bytes:Buffer,mediaType:string)=>Promise<CharacterReferenceAnalysis>):Promise<PreparedCharacterReference>{
  const image=sharp(bytes,{animated:false,failOn:"warning",limitInputPixels:64*1024*1024});
  const oriented=await image.rotate().png().toBuffer({resolveWithObject:true});
  const assessment=await analyze(oriented.data,"image/png");
  if(assessment.kind==="ambiguous")return assessment;
  if(assessment.kind==="single")return {kind:"unchanged",bytes,mediaType};
  const [l,t,r,b]=assessment.box,{width,height}=oriented.info;
  // Only retain a small proportional margin; clamp to the decoded image.
  const marginX=Math.round((r-l)*width/1000*0.02), marginY=Math.round((b-t)*height/1000*0.02);
  const left=Math.max(0,Math.floor(l*width/1000)-marginX),top=Math.max(0,Math.floor(t*height/1000)-marginY);
  const right=Math.min(width,Math.ceil(r*width/1000)+marginX),bottom=Math.min(height,Math.ceil(b*height/1000)+marginY);
  if(right<=left||bottom<=top)return {kind:"ambiguous",reason:"The character sheet did not have a reliable front-view boundary."};
  const result=await sharp(oriented.data).extract({left,top,width:right-left,height:bottom-top}).png().toBuffer();
  return {kind:"isolated",bytes:result,mediaType:"image/png",box:assessment.box};
}

/** Wide pictures are possible multi-view sheets. Inspect those before passing them to
 * the swap graph. A portrait is left alone; that heuristic does not claim to detect
 * every possible sheet layout. Never replace an uncertain analysis with a guess. */
export async function prepareOpenJutsuUpload(bytes:Buffer,mediaType:string,analyze:(bytes:Buffer,mediaType:string)=>Promise<CharacterReferenceAnalysis>):Promise<PreparedCharacterReference>{
  const metadata=await sharp(bytes,{failOn:"warning",limitInputPixels:64*1024*1024}).metadata();
  if(!metadata.width||!metadata.height)throw new Error("The character image could not be read.");
  const rotated=[5,6,7,8].includes(metadata.orientation??1);
  const width=rotated?metadata.height:metadata.width,height=rotated?metadata.width:metadata.height;
  if(width/height<1.6)return {kind:"unchanged",bytes,mediaType};
  return prepareCharacterReference(bytes,mediaType,analyze);
}

/** Uses the same local Qwen3-VL model and ComfyUI image graph as reference-describe.
 * The caller must run this only on an idle worker and handle its unavailable/error response.
 * This function never cancels or interrupts any worker job. */
export async function inspectCharacterReference(worker:Worker,bytes:Buffer,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<CharacterReferenceAnalysis>{
  const api=`${worker.origin}${worker.api_prefix??""}`;
  const request=async(path:string,init?:RequestInit)=>{
    const response=await fetch(`${api}${path}`,{...init,redirect:"error",signal:options.signal??AbortSignal.timeout(30_000)});
    if(!response.ok)throw new Error(`The local vision worker returned ${response.status}.`);
    return await response.json() as any;
  };
  const [loader,generator]=await Promise.all([request("/object_info/CLIPLoader"),request("/object_info/TextGenerate")]);
  const models:string[]=loader?.CLIPLoader?.input?.required?.clip_name?.[0]??[];
  if(!generator?.TextGenerate||!models.includes(VISION_CLIP))throw new Error("The local image-reading model is unavailable; choose a picture with one character.");
  const digest=createHash("sha256").update(bytes).digest("hex").slice(0,20);
  const name=`comfyfield-character-sheet-${digest}.png`;
  const form=new FormData();form.append("image",new Blob([new Uint8Array(bytes)],{type:"image/png"}),name);form.append("overwrite","true");
  const uploaded=await request("/upload/image",{method:"POST",body:form});
  if(uploaded?.name!==name||uploaded?.subfolder)throw new Error("The worker could not prepare the character reference.");
  const queued=await request("/prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:visionGraph(name,CHARACTER_SHEET_INSTRUCTION)})});
  if(typeof queued?.prompt_id!=="string"||!queued.prompt_id)throw new Error("The worker could not read the character reference.");
  const until=Date.now()+(options.timeoutMs??240_000);
  while(Date.now()<until){
    options.signal?.throwIfAborted();
    await new Promise<void>((resolve,reject)=>{
      const done=()=>{options.signal?.removeEventListener("abort",abort);resolve();};
      const timer=setTimeout(done,1500);
      const abort=()=>{clearTimeout(timer);reject(options.signal?.reason??new Error("Cancelled"));};
      options.signal?.addEventListener("abort",abort,{once:true});
    });
    const entry=(await request(`/history/${encodeURIComponent(queued.prompt_id)}`))?.[queued.prompt_id];
    if(entry?.status?.status_str==="error")throw new Error("The worker could not read the character reference.");
    const text=entry?.outputs?.["4"]?.text?.[0];
    if(typeof text==="string")return parseCharacterReferenceAnalysis(text);
  }
  throw new Error("Reading the character reference timed out.");
}

