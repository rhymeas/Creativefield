import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createReadStream} from "node:fs";
import {lstat,mkdir,mkdtemp,readdir,realpath,rmdir,unlink} from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {z} from "zod";
import {HttpError} from "./auth";
import {MediaProbeUnavailableError} from "./media";
import {mediaToolchain} from "./media-tools";
import {fileSha256} from "./masked-media";
import type {DiskStore} from "./storage";

const execute=promisify(execFile);
export const MOTION_FPS=24 as const;
export const MAX_MOTION_FRAMES=641;
export const MOTION_MEDIA_VERSION=1 as const;
const FIXED_CREATION_TIME="1970-01-01T00:00:00Z";
export const MOTION_LIMITS=Object.freeze({
  maxFrames:MAX_MOTION_FRAMES,minDimension:16,maxWidth:1920,maxHeight:1920,maxPixels:1920*1080,
  maxSourceDurationSeconds:642/MOTION_FPS,maxSourceFrames:10000,maxAllocBytes:67108864,
  probeTimeoutMs:30000,decodeTimeoutMs:120000,normalizeTimeoutMs:240000,operationTimeoutMs:600000,
  maxProbeOutputBytes:4*1024*1024,maxProcessOutputBytes:1024*1024,maxConcurrent:2,threads:1,
  defaultMaxBytes:512*1024*1024,
});
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const storageKey=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
const normalizationFields={fps:z.literal(24),encoder:z.literal("libx264"),preset:z.literal("veryfast"),
  crf:z.literal(18),pixelFormat:z.literal("yuv420p"),container:z.literal("mp4"),videoTrackTimescale:z.literal(12288),
  threads:z.literal(1),creationTime:z.literal(FIXED_CREATION_TIME),
};
export const motionNormalizationSchema=z.discriminatedUnion("version",[
  z.object({version:z.literal("motion-normalize-v1"),...normalizationFields}).strict(),
  z.object({version:z.literal("motion-normalize-v2"),...normalizationFields,colorRange:z.literal("tv")}).strict(),
]);
export type MotionNormalization=z.infer<typeof motionNormalizationSchema>;
export const MOTION_NORMALIZATION:MotionNormalization=Object.freeze({
  version:"motion-normalize-v2",fps:24,encoder:"libx264",preset:"veryfast",crf:18,pixelFormat:"yuv420p",colorRange:"tv",
  container:"mp4",videoTrackTimescale:12288,threads:1,creationTime:FIXED_CREATION_TIME,
});
export const motionReceiptSchema=z.object({
  schema:z.literal("comfyfield/motion-media-receipt"),version:z.literal(1),workspaceId:z.uuid(),
  sourceKey:storageKey,sourceSha256:digest,sourceBytes:z.number().int().positive(),
  normalizedKey:storageKey,normalizedSha256:digest,normalizedBytes:z.number().int().positive(),
  width:z.number().int().min(MOTION_LIMITS.minDimension).max(MOTION_LIMITS.maxWidth),
  height:z.number().int().min(MOTION_LIMITS.minDimension).max(MOTION_LIMITS.maxHeight),
  decodedFrameCount:z.number().int().min(1).max(MAX_MOTION_FRAMES),fps:z.literal(24),
  rFrameRate:z.literal("24/1"),avgFrameRate:z.literal("24/1"),timeBase:z.string().regex(/^[1-9][0-9]*\/[1-9][0-9]*$/),
  durationSeconds:z.number().positive(),
  durationRational:z.object({numerator:z.number().int().min(1).max(MAX_MOTION_FRAMES),denominator:z.literal(24)}).strict(),
  durationMicroseconds:z.number().int().positive(),startTimeSeconds:z.literal(0),firstFramePtsMicroseconds:z.literal(0),
  sampleAspectRatio:z.literal("1:1"),rotationDegrees:z.literal(0),hasAudio:z.literal(false),streamCount:z.literal(1),
  codec:z.literal("h264"),container:z.literal("mp4"),containerFormatName:z.string().min(1).max(200),
  pixelFormat:z.literal("yuv420p"),timingDigest:digest,normalizationVersion:z.literal(1),
  normalization:motionNormalizationSchema,ffmpegVersion:z.string().min(1).max(200),ffprobeVersion:z.string().min(1).max(200),
}).strict().refine(r=>r.width%2===0&&r.height%2===0&&r.width*r.height<=MOTION_LIMITS.maxPixels
  &&r.durationRational.numerator===r.decodedFrameCount
  &&Math.abs(r.durationSeconds-r.decodedFrameCount/MOTION_FPS)<1e-12
  &&r.durationMicroseconds===Math.round(r.decodedFrameCount*1000000/MOTION_FPS));
