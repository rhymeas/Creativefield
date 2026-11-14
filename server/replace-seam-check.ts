import {execFile,spawn} from "node:child_process";
import {EventEmitter} from "node:events";
import {promisify} from "node:util";
import {pathToFileURL} from "node:url";
import {rgbDifference} from "./video-frame-inspection";

const execute=promisify(execFile);
/** SCAIL renders 81 frames per pass and carries the last 5 as an anchor, so each later pass adds 76 frames. */
export const SCAIL_CHUNK_FRAMES=81;
export const SCAIL_STEP_FRAMES=76;
/** A seam is judged against six adjacent pairs on each side; three times their median is a visible cut. */
export const SEAM_NEIGHBOURS=12;
export const SEAM_SUSPICIOUS_RATIO=3;
const SAMPLE_WIDTH=256,FFMPEG_TIMEOUT_MS=120000;

export type ReplaceSeam={
  /** The frame the seam enters: the pair from-1 to frame is measured. */
  frame:number;from:number;to:number;
  meanAbsoluteRgb8:number;maxChannelDelta8:number;
  /** Median difference of the twelve neighbouring pairs, the local motion baseline. */
  localMedianMeanAbsoluteRgb8:number;
  /** Seam difference divided by that median, or null when the neighbours do not move at all. */
  ratio:number|null;suspicious:boolean;
};
export type ReplaceSeamSample={width:number;height:number};
export type ReplaceSeamReport={
  frames:number;
  /** The decoded sample size, or null when only synthetic frames were measured. */
  sample:ReplaceSeamSample|null;
  seams:ReplaceSeam[];
  suspiciousFrames:number[];
};
export type ReplaceSeamOptions={
  chunkFrames?:number;stepFrames?:number;
  sample?:ReplaceSeamSample;
};
type FrameDifference={from:number;to:number;meanAbsoluteRgb8:number;maxChannelDelta8:number};

/** Frame 81 joins chunk one and two, then 157, 233, and so on up to the frame count. */
export function seamFrameIndices(frames:number,chunkFrames=SCAIL_CHUNK_FRAMES,stepFrames=SCAIL_STEP_FRAMES):number[]{
  if(!Number.isInteger(frames)||frames<1||!Number.isInteger(chunkFrames)||chunkFrames<2||!Number.isInteger(stepFrames)||stepFrames<1)
    throw new Error("A whole frame count and a positive chunk stride are required");
  const indices:number[]=[];
  for(let frame=chunkFrames;frame<frames;frame+=stepFrames)indices.push(frame);
  return indices;
}

function median(values:readonly number[]){
  if(!values.length)return 0;
  const sorted=[...values].sort((a,b)=>a-b),middle=sorted.length>>1;
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
}

function analyseDifferences(frames:number,differences:readonly FrameDifference[],options:ReplaceSeamOptions):ReplaceSeamReport{
  const side=SEAM_NEIGHBOURS/2;
  const seams=seamFrameIndices(frames,options.chunkFrames,options.stepFrames).map(frame=>{
    const difference=differences[frame-1];
    if(!difference)throw new Error("A seam lies outside the decoded frames");
    const neighbours:number[]=[];
    for(let offset=-side;offset<=side;offset++){
      const index=frame-1+offset;
      if(!offset||index<0||index>=differences.length)continue;
      neighbours.push(differences[index].meanAbsoluteRgb8);
    }
    const localMedian=median(neighbours);
    return {frame,from:difference.from,to:difference.to,meanAbsoluteRgb8:difference.meanAbsoluteRgb8,maxChannelDelta8:difference.maxChannelDelta8,
      localMedianMeanAbsoluteRgb8:localMedian,
      ratio:localMedian>0?Math.round(difference.meanAbsoluteRgb8/localMedian*100)/100:null,
      suspicious:difference.meanAbsoluteRgb8>SEAM_SUSPICIOUS_RATIO*localMedian};
  });
  return {frames,sample:options.sample??null,seams,suspiciousFrames:seams.filter(seam=>seam.suspicious).map(seam=>seam.frame)};
}

