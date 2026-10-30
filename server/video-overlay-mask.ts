/* Overlays that sit ON the picture: the like/comment/share column with its counts, the avatar and
   its badge, the caption line, the music ticker. The clean crop keeps the picture and drops the app
   around it, so these pixels are still in the clip when it reaches a tool. This module finds them -
   they stay still while the picture moves, and they look like UI, a bright flat glyph, a hard text
   stroke, or a coloured patch whose colour never changes - writes the mask, and takes them out with
   one local video inpaint (Wan VACE, pack native-workflows/overlay-inpaint) before any tool runs,
   with a second pass on what the first one leaves behind. See docs/TRANSFORM-VIDEO.md, "Overlays on
   the picture". */

import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {openAsBlob} from "node:fs";
import {mkdir,readFile,rename,rm,stat,writeFile} from "node:fs/promises";
import path from "node:path";
import {VideoExtensionMediaError,VideoExtensionToolUnavailableError} from "./video-extension-media";

const execute=promisify(execFile);

/** A glyph is a few pixels across, so the still-pixel pass reads the clip wider than the region finder does. */
const OVERLAY_ANALYSIS_WIDTH=480;
/** Eight samples a second, at most a hundred: enough to average a moving picture away from app chrome. */
const SAMPLE_FPS=8,MAX_SAMPLES=100;
/** A pixel that changes less than this while the picture moves is background or app chrome. */
const STILL_VARIANCE=18;
/** A pixel whose colour holds still in a coloured patch is a badge or an avatar, not the wall behind
 *  it: brightness alone misses a mid-tone pink "+" and a photo behind a ring. Such a patch only counts
 *  against a UI mark, because a flat wall is still and coloured too. */
const COLOUR_VARIANCE=16,COLOUR_SPREAD=45,NEAR_MARK=6;
/** A UI glyph or label is bright, or its stroke is a hard edge against what is behind it. */
const BRIGHT_MEAN=168,STROKE_EDGE=38;
/** The picture has to move for "it did not move" to mean anything. */
const MOVE_SHARE=0.35;
/** Glyph-sized marks, grouped into the column or the caption line they form. A group bigger than this
 *  share of the frame is a wall or a bright thing in the picture, not a row of app icons. */
const BLOB_MIN=2,CLUSTER_GAP=12,SOLID_SHARE=0.85,CLUSTER_AREA_SHARE=0.08;
/** A solid mark bigger than this is a bright thing in the picture, not an icon on it. */
const SOLID_AREA_SHARE=0.02;
/** A kept box is painted whole and grown by this many analysis pixels, so the flat field inside a
 *  badge and the soft edge of an icon go with the glyphs that found it. */
const GROW=5;
/** Two boxes in one column may be this far apart, as a share of the frame's height, and still be one
 *  rectangle: the like/comment/share column is several blobs a few rows apart. Neither box may be
 *  wider than this share of the frame, so a caption line never joins a column. */
const COLUMN_GAP=0.15,COLUMN_WIDTH=0.3;
/** The colour a removed region is filled with is read from a ring this many analysis pixels wide. */
const RING=14;
/** The mask is grown by this many analysis pixels so no halo of the icon is left behind. */
const DILATE=2;
/** A caption line is not still - its words change - but it keeps its rows and its strokes. A caption
 *  is thin strokes on a background, so a band that is mostly strokes is texture in the picture. */
const CAPTION_FLOOR=0.04,CAPTION_BASELINE=3,CAPTION_MAX_SHARE=0.15,CAPTION_HEIGHT=0.16,CAPTION_SPAN=0.3,CAPTION_MARGIN=0.02;
/** Less than this share is a speck; more than the upper bound is the picture, not an overlay. */
export const OVERLAY_MIN_COVERAGE=0.004,OVERLAY_MAX_COVERAGE=0.2;
/** Wan VACE takes a bounded window: this many frames per run, at most this many runs per clip. */
export const OVERLAY_WINDOW=81,OVERLAY_MAX_WINDOWS=8;
/** One prepare makes at most this many inpaint passes; a window that needs a second pass uses two. */
const PASSES_PER_CALL=2;
/** The picture the inpaint works on: sides divisible by 16, about a quarter of a megapixel. */
const VACE_PIXELS=260000,VACE_MAX_SIDE=832,WAN_STEP=4;
/** How hard the hint behind an overlay is smoothed before the inpaint sees it. */
const HINT_BLUR=14;
/** How soft the edge of the paint is, so the wall it was filled with meets the picture without a seam. */
const EDGE_BLUR=2;
const PACK_TEMPLATE=new URL("../native-workflows/overlay-inpaint/template.api.json",import.meta.url);
/** The prompt a removal runs on when no scene colour was measured; the pack's default is the same sentence. */
export const OVERLAY_PROMPT="Empty background that matches the scene.";
const PROMPT_DEFAULT="Empty background that matches the scene.";
const JOB_TIMEOUT_MS=8*60*1000,UPLOAD_TIMEOUT_MS=120000,POLL_MS=1500;
const MAX_LOG_BYTES=8*1024*1024,MAX_RAW_BYTES=64*1024*1024;

export type OverlayBox={x:number;y:number;width:number;height:number};
/** The colour of the picture right around an overlay: what the inpaint is asked to paint there. */
export type OverlayScene={colour:string;red:number;green:number;blue:number};
/** A still overlay found in one clip: a 0/1 mask at the clip's own size, where it sits, and the
 *  colour of the picture around it. */
