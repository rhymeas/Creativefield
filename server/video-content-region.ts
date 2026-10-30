import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {VideoExtensionMediaError,VideoExtensionToolUnavailableError} from "./video-extension-media";

const execute=promisify(execFile);
/** Eight samples per second, at most 120: enough to average a fading overlay away from the picture. */
const SAMPLE_FPS=8,MAX_SAMPLES=120;
/** The variance check runs on a small grey copy; 240 px wide keeps a border within a source pixel or two. */
const ANALYSIS_WIDTH=240;
const MAX_LOG_BYTES=8*1024*1024,MAX_RAW_BYTES=64*1024*1024;
/** A pixel that changes less than this across the samples is background or still app chrome. */
const VARIANCE_FLOOR=24;
/** A row or column belongs to the picture when at least a fiftieth of it changes. */
const BAND_COVERAGE=0.02;
/** ...and that change reaches across at least a fifth of it, so a thin moving rail is ignored. */
const BAND_SPAN=0.2;
/** A rectangle needs a sixth of its pixels changing, or it is a scattering of overlays rather than a picture. */
const RECT_COVERAGE=0.15;
/** A rail or caption thinner than this share of the frame is app chrome, not the picture. */
const MIN_BAND_FRACTION=0.12;
/** A single jump smaller than this is texture, not the straight border of the picture. */
const EDGE_LEVEL=12;
/** How far a border may move to sit on a strong straight edge in the mean frame. */
const EDGE_SEARCH=0.02;
/** A rectangle under thirty percent of the frame is not worth a crop. */
export const MIN_CONTENT_FRACTION=0.3;
/** A rectangle that already covers almost the whole frame leaves too little to be worth a crop. */
const FULL_FRAME_FRACTION=0.85;
const STANDARD_ASPECTS=[["16:9",16/9],["4:3",4/3],["1:1",1],["4:5",4/5],["9:16",9/16]] as const;

export type FrameSize={width:number;height:number};
export type ContentRegion={x:number;y:number;width:number;height:number};
export type SnappedRegion=ContentRegion&{aspect:string};
/** A snapped region plus the whole frame it was found in; an overlay mask is measured against it. */
export type CleanRegion=SnappedRegion&{frame:FrameSize};
type ProbeStream={width?:number;height?:number;tags?:{rotate?:string};side_data_list?:Array<{rotation?:number}>};
export type VarianceField={width:number;height:number;variance:Float64Array;mean:Float64Array};
type FoundRegion={region:ContentRegion;frame:FrameSize};
type Band={start:number;end:number};
type Candidate={left:number;top:number;right:number;bottom:number;score:number};

function command(kind:"ffmpeg"|"ffprobe"){return kind==="ffmpeg"?(process.env.FFMPEG_PATH??"ffmpeg"):(process.env.FFPROBE_PATH??"ffprobe");}
function clamp(value:number,min:number,max:number){return Math.min(max,Math.max(min,value));}

/** Run one tool and keep its output as bytes; the variance pass reads raw frames. */
async function run(kind:"ffmpeg"|"ffprobe",args:string[],options:{signal?:AbortSignal;maxBuffer?:number}={}){
  try{
    return await execute(command(kind),args,{windowsHide:true,encoding:"buffer",timeout:30000,maxBuffer:options.maxBuffer??MAX_LOG_BYTES,signal:options.signal}) as unknown as {stdout:Buffer;stderr:Buffer};
  }catch(error){
    const failure=error as NodeJS.ErrnoException&{killed?:boolean;signal?:string};
    if(failure.code==="ENOENT"||failure.code==="EACCES")throw new VideoExtensionToolUnavailableError(`${kind} is unavailable`);
    if(failure.killed||failure.signal)throw new VideoExtensionToolUnavailableError(`${kind} did not complete`);
    throw new VideoExtensionMediaError(`${kind} rejected the media`);
  }
}