/** Measure every chunk seam in decoded RGB frames, one flat colour buffer per frame. */
export function analyseReplaceSeams(frames:readonly Buffer[],options:ReplaceSeamOptions={}):ReplaceSeamReport{
  if(frames.length<2)throw new Error("At least two decoded frames are needed");
  const differences=frames.slice(1).map((frame,index)=>({from:index,to:index+1,...rgbDifference(frames[index],frame)}));
  return analyseDifferences(frames.length,differences,options);
}

async function probeVideoSize(filename:string):Promise<{width:number;height:number}>{
  let stdout:string;
  try{
    stdout=String((await execute(process.env.FFPROBE_PATH??"ffprobe",["-v","error","-protocol_whitelist","file,pipe","-select_streams","v:0","-show_entries","stream=width,height","-of","json",filename],{timeout:30000,maxBuffer:1024*1024,windowsHide:true})).stdout);
  }catch{throw new Error("The seam check could not read this video with the installed FFprobe");}
  let stream:{width?:unknown;height?:unknown}|undefined;
  try{stream=(JSON.parse(stdout) as {streams?:Array<{width?:unknown;height?:unknown}>}).streams?.[0];}catch{throw new Error("The seam check could not read this video's frame size");}
  const width=Number(stream?.width),height=Number(stream?.height);
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2)throw new Error("The seam check needs a video with a readable frame size");
  return {width,height};
}

/** Decode the whole file at 256 px wide, keeping only the previous frame so a long clip stays cheap. */
async function decodeDifferences(filename:string):Promise<{frames:number;sample:ReplaceSeamSample;differences:FrameDifference[]}>{
  const size=await probeVideoSize(filename),width=SAMPLE_WIDTH,height=Math.max(2,2*Math.round(width*size.height/size.width/2)),stride=width*height*3;
  return new Promise((resolve,reject)=>{
    const child=spawn(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-protocol_whitelist","file,pipe","-i",filename,"-map","0:v:0","-vf",`scale=${width}:${height}:flags=area`,"-fps_mode","passthrough","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    const differences:FrameDifference[]=[];let pending=Buffer.alloc(0),previous:Buffer|undefined,frames=0,stderr="",failure:string|undefined;
    const stop=(message:string)=>{failure??=message;child.kill();};
    const timer=setTimeout(()=>stop("The seam check timed out while decoding this video"),FFMPEG_TIMEOUT_MS);
    child.on("error",()=>{clearTimeout(timer);reject(new Error("The seam check could not run FFmpeg"));});
    (child.stderr as EventEmitter).on("data",(chunk:Buffer)=>{if(stderr.length<4096)stderr+=chunk.toString();});
    (child.stdout as EventEmitter).on("data",(chunk:Buffer)=>{
      if(failure)return;
      pending=pending.length?Buffer.concat([pending,chunk]):chunk;
      while(pending.length>=stride){
        const frame=Buffer.from(pending.subarray(0,stride));pending=pending.subarray(stride);
        if(previous)differences.push({from:frames-1,to:frames,...rgbDifference(previous,frame)});
        previous=frame;frames++;
      }
    });
    child.on("close",code=>{
      clearTimeout(timer);
      if(failure)return reject(new Error(failure));
      if(code!==0)return reject(new Error(`The seam check could not decode this video with the installed FFmpeg${stderr?`: ${stderr.trim().slice(0,200)}`:""}`));
      if(pending.length)return reject(new Error("Decoded frame samples do not fill whole frames"));
      if(frames<2)return reject(new Error("The seam check needs at least two decoded frames"));
      resolve({frames,sample:{width,height},differences});
    });
  });
}

/** Decode a finished Replace character render and report every seam between its chunks. */
export async function inspectReplaceSeams(filename:string,options:Omit<ReplaceSeamOptions,"sample">={}):Promise<ReplaceSeamReport>{
  const decoded=await decodeDifferences(filename);
  return analyseDifferences(decoded.frames,decoded.differences,{...options,sample:decoded.sample});
}

// `npx tsx server/replace-seam-check.ts <video>` prints the report and exits 1 on a suspicious seam.
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const file=process.argv[2];
  if(!file){console.error("Usage: tsx server/replace-seam-check.ts <video>");process.exitCode=2;}
  else{
    const report=await inspectReplaceSeams(file);
    console.log(JSON.stringify(report,null,2));
    if(report.suspiciousFrames.length)process.exitCode=1;
  }
}
