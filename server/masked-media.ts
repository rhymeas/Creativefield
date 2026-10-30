import {execFile,spawn} from "node:child_process";
import {promisify} from "node:util";
import {createReadStream} from "node:fs";
import {mkdtemp,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {EventEmitter} from "node:events";
import {z} from "zod";
import {HttpError} from "./auth";
import type {MaskSequenceSnapshot} from "../src/capabilities/types";
import {MediaProbeUnavailableError} from "./media";
import {MaskCoverageBuilder} from "../src/capabilities/mask-coverage";

const execute=promisify(execFile);
export class BackgroundMaskValidationError extends HttpError {
  constructor(message:string){super(422,message);}
}
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const maskSnapshotSchema=z.object({
  validationVersion:z.literal(1),sourceAssetId:z.uuid(),sourceSha256:digest,maskSha256:digest,
  width:z.number().int().min(16).max(832),height:z.number().int().min(16).max(832),fps:z.literal(16),
  frames:z.number().int().min(17).max(81),timingDigest:digest,semantics:z.literal("white_edits_black_preserves"),
}).strict().refine(s=>s.width%16===0&&s.height%16===0&&s.width*s.height<=832*480&&(s.frames-1)%4===0);
export const maskNormalizationSchema=z.object({
  validationVersion:z.literal(1),contract:z.literal("mask_normalization_v1"),
  originalSourceAssetId:z.uuid(),originalSourceSha256:digest,originalMaskSha256:digest,
  normalizedSourceAssetId:z.uuid(),normalizedSourceSha256:digest,normalizedMaskAssetId:z.uuid(),normalizedMaskSha256:digest,
  width:z.number().int().min(16).max(832),height:z.number().int().min(16).max(832),fps:z.literal(16),
  frames:z.number().int().min(17).max(81),timingDigest:digest,transform:z.string().min(1).max(240),
}).strict().refine(n=>n.width%16===0&&n.height%16===0&&n.width*n.height<=832*480&&(n.frames-1)%4===0);
export const sourceLinkedMaskSchema=z.object({
  validationVersion:z.literal(1),contract:z.literal("source_linked_mask_v1"),sourceAssetId:z.uuid(),sourceSha256:digest,
  maskAssetId:z.uuid(),maskSha256:digest,projectId:z.uuid(),producerRunId:z.uuid(),width:z.number().int(),height:z.number().int(),
  fps:z.literal(16),frames:z.number().int(),timingDigest:digest,semantics:z.literal("white_edits_black_preserves"),workflowId:z.string().min(1),
  workflowVersion:z.string().min(1),routeId:z.string().min(1),workflowRevisionId:z.uuid(),workflowSha256:digest,
  requiredCheckpoint:z.string().min(1),requiredCheckpointSha256:digest,
}).strict();
export const maskReviewReceiptSchema=z.object({
  validationVersion:z.literal(1),contract:z.literal("source_linked_mask_review_v1"),decision:z.enum(["approved","rejected"]),maskAssetId:z.uuid(),
  maskSha256:digest,sourceAssetId:z.uuid(),sourceSha256:digest,projectId:z.uuid(),producerRunId:z.uuid(),reviewedBy:z.uuid(),reviewedAt:z.iso.datetime(),
}).strict();
// Do not let a video MIME label enable playlist/concat demuxers and nested file reads.
const inputOptions=["-v","error","-protocol_whitelist","file,pipe","-format_whitelist","mov,matroska,webm","-max_alloc","67108864","-threads","1"];
let active=0;
/** Bound the expensive decoder work across uploads and output verification in this process. */
export async function withMaskInspection<T>(work:()=>Promise<T>):Promise<T>{
  if(active>=2)throw new HttpError(429,"Media validation is busy; retry shortly");
  active++;try{return await work();}finally{active--;}
}
export async function fileSha256(filename:string):Promise<string>{
  const hash=createHash("sha256");for await(const chunk of createReadStream(filename))hash.update(chunk);return hash.digest("hex");
}
function invalid(reason:string):never{throw new HttpError(422,reason);}
async function probe(filename:string,args:string[]){
  try{
    const result=await execute(process.env.FFPROBE_PATH??"ffprobe",[...inputOptions,"-err_detect","explode",...args,"-of","json",filename],{timeout:20000,maxBuffer:2*1024*1024,windowsHide:true});
    if(result.stderr.trim())invalid("Video decoding reported damaged media");
    return JSON.parse(result.stdout);
  }catch(e){
    if(e instanceof HttpError||e instanceof MediaProbeUnavailableError)throw e;
    const processError=e as NodeJS.ErrnoException&{killed?:boolean;signal?:string};
    if(processError.code==="ENOENT"||processError.code==="EACCES"||processError.killed||processError.signal)throw new MediaProbeUnavailableError("Video validation is temporarily unavailable");
    invalid("Video validation failed because the media is invalid");
  }
}
/** Strict, bounded initial VACE envelope. No resampling, looping, padding or truncation. */
export async function inspectMaskVideo(filename:string){
  if((await stat(filename)).size>128*1024*1024)invalid("Masked editing accepts files up to 128 MiB");
  const header=await probe(filename,["-show_streams","-show_format"]);
  const streams=header.streams??[],videos=streams.filter((s:any)=>s.codec_type==="video"),v=videos[0];
  if(videos.length!==1||streams.some((s:any)=>!["video","audio"].includes(s.codec_type)))invalid("Choose a file with one video stream");
  if(!Number.isInteger(v.width)||!Number.isInteger(v.height)||v.width<16||v.height<16||v.width%16||v.height%16||v.width>832||v.height>832||v.width*v.height>832*480)invalid("Use dimensions divisible by 16, with at most 832 pixels per side and 399360 pixels per frame");
  if(v.sample_aspect_ratio&&v.sample_aspect_ratio!=="1:1")invalid("Use square pixels for aligned masked editing");
  if(Number(v.tags?.rotate??0)!==0||(v.side_data_list??[]).some((s:any)=>s.rotation!==undefined&&Number(s.rotation)!==0))invalid("Bake rotation into the source before uploading");
  const rate=(s:string)=>{const [a,b]=String(s).split("/").map(Number);return a/b;};
  if(rate(v.r_frame_rate)!==16||rate(v.avg_frame_rate)!==16||Number(v.start_time)!==0)invalid("Use constant 16 FPS video starting at timestamp zero");
  const duration=Number(v.duration??header.format?.duration);
  if(!Number.isFinite(duration)||duration<1||duration>5.063)invalid("Use 17 to 81 frames at 16 FPS");
  const decoded=await probe(filename,["-select_streams","v:0","-show_frames","-show_entries","frame=best_effort_timestamp_time,width,height"]);
  const frames=decoded.frames??[];
  if(frames.length<17||frames.length>81||(frames.length-1)%4!==0)invalid("Use 17 to 81 frames with a frame count of 4n+1");
  const pts=frames.map((frame:any,index:number)=>{
    const t=Number(frame.best_effort_timestamp_time);
    if(!Number.isFinite(t)||Math.abs(t-index/16)>0.000001||frame.width!==v.width||frame.height!==v.height)invalid("Every decoded frame must match the source dimensions and constant 16 FPS timestamps");
    return Math.round(t*1e6);
  });
  return {width:v.width as number,height:v.height as number,fps:16 as const,frames:frames.length,timingDigest:createHash("sha256").update(JSON.stringify(pts)).digest("hex"),hasAudio:streams.some((s:any)=>s.codec_type==="audio")};
}
async function assertGrayscale(filename:string,expectedBytes:number,sample?:{vf:string;frames:number},kind:"mask"|"depth control"="mask",regionPixels?:number,coverage?:MaskCoverageBuilder):Promise<void>{
  await new Promise<void>((resolve,reject)=>{
    const outputArgs=sample?["-vf",sample.vf,"-frames:v",String(sample.frames)]:["-fps_mode","passthrough"];
    const child=spawn(process.env.FFMPEG_PATH??"ffmpeg",[...inputOptions,"-nostdin","-xerror","-err_detect","explode",...(sample?[]:["-noautorotate"]),"-i",filename,"-map","0:v:0","-an","-sn","-dn",...outputArgs,"-pix_fmt","rgb24","-f","rawvideo","pipe:1"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let bytes=0,pending=Buffer.alloc(0),error:Error|undefined,stderr=0;
    let framePixels=0,frameIndex=0,protectedRegion=false,editRegion=false;
    const fail=(message:string)=>{error??=new HttpError(422,message);child.kill();};
    const unavailable=(message:string)=>{error??=new MediaProbeUnavailableError(message);child.kill();};
    const timer=setTimeout(()=>unavailable("Mask decoding is temporarily unavailable"),20000);
    child.on("error",()=>unavailable("Mask decoder is temporarily unavailable"));
    (child.stderr as EventEmitter).on("data",(chunk:Buffer)=>{stderr+=chunk.length;if(stderr>8192)fail("Mask decoding reported invalid media");});
    (child.stdout as EventEmitter).on("data",(chunk:Buffer)=>{
      bytes+=chunk.length;if(bytes>expectedBytes){fail("Mask contains unexpected decoded pixels");return;}
      const data=pending.length?Buffer.concat([pending,chunk]):chunk,complete=data.length-data.length%3;
      for(let i=0;i<complete;i+=3){
        if(Math.max(data[i],data[i+1],data[i+2])-Math.min(data[i],data[i+1],data[i+2])>2){fail(kind==="mask"?"Use a grayscale mask: white edits and black preserves":"Use a grayscale preprocessed depth video");break;}
        coverage?.add(data[i]>=128);
        if(regionPixels){
          protectedRegion ||= data[i]<128;editRegion ||= data[i]>=128;
          if(++framePixels===regionPixels){
            frameIndex++;
            if(!protectedRegion||!editRegion){error??=new BackgroundMaskValidationError(!protectedRegion?`No protected subject was found in frame ${frameIndex}. Adjust tracking or upload a corrected mask.`:`No editable background was found in frame ${frameIndex}. Adjust tracking or upload a corrected mask.`);child.kill();break;}
            framePixels=0;protectedRegion=false;editRegion=false;
          }
        }
      }
      pending=Buffer.from(data.subarray(complete));
    });
    child.on("close",code=>{clearTimeout(timer);if(error)reject(error);else if(code!==0||stderr||bytes!==expectedBytes||pending.length)reject(new HttpError(422,"Mask did not decode to the expected frame sequence"));else resolve();});
  });
}
export async function assertGrayscaleDepthControl(filename:string,width:number,height:number,frames:number):Promise<void>{
  await assertGrayscale(filename,width*height*frames*3,undefined,"depth control");
}
export async function inspectMaskCoverage(filename:string,geometry:{width:number;height:number;frames:number},maskSha256:string){
  return withMaskInspection(async()=>{
    const coverage=new MaskCoverageBuilder(geometry.width,geometry.height,geometry.frames);
    await assertGrayscale(filename,geometry.width*geometry.height*geometry.frames*3,undefined,"mask",undefined,coverage);
    if(await fileSha256(filename)!==maskSha256)invalid("Mask changed during its frame scan");
    return coverage.finish(maskSha256);
  });
}
/** Background inversion must never turn a lost subject into a whole-frame edit. */
export async function assertBackgroundMaskRegions(filename:string,width:number,height:number,frames:number):Promise<void>{
  if(![width,height,frames].every(Number.isInteger)||width<1||height<1||width*height>4194304||frames<17||frames>81)invalid("Invalid background mask geometry");
  await assertGrayscale(filename,width*height*frames*3,undefined,"mask",width*height);
}
export type GeneralVideo={width:number;height:number;duration:number;hasAudio:boolean};
function displaySize(v:any):{width:number;height:number}{
  const rotation=Number(v.tags?.rotate??(v.side_data_list??[]).find((s:any)=>s.rotation!==undefined)?.rotation??0);
  return Math.abs(rotation)%180===90?{width:v.height,height:v.width}:{width:v.width,height:v.height};
}
/** Bounded inspection for ordinary camera footage before it is normalized to the VACE envelope. */
export async function inspectGeneralVideo(filename:string):Promise<GeneralVideo>{
  if((await stat(filename)).size>128*1024*1024)invalid("Masked editing accepts files up to 128 MiB");
  const header=await probe(filename,["-show_streams","-show_format"]);
  const streams=header.streams??[],videos=streams.filter((s:any)=>s.codec_type==="video");
  if(videos.length!==1||streams.some((s:any)=>!["video","audio"].includes(s.codec_type)))invalid("Choose a file with one video stream");
  const v=videos[0],display=displaySize(v);
  if(!Number.isInteger(display.width)||!Number.isInteger(display.height)||display.width<16||display.height<16)invalid("Use a video at least 16 pixels wide and high");
  const duration=Number(v.duration??header.format?.duration);
  if(!Number.isFinite(duration)||duration<0.25)invalid("Use a clip of at least a quarter second");
  return {width:display.width,height:display.height,duration,hasAudio:streams.some((s:any)=>s.codec_type==="audio")};
}
export function targetGeometry(width:number,height:number){
  const scale=Math.min(1,832/width,832/height,Math.sqrt(399360/(width*height)));
  return {width:Math.max(16,Math.floor((width*scale)/16)*16),height:Math.max(16,Math.floor((height*scale)/16)*16)};
}
export function targetFrames(seconds:number){
  const rounded=Math.round((Math.min(81,Math.max(17,Math.round(seconds*16)))-1)/4);
  return 4*Math.min(20,Math.max(4,rounded))+1;
}
function fitFilter(width:number,height:number){
  return `fps=16,scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}
/** Resample any clip onto the 16 fps, 4n+1-frame VACE envelope. */
export async function transcodeNormalized(input:string,output:string,width:number,height:number,frames:number,mask:boolean,failure="The uploaded video could not be normalized to the masked-edit envelope"){
  const vf=[fitFilter(width,height),mask?"format=gray":"format=yuv420p",`tpad=stop_mode=clone:stop_duration=${(frames+2)/16}`,`trim=end_frame=${frames}`,"setpts=PTS-STARTPTS"];
  try{
    await execute(process.env.FFMPEG_PATH??"ffmpeg",[...inputOptions,"-nostdin","-y","-i",input,"-map","0:v:0","-an","-sn","-dn","-vf",vf.join(","),"-frames:v",String(frames),"-c:v","libx264","-preset","veryfast","-crf","16","-pix_fmt","yuv420p","-movflags","+faststart",output],{timeout:120000,maxBuffer:2*1024*1024,windowsHide:true});
  }catch{
    invalid(failure);
  }
}
export type NormalizedMaskPair={
  sourcePath:string;maskPath:string;width:number;height:number;frames:number;timingDigest:string;transform:string;cleanup:()=>Promise<void>;
};
/** Accept ordinary constant or variable-frame-rate camera footage by deriving an aligned 16 FPS VACE pair. */
export async function normalizeMaskPair(sourceFile:string,maskFile:string):Promise<NormalizedMaskPair>{
  return withMaskInspection(async()=>{
    const source=await inspectGeneralVideo(sourceFile),mask=await inspectGeneralVideo(maskFile);
    if(mask.hasAudio)invalid("Mask sequences must not contain audio");
    if(source.width!==mask.width||source.height!==mask.height)invalid("Mask dimensions must match the source video");
    if(mask.duration<source.duration-0.15)invalid("Mask must cover the full source duration");
    const {width,height}=targetGeometry(source.width,source.height),frames=targetFrames(source.duration);
    const dir=await mkdtemp(join(tmpdir(),"comfyfield-mask-normalize-"));
    const cleanup=async()=>{await rm(dir,{recursive:true,force:true}).catch(()=>{});};
    try{
      const sourcePath=join(dir,"source-16fps.mp4"),maskPath=join(dir,"mask-16fps.mp4");
      await transcodeNormalized(sourceFile,sourcePath,width,height,frames,false);
      await transcodeNormalized(maskFile,maskPath,width,height,frames,true);
      await assertGrayscale(maskFile,width*height*frames*3,{vf:`${fitFilter(width,height)},tpad=stop_mode=clone:stop_duration=${(frames+2)/16},trim=end_frame=${frames}`,frames});
      const normalizedSource=await inspectMaskVideo(sourcePath),normalizedMask=await inspectMaskVideo(maskPath);
      if(normalizedSource.width!==width||normalizedSource.height!==height||normalizedSource.frames!==frames||normalizedMask.frames!==frames||normalizedMask.timingDigest!==normalizedSource.timingDigest)invalid("Normalized source and mask timing did not align");
      await assertGrayscale(maskPath,width*height*frames*3);
      return {sourcePath,maskPath,width,height,frames,timingDigest:normalizedSource.timingDigest,transform:`fps=16; fit ${width}x${height}; pad black; ${frames} frames; grayscale mask`,cleanup};
    }catch(error){await cleanup();throw error;}
  });
}
export async function validateMaskPair(sourceFile:string,maskFile:string,identity:{sourceAssetId:string;sourceSha256:string;maskSha256:string}):Promise<MaskSequenceSnapshot>{
  return withMaskInspection(async()=>{
    const source=await inspectMaskVideo(sourceFile),mask=await inspectMaskVideo(maskFile);
    if(mask.hasAudio)invalid("Mask sequences must not contain audio");
    if(source.width!==mask.width||source.height!==mask.height||source.frames!==mask.frames||source.timingDigest!==mask.timingDigest)invalid("Mask dimensions, decoded frame count and timestamps must match the source exactly");
    await assertGrayscale(maskFile,mask.width*mask.height*mask.frames*3);
    if(await fileSha256(sourceFile)!==identity.sourceSha256||await fileSha256(maskFile)!==identity.maskSha256)invalid("Media changed during validation; upload it again");
    return {validationVersion:1,...identity,width:source.width,height:source.height,fps:16,frames:source.frames,timingDigest:source.timingDigest,semantics:"white_edits_black_preserves"};
  });
}
export async function verifyMaskedOutput(filename:string,snapshot:MaskSequenceSnapshot){
  const expected=maskSnapshotSchema.parse(snapshot);
  return withMaskInspection(async()=>{
    const actual=await inspectMaskVideo(filename);
    if(actual.hasAudio||actual.width!==expected.width||actual.height!==expected.height||actual.frames!==expected.frames||actual.timingDigest!==expected.timingDigest)invalid("Edited output does not match the validated source timing, dimensions or mute policy");
    return actual;
  });
}