/** Display size after autorotation, because the crop filter works on rotated frames. */
async function displaySize(filename:string,signal?:AbortSignal):Promise<FrameSize>{
  const probe=await run("ffprobe",["-v","error","-select_streams","v:0","-show_streams","-of","json",filename],{signal});
  let stream:ProbeStream;
  try{stream=((JSON.parse(String(probe.stdout)) as {streams?:ProbeStream[]}).streams??[])[0]??{};}catch{throw new VideoExtensionMediaError("FFprobe returned invalid JSON");}
  const width=Number(stream.width),height=Number(stream.height);
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<2||height<2)throw new VideoExtensionMediaError("Video size is unreadable");
  const rotation=Number(stream.tags?.rotate??stream.side_data_list?.find(item=>item.rotation!==undefined)?.rotation??0);
  return rotation%180===0?{width,height}:{width:height,height:width};
}

/**
 * Per-pixel variance over many samples, plus the mean frame used to find the picture's
 * straight border. A scrolling caption or a fading toast changes only a thin band; the
 * picture changes across a large rectangle, which is what the next step looks for.
 */
export async function frameVariance(filename:string,frame:FrameSize,signal?:AbortSignal,width=ANALYSIS_WIDTH):Promise<VarianceField|null>{
  const scaled=Math.min(width,frame.width),height=Math.max(2,Math.round(frame.height*scaled/frame.width/2)*2);
  const filter=`scale=${scaled}:${height}:flags=area,format=gray`;
  const samples=await run("ffmpeg",["-hide_banner","-nostdin","-loglevel","error","-i",filename,"-an","-vf",`fps=${SAMPLE_FPS},${filter}`,
    "-frames:v",String(MAX_SAMPLES),"-f","rawvideo","pipe:1"],{signal,maxBuffer:MAX_RAW_BYTES});
  const size=scaled*height,count=Math.floor(samples.stdout.length/size);
  if(count<2)return null;
  const sums=new Float64Array(size),sums2=new Float64Array(size);
  for(let index=0;index<count;index++){
    const offset=index*size;
    for(let pixel=0;pixel<size;pixel++){
      const value=samples.stdout[offset+pixel];
      sums[pixel]+=value;sums2[pixel]+=value*value;
    }
  }
  const variance=new Float64Array(size),mean=new Float64Array(size);
  for(let pixel=0;pixel<size;pixel++){
    const average=sums[pixel]/count;
    mean[pixel]=average;variance[pixel]=Math.max(0,sums2[pixel]/count-average*average);
  }
  return {width:scaled,height,variance,mean};
}

/** Runs where the profile clears the minimum; `end` is exclusive. Tiny gaps are bridged so a static stripe inside the picture does not split it. */
function bands(profile:Float64Array,minimum:number,maxGap:number){
  const runs:Band[]=[],found:Band[]=[];
  let start=-1;
  for(let index=0;index<=profile.length;index++){
    const active=index<profile.length&&profile[index]>=minimum;
    if(active&&start<0)start=index;
    if(!active&&start>=0){runs.push({start,end:index});start=-1;}
  }
  for(const run of runs){
    const last=found[found.length-1];
    if(last&&run.start-last.end<=maxGap)last.end=run.end;
    else found.push({...run});
  }
  return found;
}

function rowCoverage(field:VarianceField,left:number,right:number,threshold:number){
  const profile=new Float64Array(field.height);
  for(let y=0;y<field.height;y++){
    let changing=0,first=-1,last=-1;
    for(let x=left;x<right;x++)if(field.variance[y*field.width+x]>=threshold){changing++;if(first<0)first=x;last=x;}
    const coverage=changing/(right-left),span=changing?(last-first+1)/(right-left):0;
    profile[y]=coverage>=BAND_COVERAGE&&span>=BAND_SPAN?coverage:0;
  }
  return profile;
}

function columnCoverage(field:VarianceField,top:number,bottom:number,threshold:number){
  const profile=new Float64Array(field.width);
  for(let x=0;x<field.width;x++){
    let changing=0,first=-1,last=-1;
    for(let y=top;y<bottom;y++)if(field.variance[y*field.width+x]>=threshold){changing++;if(first<0)first=y;last=y;}
    const coverage=changing/(bottom-top),span=changing?(last-first+1)/(bottom-top):0;
    profile[x]=coverage>=BAND_COVERAGE&&span>=BAND_SPAN?coverage:0;
  }
  return profile;
}

