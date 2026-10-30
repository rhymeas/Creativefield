import {execFile} from "node:child_process";
import {promisify} from "node:util";
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {member,HttpError} from "./auth";
import {MAX_MOTION_FRAMES,MOTION_FPS,MOTION_LIMITS,withMotionInspection} from "./motion-media";
import {planWanAnimateFrames} from "../src/capabilities/motion";
import type {DiskStore} from "./storage";

const execute=promisify(execFile);
/** A driving clip may not be longer than the eight chunks Copy moves can render. */
export const MOTION_CLIP_MAX_SECONDS=MAX_MOTION_FRAMES/MOTION_FPS;
export type MotionClipCheck={frames:number;seconds:number;chunks:number};
type ProbeHeader={streams?:Array<{codec_type?:unknown;codec_name?:unknown;duration?:unknown}>;format?:{duration?:unknown}};
// Only the containers a driving clip may use are opened; nothing here re-encodes or writes.
const probeArgs=["-v","error","-protocol_whitelist","file,pipe","-format_whitelist","mov,matroska,webm",
  "-max_alloc",String(MOTION_LIMITS.maxAllocBytes),"-threads",String(MOTION_LIMITS.threads),
  "-show_streams","-show_format","-of","json"];

function unreadable():never{throw new HttpError(422,"This clip is not a video the server can read.");}

/** Measure one driving clip: the composer can name real frames and chunks instead of a guess. */
export async function inspectMotionClip(filename:string,cancel?:AbortSignal):Promise<MotionClipCheck>{
  return withMotionInspection(async()=>{
    cancel?.throwIfAborted();
    const timeout=AbortSignal.timeout(MOTION_LIMITS.probeTimeoutMs);
    const signal=cancel?AbortSignal.any([cancel,timeout]):timeout;
    let stdout:string;
    try{
      stdout=String((await execute(process.env.FFPROBE_PATH??"ffprobe",[...probeArgs,filename],
        {timeout:MOTION_LIMITS.probeTimeoutMs,maxBuffer:MOTION_LIMITS.maxProbeOutputBytes,windowsHide:true,signal})).stdout);
    }catch(error){
      cancel?.throwIfAborted();
      const failure=error as NodeJS.ErrnoException&{killed?:boolean;signal?:string};
      if(failure.code==="ENOENT"||failure.code==="EACCES"||failure.killed||failure.signal||signal.aborted)
        throw new HttpError(503,"The server cannot read clips right now.");
      unreadable();
    }
    let header:ProbeHeader;
    try{header=JSON.parse(stdout!);}catch{unreadable();}
    const video=header!.streams?.find(stream=>stream?.codec_type==="video");
    if(!video||typeof video.codec_name!=="string"||!video.codec_name)throw new HttpError(422,"This clip has no video the server can play.");
    const seconds=Number(video.duration??header!.format?.duration);
    if(!Number.isFinite(seconds)||seconds<=0)throw new HttpError(422,"This clip has no readable length.");
    if(seconds>MOTION_CLIP_MAX_SECONDS+0.001)
      throw new HttpError(422,`This clip is ${seconds.toFixed(1)} s. Copy moves takes clips up to ${MOTION_CLIP_MAX_SECONDS.toFixed(1)} s.`);
    // Normalization resamples to 24 frames a second, so that is the frame count the run will use.
    const frames=Math.min(MAX_MOTION_FRAMES,Math.max(1,Math.round(seconds*MOTION_FPS)));
    return {frames,seconds:Math.round(seconds*1000)/1000,chunks:planWanAnimateFrames(frames).chunkCount};
  });
}

export async function motionClipCheckRoutes(app:FastifyInstance,pool:Pool,store:DiskStore){
  const base="/api/v1/workspaces/:workspaceId",ws=z.object({workspaceId:z.uuid()}),query=z.object({assetId:z.uuid()}).strict();
  app.get(`${base}/motion-clip-check`,async request=>{
    const {workspaceId}=ws.parse(request.params);await member(pool,request,workspaceId);
    const {assetId}=query.parse(request.query);
    const asset=(await pool.query("SELECT storage_key,media_type FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,assetId])).rows[0];
    if(!asset)throw new HttpError(404,"This clip is not in this workspace.");
    if(asset.media_type!=="video")throw new HttpError(422,"Choose a video clip, not an image.");
    let file:string;
    try{file=await store.file(workspaceId,asset.storage_key);}catch{throw new HttpError(422,"This clip is missing from storage.");}
    return inspectMotionClip(file);
  });
}
