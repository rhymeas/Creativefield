import {execFile} from "node:child_process";
import {promisify} from "node:util";
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {member,HttpError} from "./auth";
import {MOTION_LIMITS} from "./motion-media";
import type {DiskStore} from "./storage";

const execute=promisify(execFile);
/** Replace character renders 81 frames per pass; a later pass borrows the 5 last frames of the pass before. */
export const SCAIL_CHUNK_FRAMES=81;
export const SCAIL_ANCHOR_FRAMES=5;
export const SCAIL_STEP_FRAMES=SCAIL_CHUNK_FRAMES-SCAIL_ANCHOR_FRAMES;
export const SCAIL_MAX_CHUNKS=8;
/** The longest clip the panel can finish: eight passes, each adding 76 new frames after the first anchor. */
export const REPLACE_CLIP_MAX_FRAMES=SCAIL_ANCHOR_FRAMES+SCAIL_STEP_FRAMES*SCAIL_MAX_CHUNKS;
export type ReplaceClipCheck={frames:number;seconds:number;chunks:number};
type ProbeHeader={streams?:Array<{codec_type?:unknown;codec_name?:unknown;duration?:unknown;nb_read_frames?:unknown}>;format?:{duration?:unknown}};
/** How many 81-frame passes a clip needs. One pass covers the first 81 frames, every later pass adds 76. */
export function scailChunkCount(frames:number):number{
  return Math.max(1,Math.ceil((frames-SCAIL_ANCHOR_FRAMES)/SCAIL_STEP_FRAMES));
}
// Only the containers a source clip may use are opened; nothing here re-encodes or writes.
const probeArgs=["-v","error","-protocol_whitelist","file,pipe","-format_whitelist","mov,matroska,webm",
  "-max_alloc",String(MOTION_LIMITS.maxAllocBytes),"-threads",String(MOTION_LIMITS.threads),
  "-select_streams","v:0","-count_frames","-show_entries","stream=codec_type,codec_name,duration,nb_read_frames:format=duration",
  "-of","json"];

function unreadable():never{throw new HttpError(422,"This clip is not a video the server can read.");}

let active=0;
/** Bound the whole-clip decodes this route starts, so a few uploads cannot fill the machine. */
async function withClipProbe<T>(work:()=>Promise<T>):Promise<T>{
  if(active>=MOTION_LIMITS.maxConcurrent)throw new HttpError(429,"Clip checks are busy. Try again in a moment.");
  active++;
  try{return await work();}finally{active--;}
}

/** Measure one source clip: the panel can name real frames and passes instead of a guess. */
export function inspectReplaceClip(filename:string,cancel?:AbortSignal):Promise<ReplaceClipCheck>{
  return withClipProbe(()=>probeReplaceClip(filename,cancel));
}

async function probeReplaceClip(filename:string,cancel?:AbortSignal):Promise<ReplaceClipCheck>{
  cancel?.throwIfAborted();
  const timeout=AbortSignal.timeout(MOTION_LIMITS.decodeTimeoutMs);
  const signal=cancel?AbortSignal.any([cancel,timeout]):timeout;
  let stdout:string;
  try{
    stdout=String((await execute(process.env.FFPROBE_PATH??"ffprobe",[...probeArgs,filename],
      {timeout:MOTION_LIMITS.decodeTimeoutMs,maxBuffer:MOTION_LIMITS.maxProbeOutputBytes,windowsHide:true,signal})).stdout);
  }catch(error){
    cancel?.throwIfAborted();
    const failure=error as NodeJS.ErrnoException&{killed?:boolean;signal?:string};
    if(failure.code==="ENOENT"||failure.code==="EACCES"||failure.killed||failure.signal||signal.aborted)
      throw new HttpError(503,"The server cannot read clips right now.");
    unreadable();
  }
  let header:ProbeHeader;
  try{header=JSON.parse(stdout!);}catch{unreadable();}
  const video=header!.streams?.[0];
  if(!video||typeof video.codec_name!=="string"||!video.codec_name)throw new HttpError(422,"This clip has no video the server can play.");
  const frames=Number(video.nb_read_frames);
  if(!Number.isSafeInteger(frames)||frames<1)throw new HttpError(422,"This clip has no readable frames.");
  if(frames>REPLACE_CLIP_MAX_FRAMES)
    throw new HttpError(422,`This clip is ${frames} frames. Replace character takes clips up to ${REPLACE_CLIP_MAX_FRAMES} frames.`);
  const seconds=Number(video.duration??header!.format?.duration);
  if(!Number.isFinite(seconds)||seconds<=0)throw new HttpError(422,"This clip has no readable length.");
  // Replace character keeps the clip's own frame rate, so the decoded frame count is the count the run uses.
  return {frames,seconds:Math.round(seconds*1000)/1000,chunks:scailChunkCount(frames)};
}

export async function replaceClipCheckRoutes(app:FastifyInstance,pool:Pool,store:DiskStore){
  const base="/api/v1/workspaces/:workspaceId",ws=z.object({workspaceId:z.uuid()}),query=z.object({assetId:z.uuid()}).strict();
  app.get(`${base}/replace-clip-check`,async request=>{
    const {workspaceId}=ws.parse(request.params);await member(pool,request,workspaceId);
    const {assetId}=query.parse(request.query);
    const asset=(await pool.query("SELECT storage_key,media_type FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,assetId])).rows[0];
    if(!asset)throw new HttpError(404,"This clip is not in this workspace.");
    if(asset.media_type!=="video")throw new HttpError(422,"Choose a video clip, not an image.");
    let file:string;
    try{file=await store.file(workspaceId,asset.storage_key);}catch{throw new HttpError(422,"This clip is missing from storage.");}
    return inspectReplaceClip(file);
  });
}