function rectCoverage(field:VarianceField,left:number,top:number,right:number,bottom:number,threshold:number){
  let changing=0;
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)if(field.variance[y*field.width+x]>=threshold)changing++;
  return changing/((right-left)*(bottom-top));
}

/** Mean jump and how much of the border jumps at once; a straight picture edge is both high and wide. */
function horizontalEdge(field:VarianceField,row:number,left:number,right:number){
  let total=0,strong=0;
  for(let x=left;x<right;x++){
    const delta=Math.abs(field.mean[row*field.width+x]-field.mean[(row-1)*field.width+x]);
    total+=delta;if(delta>=EDGE_LEVEL)strong++;
  }
  return {mean:total/(right-left),straight:strong/(right-left)};
}

/** Mean jump and how much of the border jumps at once; a straight picture edge is both high and wide. */
function verticalEdge(field:VarianceField,column:number,top:number,bottom:number){
  let total=0,strong=0;
  for(let y=top;y<bottom;y++){
    const delta=Math.abs(field.mean[y*field.width+column]-field.mean[y*field.width+column-1]);
    total+=delta;if(delta>=EDGE_LEVEL)strong++;
  }
  return {mean:total/(bottom-top),straight:strong/(bottom-top)};
}

function snapRow(field:VarianceField,row:number,left:number,right:number,range:number){
  if(row<=0||row>=field.height)return row;
  let best=row,bestScore=-1;
  for(let candidate=Math.max(1,row-range);candidate<=Math.min(field.height-1,row+range);candidate++){
    const edge=horizontalEdge(field,candidate,left,right);
    if(edge.straight<0.5)continue;
    if(edge.mean>bestScore){bestScore=edge.mean;best=candidate;}
  }
  return best;
}

function snapColumn(field:VarianceField,column:number,top:number,bottom:number,range:number){
  if(column<=0||column>=field.width)return column;
  let best=column,bestScore=-1;
  for(let candidate=Math.max(1,column-range);candidate<=Math.min(field.width-1,column+range);candidate++){
    const edge=verticalEdge(field,candidate,top,bottom);
    if(edge.straight<0.5)continue;
    if(edge.mean>bestScore){bestScore=edge.mean;best=candidate;}
  }
  return best;
}

/** How much of the rectangle's border sits on a strong straight edge in the mean frame. */
function edgeScore(field:VarianceField,left:number,top:number,right:number,bottom:number){
  let total=0,count=0;
  if(top>0){total+=horizontalEdge(field,top,left,right).mean;count++;}
  if(bottom<field.height){total+=horizontalEdge(field,bottom,left,right).mean;count++;}
  if(left>0){total+=verticalEdge(field,left,top,bottom).mean;count++;}
  if(right<field.width){total+=verticalEdge(field,right,top,bottom).mean;count++;}
  return count?total/count:0;
}

/**
 * Find the rectangle that keeps changing while the bands around it stand still: the real
 * picture inside a screen recording, without status bar, search box or comment rail.
 * Animated overlays that sit on the picture stay inside it. Region size is not changed
 * here; snapContentRegion fits a standard aspect afterwards.
 */