export type OverlayMask={width:number;height:number;pixels:Uint8Array;coverage:number;regions:OverlayBox[];scene:OverlayScene};
/** The local ComfyUI a removal runs on. */
export type OverlayWorker={origin:string;api_prefix?:string};
export type OverlayRemoval=
  |{state:"removed";list:string;windows:string[];frames:number;mask:OverlayMask}
  |{state:"none";done:number;total:number;mask?:undefined}
  |{state:"unavailable"|"incomplete";done:number;total:number;mask?:OverlayMask};
type Component={pixels:number;left:number;top:number;right:number;bottom:number;marked:number[]};
type Cluster={left:number;top:number;right:number;bottom:number;pixels:number;components:number[]};
type Box={left:number;top:number;right:number;bottom:number};
/** How much every pixel of the clip moved and what colour it held while it did. */
type OverlayField={width:number;height:number;variance:Float64Array;mean:Float64Array;stillColour:Uint8Array;spread:Uint8Array;red:Uint8Array;green:Uint8Array;blue:Uint8Array};

function command(kind:"ffmpeg"|"ffprobe"){return kind==="ffmpeg"?(process.env.FFMPEG_PATH??"ffmpeg"):(process.env.FFPROBE_PATH??"ffprobe");}
function clamp(value:number,min:number,max:number){return Math.min(max,Math.max(min,value));}
function delay(ms:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{signal.removeEventListener("abort",stop);resolve();},ms);const stop=()=>{clearTimeout(timer);reject(signal.reason??new Error("aborted"));};signal.addEventListener("abort",stop,{once:true});});}

/** Run one tool and keep its output as bytes; the variance pass reads raw frames. */
async function run(kind:"ffmpeg"|"ffprobe",args:string[],signal?:AbortSignal){
  try{
    return await execute(command(kind),args,{windowsHide:true,encoding:"buffer",timeout:120000,maxBuffer:MAX_RAW_BYTES,signal}) as unknown as {stdout:Buffer;stderr:Buffer};
  }catch(error){
    const failure=error as NodeJS.ErrnoException&{killed?:boolean;signal?:string};
    if(failure.code==="ENOENT"||failure.code==="EACCES")throw new VideoExtensionToolUnavailableError(`${kind} is unavailable`);
    if(failure.killed||failure.signal)throw new VideoExtensionToolUnavailableError(`${kind} did not complete`);
    throw new VideoExtensionMediaError(`${kind} rejected the media`);
  }
}

/** The size of a clip the server already made: no rotation left to undo, square pixels. */
async function frameSize(filename:string,signal?:AbortSignal){
  const probe=await run("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","json",filename],signal);
  let stream:{width?:number;height?:number};
  try{stream=((JSON.parse(String(probe.stdout)) as {streams?:Array<{width?:number;height?:number}>}).streams??[])[0]??{};}catch{throw new VideoExtensionMediaError("FFprobe returned invalid JSON");}
  const width=Number(stream.width),height=Number(stream.height);
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<2||height<2)throw new VideoExtensionMediaError("Video size is unreadable");
  return {width,height};
}

/**
 * Luma and colour across the clip: how much each pixel moves, the colour it holds, and the mean frame
 * the fill colour is read from. All three channels are sampled because a badge or an avatar can stand
 * still while its brightness says nothing about it.
 */
async function overlayField(filename:string,frame:{width:number;height:number},signal?:AbortSignal):Promise<OverlayField|null>{
  const width=Math.min(OVERLAY_ANALYSIS_WIDTH,frame.width),height=Math.max(2,Math.round(frame.height*width/frame.width/2)*2);
  const samples=await run("ffmpeg",["-hide_banner","-nostdin","-loglevel","error","-i",filename,"-an","-vf",
    `fps=${SAMPLE_FPS},scale=${width}:${height}:flags=area,format=rgb24`,"-frames:v",String(MAX_SAMPLES),"-f","rawvideo","pipe:1"],signal);
  const size=width*height,count=Math.floor(samples.stdout.length/(size*3));
  if(count<2)return null;
  const sums=new Float64Array(size*3),squares=new Float64Array(size*3),luma=new Float64Array(size),lumaSquare=new Float64Array(size);
  for(let index=0;index<count;index++){
    const offset=index*size*3;
    for(let pixel=0;pixel<size;pixel++){
      const at=offset+pixel*3,red=samples.stdout[at],green=samples.stdout[at+1],blue=samples.stdout[at+2];
      sums[pixel*3]+=red;sums[pixel*3+1]+=green;sums[pixel*3+2]+=blue;
      squares[pixel*3]+=red*red;squares[pixel*3+1]+=green*green;squares[pixel*3+2]+=blue*blue;
      const value=0.299*red+0.587*green+0.114*blue;
      luma[pixel]+=value;lumaSquare[pixel]+=value*value;
    }
  }
  const mean=new Float64Array(size),variance=new Float64Array(size),stillColour=new Uint8Array(size),spread=new Uint8Array(size),
    red=new Uint8Array(size),green=new Uint8Array(size),blue=new Uint8Array(size);
  for(let pixel=0;pixel<size;pixel++){
    const average=luma[pixel]/count;
    mean[pixel]=average;variance[pixel]=Math.max(0,lumaSquare[pixel]/count-average*average);
    const r=sums[pixel*3]/count,g=sums[pixel*3+1]/count,b=sums[pixel*3+2]/count;
    red[pixel]=Math.round(r);green[pixel]=Math.round(g);blue[pixel]=Math.round(b);
    spread[pixel]=Math.round(Math.max(r,g,b)-Math.min(r,g,b));
    const vr=Math.max(0,squares[pixel*3]/count-r*r),vg=Math.max(0,squares[pixel*3+1]/count-g*g),vb=Math.max(0,squares[pixel*3+2]/count-b*b);
    stillColour[pixel]=Math.max(vr,vg,vb)<COLOUR_VARIANCE?1:0;
  }
  return {width,height,variance,mean,stillColour,spread,red,green,blue};
}