export type MotionMediaReceipt=z.infer<typeof motionReceiptSchema>;
export type MotionEnvelope={
  width:number;height:number;decodedFrameCount:number;fps:24;rFrameRate:"24/1";avgFrameRate:"24/1";timeBase:string;
  durationSeconds:number;durationRational:{numerator:number;denominator:24};durationMicroseconds:number;
  startTimeSeconds:0;firstFramePtsMicroseconds:0;sampleAspectRatio:"1:1";rotationDegrees:0;hasAudio:false;
  streamCount:1;codec:"h264";container:"mp4";containerFormatName:string;pixelFormat:"yuv420p";timingDigest:string;bytes:number;
};
export type MotionOutputVerification=MotionEnvelope&{version:1;sha256:string};
export type ExpectedMotionEnvelope={
  width:number;height:number;decodedFrameCount?:number;frames?:number;timingDigest?:string;sha256?:string;normalizedSha256?:string;
};
export type MotionOutputTarget={file:string;ownedRoot:string}|{store:DiskStore;workspaceId:string;key:string};
export type MotionMediaReadiness={state:"ready"|"install_required";missing:string[];ffmpegVersion?:string;ffprobeVersion?:string;encoder:"libx264";instructions:string};
export class MotionMediaError extends HttpError{constructor(message:string){super(422,message);this.name="MotionMediaError";}}
export class MotionMediaUnavailableError extends MediaProbeUnavailableError{constructor(message="Motion media processing is temporarily unavailable"){super(message);this.name="MotionMediaUnavailableError";}}
function invalid(reason:string):never{throw new MotionMediaError(reason);}
function unavailable(reason="Motion media processing is temporarily unavailable"):never{throw new MotionMediaUnavailableError(reason);}
function deepFreeze<T>(value:T):T{
  if(value&&typeof value==="object"&&!Object.isFrozen(value)){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}
  return value;
}
let active=0;
/** Bound expensive motion decoder/encoder work in this process. */
export async function withMotionInspection<T>(work:()=>Promise<T>):Promise<T>{
  if(active>=MOTION_LIMITS.maxConcurrent)throw new HttpError(429,"Motion media processing is busy; retry shortly");
  active++;try{return await work();}finally{active--;}
}
// Restrict demuxers/protocols so a media label can never enable playlists, concat lists or nested reads.
const demuxerOptions=["-protocol_whitelist","file,pipe","-format_whitelist","mov,matroska,webm","-max_alloc",String(MOTION_LIMITS.maxAllocBytes),"-threads",String(MOTION_LIMITS.threads)];
function throwIfCallerAborted(signal?:AbortSignal){
  if(signal?.aborted&&(signal.reason as {name?:string}|undefined)?.name!=="TimeoutError")signal.throwIfAborted();
}
type RunOptions={timeoutMs:number;maxBuffer:number;signal?:AbortSignal;invalidMessage:string;env?:NodeJS.ProcessEnv};
async function runTool(command:string,args:string[],options:RunOptions){
  throwIfCallerAborted(options.signal);
  const bounded=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(options.timeoutMs)]):AbortSignal.timeout(options.timeoutMs);
  try{
    return await execute(command,args,{timeout:options.timeoutMs,maxBuffer:options.maxBuffer,windowsHide:true,signal:bounded,env:options.env});
  }catch(e){
    throwIfCallerAborted(options.signal);
    if(e instanceof HttpError||e instanceof MediaProbeUnavailableError)throw e;
    const processError=e as NodeJS.ErrnoException&{killed?:boolean;signal?:string};
    if(processError.code==="ERR_CHILD_PROCESS_STDIO_MAXBUFFER")invalid("Motion media exceeded inspection limits");
    if(processError.code==="ENOENT"||processError.code==="EACCES"||processError.killed||processError.signal||bounded.aborted)unavailable();
    invalid(options.invalidMessage);
  }
}
async function probe(filename:string,args:string[],signal?:AbortSignal,timeoutMs:number=MOTION_LIMITS.probeTimeoutMs){
  const result=await runTool(process.env.FFPROBE_PATH??"ffprobe",["-v","error",...demuxerOptions,"-err_detect","explode",...args,"-of","json",filename],
    {timeoutMs,maxBuffer:MOTION_LIMITS.maxProbeOutputBytes,signal,invalidMessage:"Motion media is invalid or corrupt"});
  if(String(result.stderr).trim())invalid("Motion media decoding reported damaged media");
  try{return JSON.parse(String(result.stdout));}catch{invalid("Motion media is invalid or corrupt");}
}
async function assertRegularFile(filename:string,maxBytes:number){
  let info:Awaited<ReturnType<typeof lstat>>;
  try{info=await lstat(filename);}catch{invalid("Motion media file is unavailable");}
  if(info!.isSymbolicLink()||!info!.isFile())invalid("Motion media must be a regular file");
  if(info!.size<=0)invalid("Motion media is empty");
  if(info!.size>maxBytes)invalid("Motion media exceeds the configured size limit");
  return info!;
}
function gcd(a:number,b:number):number{let x=Math.abs(a),y=Math.abs(b);while(y){[x,y]=[y,x%y];}return x||1;}
function parseRatio(value:unknown,separator:"/"|":"):({num:number;den:number}|undefined){
  const parts=String(value??"").split(separator).map(Number);
  if(parts.length!==2||!Number.isInteger(parts[0])||!Number.isInteger(parts[1])||parts[1]<=0)return undefined;
  const divisor=gcd(parts[0],parts[1]);return {num:parts[0]/divisor,den:parts[1]/divisor};
}
function canonicalRate(value:unknown):string|undefined{const r=parseRatio(value,"/");return r?`${r.num}/${r.den}`:undefined;}
function ratioValue(value:unknown):number|undefined{const r=parseRatio(value,"/");return r&&r.num>0?r.num/r.den:undefined;}
function rotationDegrees(stream:any):number{
  const side=(stream.side_data_list??[]).find((entry:any)=>entry.rotation!==undefined);
  const raw=side!==undefined?Number(side.rotation):stream.tags?.rotate!==undefined?Number(stream.tags.rotate):0;
  if(!Number.isFinite(raw))invalid("Motion media rotation metadata is invalid");
  return ((raw%360)+360)%360;
}
function timingDigestFor(microseconds:number[]):string{return createHash("sha256").update(JSON.stringify(microseconds)).digest("hex");}
async function assertFullDecode(filename:string,signal?:AbortSignal){
  const result=await runTool(process.env.FFMPEG_PATH??"ffmpeg",
    ["-hide_banner","-loglevel","error","-nostdin","-xerror","-err_detect","explode",...demuxerOptions,"-noautorotate","-i",filename,"-map","0:v:0","-an","-sn","-dn","-fps_mode","passthrough","-f","null","-"],
    {timeoutMs:MOTION_LIMITS.decodeTimeoutMs,maxBuffer:MOTION_LIMITS.maxProcessOutputBytes,signal,invalidMessage:"Motion media is invalid or corrupt"});
  if(String(result.stderr).trim())invalid("Motion media decoding reported damaged media");
}
/** Strict decoded 24-CFR envelope shared by normalization acceptance and motion output verification. */
export async function inspectMotionVideo(filename:string,signal?:AbortSignal,maxBytes=MOTION_LIMITS.defaultMaxBytes):Promise<MotionEnvelope>{
  const info=await assertRegularFile(filename,maxBytes);
  const header=await probe(filename,["-show_streams","-show_format"],signal);
  const streams=header.streams??[],videos=streams.filter((s:any)=>s.codec_type==="video"),v=videos[0];
  if(streams.length!==1||videos.length!==1)invalid("Motion media must contain exactly one video stream and no audio, subtitle or data streams");
  const formatName=String(header.format?.format_name??"");
  if(!formatName.split(",").includes("mp4"))invalid("Motion media must use an MP4 container");
  if(v.codec_name!=="h264")invalid("Motion media must use the H.264 codec");
  if(v.pix_fmt!=="yuv420p")invalid("Motion media must use yuv420p pixels");
  if(!Number.isInteger(v.width)||!Number.isInteger(v.height)||v.width<MOTION_LIMITS.minDimension||v.height<MOTION_LIMITS.minDimension
    ||v.width%2!==0||v.height%2!==0||v.width>MOTION_LIMITS.maxWidth||v.height>MOTION_LIMITS.maxHeight||v.width*v.height>MOTION_LIMITS.maxPixels)
    invalid("Motion media dimensions are outside the supported envelope");
  const sar=v.sample_aspect_ratio;
  if(sar&&sar!=="1:1"&&sar!=="N/A")invalid("Motion media must use square pixels");
  if(rotationDegrees(v)!==0)invalid("Motion media rotation must be baked into the frames");
  if(canonicalRate(v.r_frame_rate)!=="24/1"||canonicalRate(v.avg_frame_rate)!=="24/1")invalid("Motion media must use constant 24 FPS");
  const timeBase=canonicalRate(v.time_base);
  if(!timeBase)invalid("Motion media timing is invalid");
  if(Number(v.start_time)!==0||Number(header.format?.start_time??0)!==0)invalid("Motion media must start at timestamp zero");
  const decoded=await probe(filename,["-select_streams","v:0","-show_frames","-show_entries","frame=best_effort_timestamp_time,width,height,pix_fmt"],signal,MOTION_LIMITS.decodeTimeoutMs);
  const frames=decoded.frames??[];
  if(frames.length<1||frames.length>MAX_MOTION_FRAMES)invalid(`Motion media must contain 1 to ${MAX_MOTION_FRAMES} decoded frames`);
  const pts=frames.map((frame:any,index:number)=>{
    const t=Number(frame.best_effort_timestamp_time),micro=Math.round(t*1000000);
    if(!Number.isFinite(t)||micro!==Math.round(index*1000000/MOTION_FPS)||frame.width!==v.width||frame.height!==v.height||(frame.pix_fmt!==undefined&&frame.pix_fmt!=="yuv420p"))
      invalid("Every decoded frame must match the expected dimensions and exact 24 CFR timestamps");
    return micro;
  });
  const duration=Number(v.duration??header.format?.duration),expectedDuration=frames.length/MOTION_FPS;
  if(!Number.isFinite(duration)||Math.abs(duration-expectedDuration)>1/MOTION_FPS+0.002)invalid("Motion media duration does not match its decoded 24 CFR frame sequence");
  await assertFullDecode(filename,signal);
  return deepFreeze({
    width:v.width as number,height:v.height as number,decodedFrameCount:frames.length,fps:MOTION_FPS,
    rFrameRate:"24/1",avgFrameRate:"24/1",timeBase:timeBase!,durationSeconds:expectedDuration,
    durationRational:{numerator:frames.length,denominator:MOTION_FPS},durationMicroseconds:Math.round(frames.length*1000000/MOTION_FPS),
    startTimeSeconds:0,firstFramePtsMicroseconds:pts[0] as 0,sampleAspectRatio:"1:1",rotationDegrees:0,hasAudio:false,
    streamCount:1,codec:"h264",container:"mp4",containerFormatName:formatName,pixelFormat:"yuv420p",
    timingDigest:timingDigestFor(pts),bytes:info.size,
  }) as MotionEnvelope;
}
type MotionSourceInfo={bytes:number;sar:{num:number;den:number};rotationDegrees:number;durationSeconds:number;decodedFrames:number;hasAudio:boolean};
async function inspectMotionSource(filename:string,signal:AbortSignal|undefined,maxBytes:number):Promise<MotionSourceInfo>{
  const info=await assertRegularFile(filename,maxBytes);
  const header=await probe(filename,["-show_streams","-show_format"],signal);
  const streams=header.streams??[],videos=streams.filter((s:any)=>s.codec_type==="video"),v=videos[0];
  if(videos.length!==1||!streams.length)invalid("Choose a motion source with exactly one video stream");
  if(streams.some((s:any)=>!["video","audio","subtitle","data"].includes(s.codec_type)))invalid("Motion source contains an unsupported stream");
  if(Number(v.disposition?.attached_pic??0)!==0||typeof v.codec_name!=="string"||!v.codec_name)invalid("Choose a motion source with a decodable video stream");
  const formatName=String(header.format?.format_name??"");
  if(!formatName.split(",").some((name:string)=>["mov","mp4","matroska","webm"].includes(name)))invalid("Choose an MP4, MOV, MKV or WebM motion source");
  const rotation=rotationDegrees(v);
  if(rotation%90!==0)invalid("Motion source rotation must be a multiple of 90 degrees");
  const rawSar=v.sample_aspect_ratio&&v.sample_aspect_ratio!=="N/A"?parseRatio(v.sample_aspect_ratio,":"):undefined;
  const sar=rawSar??{num:1,den:1};
  if(rawSar&&(sar.num<=0||sar.num/sar.den<0.25||sar.num/sar.den>4))invalid("Motion source pixel aspect ratio is unsupported");
  if(!Number.isInteger(v.width)||!Number.isInteger(v.height)||v.width<MOTION_LIMITS.minDimension||v.height<MOTION_LIMITS.minDimension)
    invalid("Motion source dimensions are outside the supported envelope");
  const displayWidth=v.width*sar.num/sar.den,displayHeight=v.height as number;
  const effectiveWidth=rotation%180===90?displayHeight:displayWidth,effectiveHeight=rotation%180===90?displayWidth:displayHeight;
  if(effectiveWidth>MOTION_LIMITS.maxWidth||effectiveHeight>MOTION_LIMITS.maxHeight||effectiveWidth*effectiveHeight>MOTION_LIMITS.maxPixels)
    invalid("Motion source dimensions are outside the supported envelope");
  const rate=ratioValue(v.avg_frame_rate)??ratioValue(v.r_frame_rate);
  if(rate===undefined||rate>240)invalid("Motion source frame rate is unsupported");
  const duration=Number(v.duration??header.format?.duration);
  if(!Number.isFinite(duration)||duration<=0||duration>MOTION_LIMITS.maxSourceDurationSeconds+0.001)
    invalid(`Motion source must be at most ${MAX_MOTION_FRAMES} frames at 24 FPS (${(MAX_MOTION_FRAMES/MOTION_FPS).toFixed(3)} seconds)`);
  const counted=await probe(filename,["-select_streams","v:0","-count_frames","-show_entries","stream=nb_read_frames"],signal,MOTION_LIMITS.decodeTimeoutMs);
  const decodedFrames=Number(counted.streams?.[0]?.nb_read_frames);
  if(!Number.isSafeInteger(decodedFrames)||decodedFrames<1||decodedFrames>MOTION_LIMITS.maxSourceFrames)invalid("Motion source decoded frame count is outside the supported envelope");
  return {bytes:info.size,sar,rotationDegrees:rotation,durationSeconds:duration,decodedFrames,hasAudio:streams.some((s:any)=>s.codec_type==="audio")};
}
export async function motionMediaReadiness(signal?:AbortSignal):Promise<MotionMediaReadiness>{
  const toolchain=await mediaToolchain(signal);const missing:string[]=[];
  if(!toolchain.ffmpegVersion)missing.push("FFmpeg");else if(!toolchain.libx264)missing.push("FFmpeg with libx264 encoder");
  if(!toolchain.ffprobeVersion)missing.push("FFprobe");
  return {state:missing.length?"install_required":"ready",missing,ffmpegVersion:toolchain.ffmpegVersion,ffprobeVersion:toolchain.ffprobeVersion,
    encoder:"libx264",instructions:"Install FFmpeg (with the libx264 encoder) and FFprobe on the team server, or set FFMPEG_PATH and FFPROBE_PATH to their executables. Scratch and media use the configured storage root."};
}
export const motionReadiness=motionMediaReadiness;
async function createScratch(store:DiskStore){
  let resolvedScratch:string,dir:string;
  try{
    await mkdir(store.root,{recursive:true});
    const scratch=path.join(store.root,".motion-media");await mkdir(scratch,{recursive:true});
    if((await lstat(scratch)).isSymbolicLink())invalid("Motion media scratch directory is invalid");
    resolvedScratch=await realpath(scratch);
    if(path.dirname(resolvedScratch)!==await realpath(store.root))invalid("Motion media scratch directory is invalid");
    dir=await mkdtemp(path.join(resolvedScratch,"attempt-"));
    if((await lstat(dir)).isSymbolicLink()||path.dirname(await realpath(dir))!==resolvedScratch)invalid("Motion media scratch directory is invalid");
  }catch(e){
    if(e instanceof HttpError||e instanceof MediaProbeUnavailableError)throw e;
    unavailable("Motion media scratch storage is unavailable");
  }
  return {dir:dir!,resolvedScratch:resolvedScratch!};
}
async function cleanupScratch(dir:string,resolvedScratch:string){
  try{
    if(path.dirname(await realpath(dir))!==resolvedScratch)return;
    for(const entry of await readdir(dir,{withFileTypes:true}))if(entry.isFile())await unlink(path.join(dir,entry.name));
    await rmdir(dir);
  }catch{/* Owned scratch is best-effort cleanup; never mask the processing result. */}
}
async function resolveStoreFile(store:DiskStore,workspaceId:string,key:string,signal?:AbortSignal):Promise<string>{
  try{return await store.file(workspaceId,key);}
  catch{throwIfCallerAborted(signal);invalid("Motion media is not a workspace storage asset");}
}
async function resolveOwnedCandidate(file:string,ownedRoot:string):Promise<string>{
  if(!path.isAbsolute(file)||!path.isAbsolute(ownedRoot))invalid("Motion output candidate and owned root must be absolute paths");
  try{
    const rootInfo=await lstat(ownedRoot);
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())invalid("Motion output candidate root is invalid");
    const resolvedRoot=await realpath(ownedRoot),resolvedFile=await realpath(file);
    const relative=path.relative(resolvedRoot,resolvedFile);
    if(relative===""||relative.startsWith("..")||path.isAbsolute(relative))invalid("Motion output candidate escapes its owned root");
    return resolvedFile;
  }catch(e){
    if(e instanceof HttpError||e instanceof MediaProbeUnavailableError)throw e;
    invalid("Motion output candidate is unavailable");
  }
}
/**
 * Normalize a workspace-owned DiskStore video to silent deterministic 24-CFR H.264 MP4.
 * The source is hashed and validated first, the candidate is strictly verified before
 * publication through DiskStore, and the source is re-hashed before acceptance.
 */
