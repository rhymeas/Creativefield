import {readFile,stat} from "node:fs/promises";
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {HttpError,member} from "./auth";
import {aiTextSettings,generateText,imageTextProvider,type AiTextImage} from "./ai-text";
import type {DiskStore} from "./storage";
import {extractJsonObject} from "./storyboard-plan";

const requestSchema=z.object({projectId:z.uuid(),startImageId:z.uuid(),endImageId:z.uuid().optional(),intent:z.string().max(4000).default(""),seconds:z.number().min(1).max(30)}).strict();
const resultSchema=z.object({meta:z.record(z.string(),z.unknown()),scene:z.record(z.string(),z.unknown()),characters:z.array(z.unknown()),action:z.string().min(1),preservation:z.string().min(1),audio:z.string(),quality:z.string().min(1)}).passthrough();

/** Structured H3 prompt, adapted to still-image animation rather than character swap. */
export function videoPromptInstruction(hasEnd:boolean){
  return `Create an accurate image-to-video generation prompt. Inspect ${hasEnd?"both images in order: first is the start and second is the intended end":"the single start image"}. Return only a JSON object with meta (aspect_ratio, style, camera), scene (location, lighting, atmosphere), characters (array), action, preservation, audio, quality. The user's direction is the primary instruction: faithfully include its requested action, style, camera, audio and changes; never replace or contradict it with generic defaults. Ground visual details in the images and do not invent identities, dialog or major events. ${hasEnd?"Describe a plausible continuous transition from the first image towards the second; keep their order clear.":"When no action was requested, describe natural, restrained motion suited to the image."} Preserve identity, composition and background unless the user asks to change them. Keep the JSON concise and omit unsupported claims.`;
}
export function parseVideoPrompt(text:string){
  try{const value=resultSchema.parse(JSON.parse(extractJsonObject(text)));return JSON.stringify(value,null,2);}
  catch{throw new HttpError(502,"The prompt assistant could not produce a usable prompt. Your text was not changed.");}
}
export async function videoPromptRoutes(app:FastifyInstance,pool:Pool,store:DiskStore){
  app.post("/api/v1/workspaces/:workspaceId/video-prompt",async request=>{
    const {workspaceId}=z.object({workspaceId:z.uuid()}).parse(request.params);
    await member(pool,request,workspaceId,"creator");
    const body=requestSchema.parse(request.body??{}),ids=[body.startImageId,...(body.endImageId?[body.endImageId]:[])];
    const images:AiTextImage[]=[];
    for(const id of ids){
      const asset=(await pool.query("SELECT storage_key,content_type FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3",[workspaceId,body.projectId,id])).rows[0];
      if(!asset||!['image/jpeg','image/png','image/webp'].includes(asset.content_type))throw new HttpError(404,"A reference image is unavailable in this project.");
      const file=await store.file(workspaceId,asset.storage_key);
      if((await stat(file)).size>15*1024*1024)throw new HttpError(413,"The reference image is too large for the prompt assistant.");
      images.push({mediaType:asset.content_type,bytes:await readFile(file)});
    }
    const provider=imageTextProvider(await aiTextSettings(pool,workspaceId));
    if(!provider)throw new HttpError(503,"Reading images needs ChatGPT or a text API. Connect one in Settings.");
    const answer=await generateText(provider,{workspaceId,system:videoPromptInstruction(images.length===2),prompt:`Duration: ${body.seconds} seconds. User direction: ${body.intent.trim()||"No additional direction; choose subtle motion."}`,images,maxTokens:1400,json:true},{pool});
    return {prompt:parseVideoPrompt(answer.text),provider:answer.provider,model:answer.model};
  });
}