/** Marks that touch, grouped into the column or the caption line they form. */
function components(flags:Uint8Array,width:number,height:number):Component[]{
  const seen=new Uint8Array(flags.length),stack=new Int32Array(flags.length),found:Component[]=[];
  for(let start=0;start<flags.length;start++){
    if(!flags[start]||seen[start])continue;
    const component:Component={pixels:0,left:width,top:height,right:-1,bottom:-1,marked:[]};
    let depth=0;stack[depth++]=start;seen[start]=1;
    while(depth){
      const pixel=stack[--depth],x=pixel%width,y=(pixel-x)/width;
      component.pixels++;component.marked.push(pixel);
      if(x<component.left)component.left=x;if(x>component.right)component.right=x;
      if(y<component.top)component.top=y;if(y>component.bottom)component.bottom=y;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const nx=x+dx,ny=y+dy;
        if(nx<0||ny<0||nx>=width||ny>=height)continue;
        const next=ny*width+nx;
        if(flags[next]&&!seen[next]){seen[next]=1;stack[depth++]=next;}
      }
    }
    found.push(component);
  }
  return found;
}

/** Group glyph-sized marks whose boxes nearly touch; a like column and a caption line each become one. */function clusters(members:Component[]){
  const parent=members.map((_,index)=>index);
  const root=(index:number):number=>{while(parent[index]!==index){parent[index]=parent[parent[index]];index=parent[index];}return index;};
  for(let a=0;a<members.length;a++)for(let b=a+1;b<members.length;b++){
    const one=members[a],two=members[b];
    if(one.left-CLUSTER_GAP>two.right||two.left-CLUSTER_GAP>one.right)continue;
    if(one.top-CLUSTER_GAP>two.bottom||two.top-CLUSTER_GAP>one.bottom)continue;
    const first=root(a),second=root(b);
    if(first!==second)parent[second]=first;
  }
  const byRoot=new Map<number,Cluster>();
  members.forEach((component,index)=>{
    const key=root(index);
    const found=byRoot.get(key);
    if(!found)byRoot.set(key,{left:component.left,top:component.top,right:component.right,bottom:component.bottom,pixels:component.pixels,components:[index]});
    else{
      found.left=Math.min(found.left,component.left);found.top=Math.min(found.top,component.top);
      found.right=Math.max(found.right,component.right);found.bottom=Math.max(found.bottom,component.bottom);
      found.pixels+=component.pixels;found.components.push(index);
    }
  });
  return [...byRoot.values()];
}

/**
 * Boxes that stack in one column become one rectangle. The like/comment/share column is several
 * blobs a few rows apart, and a rectangle over the whole column leaves no row for a badge to
 * survive in; a caption beside it is wide, so it never joins.
 */
function columns(boxes:Box[],width:number,height:number){
  const gap=Math.round(height*COLUMN_GAP),parent=boxes.map((_,index)=>index);
  const root=(index:number):number=>{while(parent[index]!==index){parent[index]=parent[parent[index]];index=parent[index];}return index;};
  for(let a=0;a<boxes.length;a++)for(let b=a+1;b<boxes.length;b++){
    const one=boxes[a],two=boxes[b];
    const wideOne=one.right-one.left+1,wideTwo=two.right-two.left+1;
    // Both boxes have to be a column of their own, or a wide caption swallows the column beside it.
    if(wideOne>width*COLUMN_WIDTH||wideTwo>width*COLUMN_WIDTH)continue;
    const overlap=Math.min(one.right,two.right)-Math.max(one.left,two.left)+1;
    if(overlap<Math.max(wideOne,wideTwo)/2)continue;
    const upper=one.top<=two.top?one:two,lower=one.top<=two.top?two:one;
    if(lower.top-upper.bottom>gap)continue;
    const first=root(a),second=root(b);
    if(first!==second)parent[second]=first;
  }
  const byRoot=new Map<number,Box>();
  boxes.forEach((box,index)=>{
    const key=root(index),found=byRoot.get(key);
    if(!found)byRoot.set(key,{...box});
    else{
      found.left=Math.min(found.left,box.left);found.top=Math.min(found.top,box.top);
      found.right=Math.max(found.right,box.right);found.bottom=Math.max(found.bottom,box.bottom);
    }
  });
  return [...byRoot.values()];
}

/**
 * A caption line changes word by word, so its pixels are not still; what it keeps is its rows and
 * its stroke energy. Rows carrying many times the clip's own edge share, in one short wide band,
 * are a caption, and the whole band is painted rather than the ghosts of its letters.
 */
