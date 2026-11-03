import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {execFile,spawnSync} from "node:child_process";
import {promisify} from "node:util";
import {existsSync} from "node:fs";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Pool} from "pg";
import {detectContentRegion,findCleanRegion,MIN_CONTENT_FRACTION,snapContentRegion} from "../server/video-content-region";
import {fileSha256AndBytes} from "../server/video-extension-media";
import {prepareVideoSource} from "../server/video-extension-prepare";
import type {DiskStore} from "../server/storage";

const execute=promisify(execFile);
const binariesAvailable=spawnSync(process.env.FFMPEG_PATH??"ffmpeg",["-version"],{windowsHide:true}).status===0
  &&spawnSync(process.env.FFPROBE_PATH??"ffprobe",["-version"],{windowsHide:true}).status===0;
const font=[(process.env.SystemRoot ?? process.env.WINDIR ?? "") + "/Fonts/arial.ttf",(process.env.SystemRoot ?? process.env.WINDIR ?? "") + "/Fonts/segoeui.ttf","/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find(existsSync);
const even=(value:number)=>value%2===0;

/** A static label, the way a status bar or a search box sits on a phone recording. */
function label(text:string,x:number,y:number,size:number){
  return `drawtext=${font?`fontfile='${font.replace(/:/g,"\\:")}'`:"font=Sans"}:text='${text}':x=${x}:y=${y}:fontsize=${size}:fontcolor=white`;
}

/** A caption that scrolls across the app around the picture. */
function movingLabel(text:string,expression:string,y:number,size:number){
  return `drawtext=${font?`fontfile='${font.replace(/:/g,"\\:")}'`:"font=Sans"}:text='${text}':x='${expression}':y=${y}:fontsize=${size}:fontcolor=white`;
}

describe("standard aspect snap",()=>{
  it("fits a 16:9 picture from a tall frame without stretching it",()=>{
    const snapped=snapContentRegion({x:0,y:656,width:1080,height:610},{width:1080,height:1920});
    expect(snapped.aspect).toBe("16:9");
    expect(snapped.width).toBeLessThanOrEqual(1080);
    expect(snapped.height).toBeLessThanOrEqual(610);
    expect(Math.abs(snapped.width/snapped.height-16/9)).toBeLessThan(0.02);
    expect(snapped.y).toBeGreaterThanOrEqual(656);
    expect(snapped.y+snapped.height).toBeLessThanOrEqual(1266);
  });

  it("keeps a truly vertical picture at 4:5 and a square one at 1:1",()=>{
    expect(snapContentRegion({x:0,y:70,width:270,height:340},{width:270,height:480}).aspect).toBe("4:5");
    expect(snapContentRegion({x:58,y:148,width:244,height:244},{width:360,height:540}).aspect).toBe("1:1");
  });

  it("removes the smallest extra strip and only ever crops",()=>{
    const region={x:100,y:200,width:300,height:200},snapped=snapContentRegion(region,{width:1080,height:1920});
    expect(snapped.aspect).toBe("4:3");
    expect(snapped.width).toBeLessThanOrEqual(region.width);
    expect(snapped.height).toBeLessThanOrEqual(region.height);
    expect(1-(snapped.width*snapped.height)/(region.width*region.height)).toBeLessThan(0.12);
    expect(snapped.x).toBeGreaterThanOrEqual(region.x);
    expect(snapped.y).toBeGreaterThanOrEqual(region.y);
    expect(snapped.x+snapped.width).toBeLessThanOrEqual(region.x+region.width);
    expect(snapped.y+snapped.height).toBeLessThanOrEqual(region.y+region.height);
  });

  it("returns even offsets and sizes so a yuv420p crop is valid",()=>{
    const snapped=snapContentRegion({x:11,y:37,width:539,height:401},{width:1080,height:1920});
    for(const value of [snapped.x,snapped.y,snapped.width,snapped.height])expect(even(value),String(value)).toBe(true);
  });
});

describe.skipIf(!binariesAvailable)("content region in a screen recording",()=>{
  let scratch:string,recording:string,plain:string,small:string,screenLike:string;

  beforeAll(async()=>{
    scratch=await mkdtemp(path.join(tmpdir(),"comfyfield-region-"));
    const ffmpeg=process.env.FFMPEG_PATH??"ffmpeg";
    // The picture sits in a 9:16 phone frame, bars above and below carry static app text.
    recording=path.join(scratch,"recording.mp4");
    await execute(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-y",
      "-f","lavfi","-i","color=c=#101820:s=270x480:r=30:d=2",
      "-f","lavfi","-i","life=s=270x152:r=30:mold=10:ratio=0.1:seed=1",
      "-filter_complex",`[1:v]trim=duration=2[vid];[0:v][vid]overlay=0:164,${label("Status bar",10,20,18)},${label("Search",10,430,18)}`,
      "-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p",recording],{windowsHide:true,timeout:60000});
    // A clip with no app around it: the whole frame moves.
    plain=path.join(scratch,"plain.mp4");
    await execute(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","testsrc2=s=270x480:r=30:d=2",
      "-frames:v","60","-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p",plain],{windowsHide:true,timeout:60000});
    // A picture under thirty percent of the frame is not worth a crop.
    small=path.join(scratch,"small.mp4");
    await execute(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-y",
      "-f","lavfi","-i","color=c=#101820:s=360x540:r=30:d=2",
      "-f","lavfi","-i","life=s=200x200:r=30:mold=10:ratio=0.1:seed=1",
      "-filter_complex","[1:v]trim=duration=2[vid];[0:v][vid]overlay=80:170",
      "-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p",small],{windowsHide:true,timeout:60000});
    // The real failure: the picture moves, a narrow side rail moves, and a caption scrolls below.
    screenLike=path.join(scratch,"screen-like.mp4");
    await execute(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-y",
      "-f","lavfi","-i","color=c=#101820:s=360x640:r=30:d=2.5",
      "-f","lavfi","-i","testsrc2=s=360x270:r=30:d=2.5,scroll=horizontal=0.5",
      "-f","lavfi","-i","testsrc2=s=36x440:r=30:d=2.5,scroll=vertical=0.5",
      "-filter_complex",`[0:v][1:v]overlay=0:150[withvideo];[withvideo][2:v]overlay=318:70,${label("Status bar",10,20,18)},${label("Search",10,90,18)},${movingLabel("Caption scrolling below the picture","w-mod(t*240,w+tw)",470,24)}`,
      "-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p",screenLike],{windowsHide:true,timeout:60000});
  },120000);

  afterAll(async()=>{
    if(scratch)await rm(scratch,{recursive:true,force:true});
  });

  it("finds the moving picture and leaves the static text bars out",async()=>{
    const found=await detectContentRegion(recording);
    expect(found).not.toBeNull();
    expect(found!.frame).toEqual({width:270,height:480});
    expect(Math.abs(found!.region.x)).toBeLessThanOrEqual(4);
    expect(Math.abs(found!.region.y-164)).toBeLessThanOrEqual(4);
    expect(Math.abs(found!.region.width-270)).toBeLessThanOrEqual(6);
    expect(Math.abs(found!.region.height-152)).toBeLessThanOrEqual(6);
    const snapped=await findCleanRegion(recording);
    expect(snapped).not.toBeNull();
    expect(snapped!.aspect).toBe("16:9");
    expect(snapped!.width).toBeLessThanOrEqual(found!.region.width+2);
    expect(Math.abs(snapped!.width/snapped!.height-16/9)).toBeLessThan(0.02);
    // The clean picture is the middle of the frame, well away from both text bars.
    expect(snapped!.y).toBeGreaterThanOrEqual(150);
    expect(snapped!.y+snapped!.height).toBeLessThanOrEqual(330);
    for(const value of [snapped!.x,snapped!.y,snapped!.width,snapped!.height])expect(even(value)).toBe(true);
  },120000);

  it("keeps the picture when a side rail and a scrolling caption also move",async()=>{
    const found=await detectContentRegion(screenLike);
    expect(found).not.toBeNull();
    expect(found!.frame).toEqual({width:360,height:640});
    expect(Math.abs(found!.region.x)).toBeLessThanOrEqual(4);
    expect(Math.abs(found!.region.y-150)).toBeLessThanOrEqual(8);
    expect(found!.region.width).toBeGreaterThanOrEqual(352);
    expect(Math.abs(found!.region.height-270)).toBeLessThanOrEqual(8);
    const snapped=await findCleanRegion(screenLike);
    expect(snapped).not.toBeNull();
    expect(snapped!.aspect).toBe("4:3");
    expect(snapped!.width).toBeGreaterThanOrEqual(352);
    expect(Math.abs(snapped!.width/snapped!.height-4/3)).toBeLessThan(0.02);
    // The rail and caption are outside the picture and must not pull the crop down or sideways.
    expect(snapped!.y).toBeGreaterThanOrEqual(144);
    expect(snapped!.y+snapped!.height).toBeLessThanOrEqual(426);
    for(const value of [snapped!.x,snapped!.y,snapped!.width,snapped!.height])expect(even(value),String(value)).toBe(true);
  },120000);

  it("leaves a plain clip alone",async()=>{
    expect(await detectContentRegion(plain)).toBeNull();
    expect(await findCleanRegion(plain)).toBeNull();
  },120000);

  it("refuses a picture under thirty percent of the frame",async()=>{
    expect(MIN_CONTENT_FRACTION).toBe(0.3);
    expect(await findCleanRegion(small)).toBeNull();
  },120000);

  it("answers cleaned:false with the source itself when nothing is found",async()=>{
    const source={id:randomUUID(),project_id:randomUUID(),name:"Plain.mp4",media_type:"video",content_type:"video/mp4",
      sha256:(await fileSha256AndBytes(plain)).sha256,bytes:(await readFile(plain)).length,parent_id:null,created_at:new Date().toISOString(),metadata:{},storage_key:"stored"};
    const pool={query:async()=>({rows:[source]})} as unknown as Pool;
    const store={file:async()=>plain} as unknown as DiskStore;
    const result=await prepareVideoSource(pool,store,"workspace","user",{projectId:source.project_id,assetId:source.id,clean:true});
    expect(result.cleaned).toBe(false);
    expect(result.id).toBe(source.id);
    expect(result.name).toBe("Plain.mp4");
    expect(result).not.toHaveProperty("storage_key");
  },120000);
});
