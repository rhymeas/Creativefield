import {describe,expect,it} from "vitest";
import {rasterFrame} from "../server/stage/raster";
import {SETS,buildScene} from "../server/stage/sets";
import {CAMERA_MOVES,STAGE_FPS,STAGE_SECONDS,cameraAt,stageFrames,stageSize} from "../server/stage/stage";
import {renderBlocking} from "../server/stage/render";
import {execFileSync,spawnSync} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

/* The drawing is ported from OpenField's Stage (MIT); these check the parts the depth restyle depends on. */
describe("block a shot",()=>{
  it("draws lengths and sizes the Wan depth restyle accepts",()=>{
    for(const s of STAGE_SECONDS){const n=stageFrames(s);expect((n-1)%4,`${s} s`).toBe(0);expect(Math.abs(n/STAGE_FPS-s)).toBeLessThan(0.1);}
    for(const aspect of ["16:9","9:16","1:1"] as const){const {w,h}=stageSize(aspect);expect(w%16).toBe(0);expect(h%16).toBe(0);}
  });
  it("every set works with every camera move and starts and ends on its path",()=>{
    for(const set of SETS)for(const move of CAMERA_MOVES){
      const scene=buildScene(set.id,move.id,"16:9");
      cameraAt(scene,0).pos.forEach((v,i)=>expect(v).toBeCloseTo(scene.keys[0].pos[i],3));cameraAt(scene,1).pos.forEach((v,i)=>expect(v).toBeCloseTo(scene.keys[scene.keys.length-1].pos[i],3));
    }
    expect(()=>buildScene("nope","push-in","16:9")).toThrow(/Unknown set/);expect(()=>buildScene("street","nope","16:9")).toThrow(/Unknown camera move/);
  });
  it("the clay shows the set and the depth pass is near-white close up and dark far away",()=>{
    const scene=buildScene("courtyard","static","16:9"),{clay,depth}=rasterFrame(scene,0,128,72);
    const bg=Math.round(0.11*255);let nonBackground=0;for(let i=0;i<clay.length;i+=3)if(Math.abs(clay[i]-bg)>6)nonBackground++;
    expect(nonBackground).toBeGreaterThan(128*72*0.3);
    expect(depth[0]).toBe(depth[1]);expect(depth[1]).toBe(depth[2]);
    const bottom=depth[(71*128+64)*3],top=depth[(2*128+64)*3];expect(bottom).toBeGreaterThan(top);
  });
  it("a camera move changes the picture and a locked-off camera does not",()=>{
    const moving=buildScene("courtyard","orbit-right","16:9"),still=buildScene("courtyard","static","16:9");
    const diff=(s:typeof moving)=>{const a=rasterFrame(s,0,96,54).clay,b=rasterFrame(s,1,96,54).clay;let d=0;for(let i=0;i<a.length;i++)d+=Math.abs(a[i]-b[i]);return d/a.length;};
    expect(diff(moving)).toBeGreaterThan(5);expect(diff(still)).toBeLessThan(0.5);
  });
});

const ffmpeg=process.env.FFMPEG_PATH??"ffmpeg",ffprobe=process.env.FFPROBE_PATH??"ffprobe";
const toolsAvailable=[ffmpeg,ffprobe].every(tool=>spawnSync(tool,["-version"],{windowsHide:true}).status===0);
describe.skipIf(!toolsAvailable)("H3 blocking clip",()=>{
  it("encodes matching 24 fps layout and depth clips for Make it real",async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),"cf-block-shot-"));
    try{
      const result=await renderBlocking(buildScene("street","push-in","16:9"),2,dir,undefined,24);
      expect(result).toMatchObject({frames:48,fps:24,width:832,height:480});
      for(const file of [result.clay,result.depth]){
        const data=JSON.parse(execFileSync(ffprobe,["-v","error","-select_streams","v:0","-count_frames","-show_entries","stream=width,height,avg_frame_rate,nb_read_frames,duration","-of","json",file],{encoding:"utf8",windowsHide:true})).streams[0];
        expect(data).toMatchObject({width:832,height:480,avg_frame_rate:"24/1",nb_read_frames:"48"});
        expect(Number(data.duration)).toBeCloseTo(2,2);
      }
    }finally{await rm(dir,{recursive:true,force:true});}
  },60000);
});