function captionBands(field:OverlayField){
  const share=new Float64Array(field.height),left=new Int32Array(field.height).fill(-1),right=new Int32Array(field.height).fill(-1);
  for(let y=0;y<field.height;y++){
    let strokes=0;
    for(let x=1;x<field.width-1;x++){
      const pixel=y*field.width+x;
      if(Math.abs(field.mean[pixel]-field.mean[pixel+1])<STROKE_EDGE)continue;
      strokes++;
      if(left[y]<0)left[y]=x;
      right[y]=x;
    }
    share[y]=strokes/field.width;
  }
  const sorted=[...share].sort((a,b)=>a-b),baseline=sorted[Math.floor(sorted.length/2)];
  const threshold=Math.max(CAPTION_FLOOR,baseline*CAPTION_BASELINE);
  const bands:{top:number;bottom:number;left:number;right:number}[]=[];
  let start=-1,gap=0;
  for(let y=0;y<=field.height;y++){
    const active=y<field.height&&share[y]>=threshold;
    if(active){if(start<0)start=y;gap=0;continue;}
    if(start<0)continue;
    gap++;
    if(gap<=DILATE&&y<field.height)continue;
    const top=start,bottom=y-gap,height=bottom-top+1;
    start=-1;
    if(height<3||height>field.height*CAPTION_HEIGHT)continue;
    const rows=[...share.slice(top,bottom+1)].sort((a,b)=>a-b);
    if(rows[Math.floor(rows.length/2)]>CAPTION_MAX_SHARE)continue;
    let boxLeft=field.width,boxRight=-1;
    for(let row=top;row<=bottom;row++)if(left[row]>=0){boxLeft=Math.min(boxLeft,left[row]);boxRight=Math.max(boxRight,right[row]);}
    if(boxRight<0||(boxRight-boxLeft+1)<field.width*CAPTION_SPAN)continue;
    const margin=Math.round(field.height*CAPTION_MARGIN);
    bands.push({top:Math.max(0,top-margin),bottom:Math.min(field.height-1,bottom+margin),left:Math.max(0,boxLeft-DILATE),right:Math.min(field.width-1,boxRight+DILATE)});
  }
  return bands;
}

/** A short name for a colour: enough for a prompt to say what the picture around the overlay is. */
export function colourName(red:number,green:number,blue:number){
  const r=clamp(red,0,255)/255,g=clamp(green,0,255)/255,b=clamp(blue,0,255)/255;
  const high=Math.max(r,g,b),low=Math.min(r,g,b),range=high-low;
  if(high<0.15)return "black";
  if(range<0.12*high||high<=0)return high>0.82?"white":high>0.45?"grey":"dark grey";
  const hue=high===r?((g-b)/range+(g<b?6:0))*60:high===g?((b-r)/range+2)*60:((r-g)/range+4)*60;
  if(hue<15||hue>=345)return "red";
  if(hue<40)return "orange";
  if(hue<65)return "yellow";
  if(hue<160)return "green";
  if(hue<200)return "cyan";
  if(hue<255)return "blue";
  if(hue<290)return "purple";
  return "pink";
}

/** What a removal asks for: the picture around the overlay, named, with nothing drawn on it. */
export function overlayPrompt(scene:OverlayScene){return `A plain ${scene.colour} studio wall.`;}

/** The colour of the picture right around the overlay, read from a ring outside every box: the median
 *  of the ring's coloured pixels, because the ring also holds a shoulder, a mic and highlights, and
 *  those are not the wall. A flat fill is what the inpaint follows, so it should be the wall's own
 *  tone; asked for an average that includes highlights, the model paints a paler, darker wall. */
function ringScene(field:OverlayField,boxes:Box[]):OverlayScene{
  const red:number[]=[],green:number[]=[],blue:number[]=[],colouredRed:number[]=[],colouredGreen:number[]=[],colouredBlue:number[]=[];
  for(const box of boxes){
    const left=Math.max(0,box.left-RING),right=Math.min(field.width-1,box.right+RING);
    const top=Math.max(0,box.top-RING),bottom=Math.min(field.height-1,box.bottom+RING);
    for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){
      if(x>=box.left&&x<=box.right&&y>=box.top&&y<=box.bottom)continue;
      const pixel=y*field.width+x,r=field.red[pixel],g=field.green[pixel],b=field.blue[pixel];
      red.push(r);green.push(g);blue.push(b);
      if(field.spread[pixel]>=COLOUR_SPREAD){colouredRed.push(r);colouredGreen.push(g);colouredBlue.push(b);}
    }
  }
  if(!red.length)return {colour:"grey",red:128,green:128,blue:128};
  const middle=(values:number[])=>{const sorted=[...values].sort((one,two)=>one-two);return sorted[Math.floor(sorted.length/2)];};
  const useColour=colouredRed.length>=red.length/5;
  const r=middle(useColour?colouredRed:red),g=middle(useColour?colouredGreen:green),b=middle(useColour?colouredBlue:blue);
  return {colour:colourName(r,g,b),red:r,green:g,blue:b};
}

/** Where UI marks are, widened by NEAR_MARK analysis pixels: an app badge stands against its glyph. */
function nearMarks(ui:Uint8Array,width:number,height:number){
  const near=new Uint8Array(ui.length);
  for(let pixel=0;pixel<ui.length;pixel++){
    if(!ui[pixel])continue;
    const x=pixel%width,y=(pixel-x)/width;
    for(let dy=-NEAR_MARK;dy<=NEAR_MARK;dy++)for(let dx=-NEAR_MARK;dx<=NEAR_MARK;dx++){
      const nx=x+dx,ny=y+dy;
      if(nx>=0&&ny>=0&&nx<width&&ny<height)near[ny*width+nx]=1;
    }
  }
  return near;
}

/**
 * The still, UI-looking pixels of a clip the clean crop already made. Returns null when the picture
 * does not move (nothing tells an overlay from the scene) or when what is left is too small to
 * matter or too big to be an overlay. A kept box is painted whole and grown, so a badge's flat
 * field and the soft edge of an icon go too; boxes stacking in one column become one rectangle; a
 * caption's whole band is painted because its letters never hold still. `allowColour` is on for a
 * first look - a still, coloured patch is a badge or an avatar - and off on a painted clip, whose
 * new flat wall is itself a colour that never changes.
 */