export async function detectContentRegion(filename:string,signal?:AbortSignal):Promise<FoundRegion|null>{
  const frame=await displaySize(filename,signal),field=await frameVariance(filename,frame,signal);
  if(!field)return null;
  const minHeight=Math.max(2,Math.round(field.height*MIN_BAND_FRACTION)),minWidth=Math.max(2,Math.round(field.width*MIN_BAND_FRACTION));
  const rowRange=Math.max(1,Math.round(field.height*EDGE_SEARCH)),columnRange=Math.max(1,Math.round(field.width*EDGE_SEARCH));
  let best:Candidate|null=null;
  for(const rowBand of bands(rowCoverage(field,0,field.width,VARIANCE_FLOOR),BAND_COVERAGE,rowRange)){
    if(rowBand.end-rowBand.start<minHeight)continue;
    for(const columnBand of bands(columnCoverage(field,rowBand.start,rowBand.end,VARIANCE_FLOOR),BAND_COVERAGE,columnRange)){
      if(columnBand.end-columnBand.start<minWidth)continue;
      let left=columnBand.start,right=columnBand.end,top=rowBand.start,bottom=rowBand.end;
      if(rectCoverage(field,left,top,right,bottom,VARIANCE_FLOOR)<RECT_COVERAGE)continue;
      // The border of the picture is a strong straight edge; pull a ragged band onto it.
      top=snapRow(field,top,left,right,rowRange);bottom=snapRow(field,bottom,left,right,rowRange);
      left=snapColumn(field,left,top,bottom,columnRange);right=snapColumn(field,right,top,bottom,columnRange);
      // A static stripe inside a full-width picture is not app chrome; keep the frame edge.
      if(left>0&&left<=columnRange&&verticalEdge(field,left,top,bottom).straight<0.5)left=0;
      if(right<field.width&&field.width-right<=columnRange&&verticalEdge(field,right,top,bottom).straight<0.5)right=field.width;
      if(top>0&&top<=rowRange&&horizontalEdge(field,top,left,right).straight<0.5)top=0;
      if(bottom<field.height&&field.height-bottom<=rowRange&&horizontalEdge(field,bottom,left,right).straight<0.5)bottom=field.height;
      if(left>=right||top>=bottom||right-left<minWidth||bottom-top<minHeight)continue;
      const area=(right-left)*(bottom-top),score=area*(1+Math.min(1,edgeScore(field,left,top,right,bottom)/64)*0.25);
      if(!best||score>best.score)best={left,top,right,bottom,score};
    }
  }
  if(!best)return null;
  // Edges are rounded outwards so a few pixels of band are kept rather than cutting the picture.
  const scaleX=field.width/frame.width,scaleY=field.height/frame.height;
  const x=clamp(Math.floor(best.left/scaleX),0,frame.width-2),y=clamp(Math.floor(best.top/scaleY),0,frame.height-2);
  const region={x,y,width:clamp(Math.ceil(best.right/scaleX)-x,2,frame.width-x),height:clamp(Math.ceil(best.bottom/scaleY)-y,2,frame.height-y)};
  const fraction=region.width*region.height/(frame.width*frame.height);
  if(region.width<16||region.height<16||region.width<frame.width*MIN_BAND_FRACTION||region.height<frame.height*MIN_BAND_FRACTION)return null;
  if(fraction<MIN_CONTENT_FRACTION||fraction>=FULL_FRAME_FRACTION)return null;
  return {region,frame};
}

/**
 * Fit the region to the nearest standard aspect by removing the smallest possible extra
 * strip, centred. Nothing is ever stretched: both sides only shrink from the region.
 */
export function snapContentRegion(region:ContentRegion,frame:FrameSize):SnappedRegion{
  const width=clamp(Math.round(region.width),2,frame.width),height=clamp(Math.round(region.height),2,frame.height);
  let best:{aspect:string;width:number;height:number;removed:number}|null=null;
  for(const [aspect,ratio] of STANDARD_ASPECTS){
    const fitted=width/height>ratio
      ?{width:Math.max(2,Math.min(width,Math.round(height*ratio))),height}
      :{width,height:Math.max(2,Math.min(height,Math.round(width/ratio)))};
    const removed=1-(fitted.width*fitted.height)/(width*height);
    if(!best||removed<best.removed-1e-9)best={aspect,...fitted,removed};
  }
  // Chroma is subsampled, so ffmpeg needs even offsets and even sizes.
  const even=(value:number)=>Math.max(2,Math.floor(value/2)*2);
  const snappedWidth=Math.min(width,even(best!.width)),snappedHeight=Math.min(height,even(best!.height));
  const place=(origin:number,total:number,size:number,limit:number)=>Math.max(0,Math.min(limit,Math.floor(Math.round(origin+(total-size)/2)/2)*2));
  return {x:place(region.x,width,snappedWidth,frame.width-snappedWidth),y:place(region.y,height,snappedHeight,frame.height-snappedHeight),width:snappedWidth,height:snappedHeight,aspect:best!.aspect};
}

/** Detect the picture and fit it to a standard aspect in one step; null means "leave the clip alone". */
export async function findCleanRegion(filename:string,signal?:AbortSignal):Promise<CleanRegion|null>{
  const found=await detectContentRegion(filename,signal);
  return found?{...snapContentRegion(found.region,found.frame),frame:found.frame}:null;
}