export async function normalizeMotionInput(store:DiskStore,workspaceId:string,sourceKey:string,cancel?:AbortSignal,candidateId?:string):Promise<MotionMediaReceipt>{
  return withMotionInspection(async()=>{
    cancel?.throwIfAborted();
    const signal=cancel?AbortSignal.any([cancel,AbortSignal.timeout(MOTION_LIMITS.operationTimeoutMs)]):AbortSignal.timeout(MOTION_LIMITS.operationTimeoutMs);
    const sourceFile=await resolveStoreFile(store,workspaceId,sourceKey,signal);
    const toolchain=await mediaToolchain(signal);
    if(!toolchain.ffmpegVersion||!toolchain.ffprobeVersion||!toolchain.libx264)unavailable("Motion media tools are unavailable");
    const maxBytes=store.maxBytes;
    await assertRegularFile(sourceFile,maxBytes);
    let sourceSha256:string;
    try{sourceSha256=await fileSha256(sourceFile);}catch{throwIfCallerAborted(signal);invalid("Motion source could not be read");}
    const source=await inspectMotionSource(sourceFile,signal,maxBytes);
    throwIfCallerAborted(signal);
    const {dir,resolvedScratch}=await createScratch(store);
    let candidate:Awaited<ReturnType<DiskStore["put"]>>|undefined;
    try{
      const output=path.join(dir,"normalized.mp4");
      const scale=source.sar.num===source.sar.den?"scale=trunc(iw/2)*2:trunc(ih/2)*2":`scale=trunc(iw*${source.sar.num}/${source.sar.den}/2)*2:trunc(ih/2)*2`;
      const rotation=source.rotationDegrees===90?",transpose=cclock":source.rotationDegrees===180?",hflip,vflip":source.rotationDegrees===270?",transpose=clock":"";
      const filter=`setpts=PTS-STARTPTS,${scale}:in_range=auto:out_range=tv,setsar=1${rotation},fps=fps=${MOTION_FPS}:start_time=0:round=near:eof_action=pass,setpts=N/(${MOTION_FPS}*TB),format=yuv420p`;
      const encoded=await runTool(process.env.FFMPEG_PATH??"ffmpeg",[
        "-hide_banner","-loglevel","error","-nostdin","-n","-xerror","-err_detect","explode",...demuxerOptions,"-noautorotate","-display_rotation","0","-i",sourceFile,
        "-filter_threads","1","-map","0:v:0","-vf",filter,"-an","-sn","-dn","-fps_mode","cfr",
        "-c:v","libx264","-threads",String(MOTION_NORMALIZATION.threads),"-preset",MOTION_NORMALIZATION.preset,"-crf",String(MOTION_NORMALIZATION.crf),
        "-pix_fmt","yuv420p","-color_range","tv","-tag:v","avc1","-frames:v",String(MAX_MOTION_FRAMES+1),"-map_metadata","-1","-map_chapters","-1",
        "-creation_time",FIXED_CREATION_TIME,"-video_track_timescale",String(MOTION_NORMALIZATION.videoTrackTimescale),"-movflags","+faststart",
        "-fs",String(maxBytes+1),"-f","mp4",output,
      ],{timeoutMs:MOTION_LIMITS.normalizeTimeoutMs,maxBuffer:MOTION_LIMITS.maxProcessOutputBytes,signal,
        invalidMessage:"Motion source could not be normalized because the media is invalid or unsupported",env:{...process.env,SOURCE_DATE_EPOCH:"0"}});
      if(String(encoded.stderr).trim())invalid("Motion normalization reported damaged media");
      const envelope=await inspectMotionVideo(output,signal,maxBytes);
      const normalizedSha256=await fileSha256(output);
      const sourceAgain=await resolveStoreFile(store,workspaceId,sourceKey,signal);
      if(await fileSha256(sourceAgain)!==sourceSha256!)invalid("Motion source changed during normalization; upload it again");
      throwIfCallerAborted(signal);
      try{candidate=await store.put(workspaceId,createReadStream(output),candidateId);}
      catch{throwIfCallerAborted(signal);unavailable("Normalized motion media could not be stored");}
      cancel?.throwIfAborted();
      if(signal.aborted)unavailable();
      if(candidate!.sha256!==normalizedSha256||candidate!.bytes!==envelope.bytes)invalid("Normalized motion media changed during publication");
      return deepFreeze(motionReceiptSchema.parse({
        schema:"comfyfield/motion-media-receipt",version:MOTION_MEDIA_VERSION,workspaceId,sourceKey,sourceSha256:sourceSha256!,sourceBytes:source.bytes,
        normalizedKey:candidate!.key,normalizedSha256,normalizedBytes:envelope.bytes,width:envelope.width,height:envelope.height,
        decodedFrameCount:envelope.decodedFrameCount,fps:MOTION_FPS,rFrameRate:envelope.rFrameRate,avgFrameRate:envelope.avgFrameRate,timeBase:envelope.timeBase,
        durationSeconds:envelope.durationSeconds,durationRational:envelope.durationRational,durationMicroseconds:envelope.durationMicroseconds,
        startTimeSeconds:0,firstFramePtsMicroseconds:0,sampleAspectRatio:envelope.sampleAspectRatio,rotationDegrees:0,hasAudio:false,streamCount:1,
        codec:envelope.codec,container:envelope.container,containerFormatName:envelope.containerFormatName,pixelFormat:envelope.pixelFormat,
        timingDigest:envelope.timingDigest,normalizationVersion:MOTION_MEDIA_VERSION,normalization:MOTION_NORMALIZATION,
        ffmpegVersion:toolchain.ffmpegVersion!,ffprobeVersion:toolchain.ffprobeVersion!,
      }));
    }catch(e){
      if(candidate)await store.remove(workspaceId,candidate.key).catch(()=>{});
      throwIfCallerAborted(cancel);
      if(e instanceof HttpError||e instanceof MediaProbeUnavailableError)throw e;
      throw new MotionMediaError("Motion normalization failed because the media is invalid or unsupported");
    }finally{await cleanupScratch(dir,resolvedScratch);}
  });
}
function parseExpected(expected:ExpectedMotionEnvelope|MotionMediaReceipt){
  if(!expected||typeof expected!=="object")invalid("A motion output envelope is required");
  const candidate=expected as ExpectedMotionEnvelope&Partial<MotionMediaReceipt>;
  const frames=candidate.decodedFrameCount??candidate.frames;
  if(candidate.decodedFrameCount!==undefined&&candidate.frames!==undefined&&candidate.decodedFrameCount!==candidate.frames)invalid("Motion output envelope frame counts disagree");
  if(!Number.isInteger(candidate.width)||!Number.isInteger(candidate.height)||candidate.width<MOTION_LIMITS.minDimension||candidate.height<MOTION_LIMITS.minDimension
    ||candidate.width>MOTION_LIMITS.maxWidth||candidate.height>MOTION_LIMITS.maxHeight||!Number.isInteger(frames)||frames!<1||frames!>MAX_MOTION_FRAMES)
    invalid("Motion output envelope is outside the supported bounds");
  const timingDigest=candidate.timingDigest,sha256=candidate.sha256??candidate.normalizedSha256;
  if(timingDigest!==undefined&&!/^[a-f0-9]{64}$/.test(timingDigest))invalid("Motion output timing digest is invalid");
  if(sha256!==undefined&&!/^[a-f0-9]{64}$/.test(sha256))invalid("Motion output digest is invalid");
  return {width:candidate.width,height:candidate.height,decodedFrameCount:frames!,timingDigest,sha256};
}
/** Strictly verify a candidate or stored motion output against an expected envelope. Never publishes or mutates records. */
export async function verifyMotionOutput(target:MotionOutputTarget,expected:ExpectedMotionEnvelope|MotionMediaReceipt,cancel?:AbortSignal):Promise<MotionOutputVerification>{
  return withMotionInspection(async()=>{
    cancel?.throwIfAborted();
    const signal=cancel?AbortSignal.any([cancel,AbortSignal.timeout(MOTION_LIMITS.operationTimeoutMs)]):AbortSignal.timeout(MOTION_LIMITS.operationTimeoutMs);
    const envelope=parseExpected(expected);
    let filename:string,maxBytes=MOTION_LIMITS.defaultMaxBytes;
    if(target&&typeof target==="object"&&"file" in target){
      filename=await resolveOwnedCandidate(target.file,target.ownedRoot);
    }else if(target&&typeof target==="object"&&"store" in target){
      filename=await resolveStoreFile(target.store,target.workspaceId,target.key,signal);maxBytes=target.store.maxBytes;
    }else invalid("Motion output must be a candidate file or a DiskStore identity");
    const actual=await inspectMotionVideo(filename!,signal,maxBytes);
    if(actual.width!==envelope.width||actual.height!==envelope.height||actual.decodedFrameCount!==envelope.decodedFrameCount)
      invalid("Motion output dimensions or decoded frame count do not match the expected envelope");
    if(envelope.timingDigest!==undefined&&actual.timingDigest!==envelope.timingDigest)invalid("Motion output timing does not match the expected envelope");
    let sha256:string;
    try{sha256=await fileSha256(filename!);}catch{throwIfCallerAborted(signal);invalid("Motion output could not be read");}
    if(envelope.sha256!==undefined&&sha256!==envelope.sha256)invalid("Motion output digest does not match the expected envelope");
    throwIfCallerAborted(signal);
    return deepFreeze({version:MOTION_MEDIA_VERSION,...actual,sha256}) as MotionOutputVerification;
  });
}