async function findOverlays(filename:string,signal:AbortSignal|undefined,allowColour:boolean):Promise<OverlayMask|null>{
  const frame=await frameSize(filename,signal),field=await overlayField(filename,frame,signal);
  if(!field)return null;
  const size=field.width*field.height;
  let moving=0;
  for(let pixel=0;pixel<size;pixel++)if(field.variance[pixel]>=STILL_VARIANCE)moving++;
  if(moving/size<MOVE_SHARE)return null;
  const ui=new Uint8Array(size);
  const jump=(pixel:number,other:number)=>Math.abs(field.mean[pixel]-field.mean[other]);
  for(let y=0;y<field.height;y++)for(let x=0;x<field.width;x++){
    const pixel=y*field.width+x;
    if(field.variance[pixel]>=STILL_VARIANCE)continue;
    let edge=0;
    if(x>0)edge=Math.max(edge,jump(pixel,pixel-1));
    if(x<field.width-1)edge=Math.max(edge,jump(pixel,pixel+1));
    if(y>0)edge=Math.max(edge,jump(pixel,pixel-field.width));
    if(y<field.height-1)edge=Math.max(edge,jump(pixel,pixel+field.width));
    if(field.mean[pixel]>=BRIGHT_MEAN||edge>=STROKE_EDGE)ui[pixel]=1;
  }
  const flags=new Uint8Array(size);
  if(allowColour){
    // A still, coloured patch counts only against a UI mark: an avatar's photo and a badge's flat
    // field sit against the ring or the "+", while a flat wall is still and coloured too.
    const near=nearMarks(ui,field.width,field.height);
    for(let pixel=0;pixel<size;pixel++){
      const coloured=near[pixel]===1&&field.variance[pixel]<STILL_VARIANCE&&field.stillColour[pixel]===1&&field.spread[pixel]>=COLOUR_SPREAD;
      if(ui[pixel]||coloured)flags[pixel]=1;
    }
  }else flags.set(ui);
  const found=components(flags,field.width,field.height).filter(component=>component.pixels>=BLOB_MIN);
  if(!found.length)return null;
  const markLimit=Math.max(24,Math.round(size*0.02));
  const kept=found.filter(component=>component.pixels<=markLimit&&component.right-component.left>=1);
  const grouped=clusters(kept).filter(cluster=>{
    const boxArea=(cluster.right-cluster.left+1)*(cluster.bottom-cluster.top+1);
    if(cluster.right-cluster.left<2||cluster.bottom-cluster.top<1)return false;
    if(boxArea>size*CLUSTER_AREA_SHARE)return false;
    // A solid patch is only a mark when it is small; a big one is a bright thing in the picture.
    return cluster.pixels/boxArea<=SOLID_SHARE||boxArea<=size*SOLID_AREA_SHARE;
  });
  const bands=captionBands(field);
  if(!grouped.length&&!bands.length)return null;
  const boxes=columns([...grouped.map(cluster=>({left:cluster.left,top:cluster.top,right:cluster.right,bottom:cluster.bottom})),...bands],field.width,field.height);
  // Every kept box is painted, grown for the soft edge of an icon and the flat field of a badge.
  const painted=new Uint8Array(size);
  for(const box of boxes){
    const left=Math.max(0,box.left-GROW),right=Math.min(field.width-1,box.right+GROW);
    const top=Math.max(0,Math.round(box.top)-GROW),bottom=Math.min(field.height-1,Math.round(box.bottom)+GROW);
    for(let y=top;y<=bottom;y++)painted.fill(1,y*field.width+left,y*field.width+right+1);
  }
  const width=frame.width,height=frame.height,pixels=new Uint8Array(width*height);
  const scaleX=field.width/width,scaleY=field.height/height;
  let set=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const source=clamp(Math.floor(y*scaleY),0,field.height-1)*field.width+clamp(Math.floor(x*scaleX),0,field.width-1);
    if(painted[source]){pixels[y*width+x]=1;set++;}
  }
  const coverage=set/(width*height);
  if(coverage<OVERLAY_MIN_COVERAGE||coverage>OVERLAY_MAX_COVERAGE)return null;
  const toSource=(value:number,scale:number,limit:number)=>clamp(Math.round(value/scale),0,limit);
  const box=(left:number,top:number,right:number,bottom:number)=>({
    x:toSource(left,scaleX,width-1),y:toSource(top,scaleY,height-1),
    width:Math.max(1,toSource(right+1,scaleX,width)-toSource(left,scaleX,width-1)),
    height:Math.max(1,toSource(bottom+1,scaleY,height)-toSource(top,scaleY,height-1)),
  });
  const regions=boxes.map(found=>box(found.left,found.top,found.right,found.bottom));
  const scene=ringScene(field,boxes);
  return {width,height,pixels,coverage,regions,scene};
}

/** The overlays that sit on a clip the clean crop made, and the colour of the picture around them. */
export function detectOverlayMask(filename:string,signal?:AbortSignal){return findOverlays(filename,signal,true);}

/**
 * What a first removal left behind: only marks that still look like UI. The colour rule is off here,
 * because the flat wall the inpaint just painted is a still, coloured patch too.
 */
export function detectOverlayResidue(filename:string,signal?:AbortSignal){return findOverlays(filename,signal,false);}

/** The mask as a portable grey map: white where the inpaint may paint, black where the picture stays. */
export async function writeOverlayMaskFile(mask:OverlayMask,target:string):Promise<string>{
  const header=Buffer.from(`P5\n${mask.width} ${mask.height}\n255\n`,"ascii"),body=Buffer.allocUnsafe(mask.width*mask.height);
  for(let pixel=0;pixel<body.length;pixel++)body[pixel]=mask.pixels[pixel]?255:0;
  await writeFile(target,Buffer.concat([header,body]));
  return target;
}

/** Two masks of the same clip as one: everything either of them marks, with the first one's colour. */
export function combineMasks(one:OverlayMask,two:OverlayMask):OverlayMask{
  if(one.width!==two.width||one.height!==two.height)return one;
  const pixels=new Uint8Array(one.pixels.length);
  let set=0;
  for(let pixel=0;pixel<pixels.length;pixel++){
    const value=one.pixels[pixel]||two.pixels[pixel];
    pixels[pixel]=value;
    if(value)set++;
  }
  return {width:one.width,height:one.height,pixels,coverage:set/pixels.length,regions:[...one.regions,...two.regions],scene:one.scene};
}

/** The bounded runs a clip is inpainted in, in order. */
export function overlayWindows(frames:number,size=OVERLAY_WINDOW){
  const windows:{start:number;count:number}[]=[];
  for(let start=0;start<frames;start+=size)windows.push({start,count:Math.min(size,frames-start)});
  return windows;
}

/** The size the inpaint works at: sides divisible by 16, about a quarter of a megapixel, never bigger. */export function overlayEnvelope(size:{width:number;height:number}){
  const scale=Math.min(1,Math.sqrt(VACE_PIXELS/(size.width*size.height)),VACE_MAX_SIDE/Math.max(size.width,size.height));
  const step=(value:number)=>Math.max(16,Math.floor(value/16)*16);
  return {width:step(size.width*scale),height:step(size.height*scale)};
}

/** Wan decodes 4n+1 frames; a short window repeats its last frame and the extra ones are dropped later. */
function padded(count:number){return count+((WAN_STEP-(count-1)%WAN_STEP)%WAN_STEP);}

/**
 * Each overlay box filled with the colour of the picture around it. A flat wall is a better hint
 * than a streak interpolated across an icon, and it is the same colour the prompt names, so the
 * model is asked for a wall and shown one.
 */
export function hintFilters(regions:OverlayBox[],scene:OverlayScene,frame?:{width:number;height:number}){
  const colour=`0x${[scene.red,scene.green,scene.blue].map(value=>clamp(Math.round(value),0,255).toString(16).padStart(2,"0")).join("")}`;
  return regions.flatMap(box=>{
    const left=Math.max(0,Math.round(box.x)),top=Math.max(0,Math.round(box.y));
    const right=frame?Math.min(left+Math.round(box.width),frame.width):left+Math.round(box.width);
    const bottom=frame?Math.min(top+Math.round(box.height),frame.height):top+Math.round(box.height);
    return right-left>=2&&bottom-top>=2?[`drawbox=x=${left}:y=${top}:w=${right-left}:h=${bottom-top}:color=${colour}:t=fill`]:[];
  }).join(",");
}

/** The seed a removal runs on; the pack's own default is the same number. */
export const OVERLAY_SEED=543;
let template:Record<string,{class_type:string;inputs:Record<string,unknown>}>|undefined;
/** The pack's graph, with the clip and the mask it was written for. A second pass takes a new seed,
 *  so it is a different guess at the same wall rather than the same ghost again. */
export async function overlayInpaintGraph(source:string,mask:string,prompt=OVERLAY_PROMPT,seed=OVERLAY_SEED){
  template??=JSON.parse(await readFile(PACK_TEMPLATE,"utf8")) as Record<string,{class_type:string;inputs:Record<string,unknown>}>;
  const graph=JSON.parse(JSON.stringify(template)) as Record<string,{class_type:string;inputs:Record<string,unknown>}>;
  for(const node of Object.values(graph)){
    if(node.class_type==="LoadVideo")node.inputs.file=node.inputs.file==="MASK_REQUIRED.mp4"?mask:source;
    else if(node.class_type==="CLIPTextEncode"&&node.inputs.text===PROMPT_DEFAULT)node.inputs.text=prompt;
    else if(node.class_type==="KSampler"&&seed!==OVERLAY_SEED)node.inputs.seed=seed;
  }
  return graph;
}

const base=(worker:OverlayWorker)=>`${worker.origin}${worker.api_prefix??""}`;
const timeout=(signal:AbortSignal,ms:number)=>AbortSignal.any([signal,AbortSignal.timeout(ms)]);

/** One call to the worker; null means it answered with something that is not JSON. */
async function json(worker:OverlayWorker,route:string,init:RequestInit,signal:AbortSignal,ms:number){
  const response=await fetch(`${base(worker)}${route}`,{...init,redirect:"error",signal:timeout(signal,ms)});
  if(!response.ok)throw new Error(`Overlay inpaint worker answered ${response.status}`);
  const body=await response.json() as unknown;
  return body&&typeof body==="object"?body as Record<string,unknown>:null;
}

/** ComfyUI reads its inputs from its own folder, so the window is uploaded and named in the graph. */
async function upload(worker:OverlayWorker,file:string,name:string,signal:AbortSignal){
  const form=new FormData();
  form.append("image",await openAsBlob(file,{type:"video/mp4"}),name);
  form.append("overwrite","true");
  const response=await fetch(`${base(worker)}/upload/image`,{method:"POST",body:form,redirect:"error",signal:timeout(signal,UPLOAD_TIMEOUT_MS)});
  if(!response.ok)throw new Error("Overlay inpaint upload failed");
  const answer=await response.json() as {name?:unknown};
  if(typeof answer.name!=="string"||!answer.name)throw new Error("Overlay inpaint upload failed");
  return answer.name;
}

/** The saved clip in a finished history entry. Only an output node's file counts: a LoadVideo
 *  node reports the input it read, and that is the clip that was painted, not the answer. */
function savedVideo(entry:Record<string,unknown>|undefined){
  const outputs=entry?.outputs as Record<string,Record<string,unknown>>|undefined;
  for(const output of Object.values(outputs??{}))for(const key of ["images","gifs","video","videos"]){
    const list=output[key];
    if(!Array.isArray(list)||!list.length)continue;
    const first=list[0] as {filename?:unknown;subfolder?:unknown;type?:unknown};
    if(typeof first?.filename==="string"&&first.type==="output")return {filename:first.filename,subfolder:typeof first.subfolder==="string"?first.subfolder:"",type:"output"};
  }
  return undefined;
}

/** Queue the pack's graph and wait for the file it saved. */
async function inpaintWindow(worker:OverlayWorker,graph:unknown,signal:AbortSignal,target:string){
  const queued=await json(worker,"/prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:graph,client_id:"comfyfield-overlay-inpaint"})},signal,UPLOAD_TIMEOUT_MS);
  const id=queued?.prompt_id;
  if(typeof id!=="string"||!id)throw new Error("Overlay inpaint was not accepted");
  const until=Date.now()+JOB_TIMEOUT_MS;
  while(Date.now()<until){
    await delay(POLL_MS,signal);
    const history=await json(worker,`/history/${encodeURIComponent(id)}`,{},signal,UPLOAD_TIMEOUT_MS);
    const entry=history?.[id] as Record<string,unknown>|undefined;
    if(!entry)continue;
    if((entry.status as {status_str?:string}|undefined)?.status_str==="error")throw new Error("Overlay inpaint failed");
    const file=savedVideo(entry);
    if(!file)continue;
    const query=new URLSearchParams({filename:file.filename,subfolder:file.subfolder,type:file.type});
    const response=await fetch(`${base(worker)}/view?${query}`,{redirect:"error",signal:timeout(signal,UPLOAD_TIMEOUT_MS)});
    if(!response.ok)throw new Error("Overlay inpaint result could not be read");
    await writeFile(target,Buffer.from(await response.arrayBuffer()));
    return;
  }
  throw new Error("Overlay inpaint took too long");
}

async function ffmpeg(args:string[],signal:AbortSignal){
  await execute(command("ffmpeg"),["-hide_banner","-loglevel","error","-nostdin","-y",...args],{windowsHide:true,maxBuffer:MAX_LOG_BYTES,signal:timeout(signal,JOB_TIMEOUT_MS)});
}

/**
 * Take the still overlays out of one clip, one bounded window at a time. Windows already done are
 * kept in `cache`, so a prepare that runs out of time continues instead of starting again. Nothing
 * here throws for a normal reason: a clip with no overlay, no worker, or a run that failed all come
 * back as a state, and the caller keeps the clip it had.
 */
export async function removeOverlays(input:{clip:string;frames:number;fps:number;cache:string;worker?:OverlayWorker;prompt?:string;signal:AbortSignal}):Promise<OverlayRemoval>{
  const mask=await detectOverlayMask(input.clip,input.signal);
  if(!mask)return {state:"none",done:0,total:0};
  const windows=overlayWindows(input.frames);
  if(!input.worker||!input.worker.origin||windows.length>OVERLAY_MAX_WINDOWS)return {state:"unavailable",done:0,total:windows.length,mask};
  const worker=input.worker,prompt=input.prompt??overlayPrompt(mask.scene);
  await mkdir(input.cache,{recursive:true});
  const maskFile=await writeOverlayMaskFile(mask,path.join(input.cache,"mask.pgm"));
  const envelope=overlayEnvelope({width:mask.width,height:mask.height});
  const files=windows.map((_,index)=>path.join(input.cache,`w-${String(index).padStart(3,"0")}.mp4`));
  let passes=0;
  try{
    for(const [index,window] of windows.entries()){
      if(await exists(files[index]))continue;
      if(passes>=PASSES_PER_CALL)return {state:"incomplete",done:await finished(files),total:windows.length,mask};
      passes+=await oneWindow({worker,prompt,envelope,mask,maskFile,clip:input.clip,window,fps:input.fps,cache:input.cache,index,target:files[index],signal:input.signal});
    }
  }catch(error){
    if(error instanceof VideoExtensionToolUnavailableError||error instanceof VideoExtensionMediaError)throw error;
    return {state:"incomplete",done:await finished(files),total:windows.length,mask};
  }
  const list=path.join(input.cache,"list.txt");
  await writeFile(list,files.map(file=>`file '${file.replace(/'/g,"'\\''")}'`).join("\n"),"utf8");
  return {state:"removed",list,windows:files,frames:input.frames,mask};
}

async function exists(file:string){return stat(file).then(info=>info.size>0,()=>false);}
async function finished(files:string[]){const all=await Promise.all(files.map(exists));return all.filter(Boolean).length;}

/** One inpaint pass: the window at full size, the mask it may repaint, and the answer composited
 *  back inside that mask only, so every pixel outside an overlay is the camera's own. */
async function paintWindow(input:{worker:OverlayWorker;prompt:string;seed:number;envelope:{width:number;height:number};mask:OverlayMask;maskFile:string;source:string;count:number;fps:number;cache:string;tag:string;target:string;signal:AbortSignal}){
  const {worker,envelope,fps,signal}=input;
  const small=path.join(input.cache,`source-${input.tag}.mp4`),smallMask=path.join(input.cache,`mask-${input.tag}.mp4`),answer=path.join(input.cache,`answer-${input.tag}.mp4`),hint=path.join(input.cache,`hint-${input.tag}.mp4`);
  const paddedFrames=padded(input.count),fills=hintFilters(input.mask.regions,input.mask.scene,{width:input.mask.width,height:input.mask.height});
  try{
    // What the inpaint is guided by: each overlay box filled with the colour of the picture around
    // it, the envelope smoothed inside the mask, so the model refines a wall instead of a streak.
    await ffmpeg(["-i",input.source,"-vf",`${fills?`${fills},`:""}scale=${envelope.width}:${envelope.height}:flags=bicubic,format=yuv420p`,"-an","-r",String(fps),"-c:v","libx264","-preset","veryfast","-crf","18","-pix_fmt","yuv420p",hint],signal);
    await ffmpeg(["-i",hint,"-loop","1","-i",input.maskFile,"-filter_complex",
      `[1:v]scale=${envelope.width}:${envelope.height}:flags=neighbor,format=yuv420p[mask];[0:v]boxblur=luma_radius=${HINT_BLUR}:luma_power=2[soft];[0:v][soft][mask]maskedmerge,format=yuv420p,tpad=stop_mode=clone:stop=${paddedFrames-input.count}[hint]`,
      "-map","[hint]","-frames:v",String(paddedFrames),"-an","-r",String(fps),"-c:v","libx264","-preset","veryfast","-crf","18","-pix_fmt","yuv420p",small],signal);
    await ffmpeg(["-loop","1","-framerate",String(fps),"-i",input.maskFile,"-vf",`scale=${envelope.width}:${envelope.height}:flags=neighbor,format=yuv420p`,"-r",String(fps),"-frames:v",String(paddedFrames),"-c:v","libx264","-preset","veryfast","-crf","12","-pix_fmt","yuv420p",smallMask],signal);
    const [sourceName,maskName]=await Promise.all([upload(worker,small,`comfyfield-overlay-source-${input.tag}.mp4`,signal),upload(worker,smallMask,`comfyfield-overlay-mask-${input.tag}.mp4`,signal)]);
    await inpaintWindow(worker,await overlayInpaintGraph(sourceName,maskName,input.prompt,input.seed),signal,answer);
    await ffmpeg(["-i",input.source,"-i",answer,"-loop","1","-i",input.maskFile,"-filter_complex",
      `[1:v]scale=${input.mask.width}:${input.mask.height}:flags=bicubic,format=yuv420p[painted];[2:v]scale=${input.mask.width}:${input.mask.height}:flags=neighbor,format=gray,gblur=sigma=${EDGE_BLUR}[where];[0:v][painted][where]maskedmerge[out]`,
      "-map","[out]","-frames:v",String(input.count),"-an","-r",String(fps),"-c:v","libx264","-preset","veryfast","-crf","18","-pix_fmt","yuv420p",input.target],signal);
  }finally{
    await Promise.all([small,smallMask,answer,hint].map(file=>rm(file,{force:true}).catch(()=>{})));
  }
}

/**
 * One window: the picture at full size, one inpaint pass, and - when that pass still leaves app
 * marks on its own result - a second pass over that result with a new seed and the leftover marks
 * added to the mask. A result with detected residue never becomes a completed cache
 * window; a partial improvement is not a clean output. Returns the pass count.
 */
async function oneWindow(input:{worker:OverlayWorker;prompt:string;envelope:{width:number;height:number};mask:OverlayMask;maskFile:string;clip:string;window:{start:number;count:number};fps:number;cache:string;index:number;target:string;signal:AbortSignal}){
  const {window,fps,signal}=input,tag=`${String(input.index).padStart(3,"0")}-${Date.now()}`;
  const plain=path.join(input.cache,`plain-${tag}.mp4`),first=path.join(input.cache,`first-${tag}.mp4`),second=path.join(input.cache,`second-${tag}.mp4`);
  try{
    // The picture at full size, so the pixels outside the mask stay the ones the camera shot.
    // Every window is at the clip's own constant rate, so the windows join back into one clip.
    await ffmpeg(["-i",input.clip,"-vf",`trim=start_frame=${window.start}:end_frame=${window.start+window.count},setpts=PTS-STARTPTS`,"-an","-r",String(fps),"-c:v","libx264","-preset","veryfast","-crf","18","-pix_fmt","yuv420p",plain],signal);
    await paintWindow({worker:input.worker,prompt:input.prompt,seed:OVERLAY_SEED,envelope:input.envelope,mask:input.mask,maskFile:input.maskFile,source:plain,count:window.count,fps,cache:input.cache,tag:`${tag}-1`,target:first,signal});
    const residue=await detectOverlayResidue(first,signal);
    if(!residue){
      await rename(first,input.target);
      return 1;
    }
    const union=combineMasks(input.mask,residue),unionFile=await writeOverlayMaskFile(union,path.join(input.cache,`mask2-${tag}.pgm`));
    try{
      await paintWindow({worker:input.worker,prompt:input.prompt,seed:OVERLAY_SEED+input.index+1,envelope:input.envelope,mask:union,maskFile:unionFile,source:first,count:window.count,fps,cache:input.cache,tag:`${tag}-2`,target:second,signal});
      const leftover=await detectOverlayResidue(second,signal);
      if(leftover)throw new Error("Overlay residue remains after the bounded inpaint passes");
      await rename(second,input.target);
    }finally{
      await rm(unionFile,{force:true}).catch(()=>{});
    }
    return 2;
  }finally{
    await Promise.all([plain,first,second].map(file=>rm(file,{force:true}).catch(()=>{})));
  }
}
