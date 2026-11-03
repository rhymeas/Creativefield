import {describe,it,expect} from "vitest";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {analyseReplaceSeams,inspectReplaceSeams,seamFrameIndices} from "../server/replace-seam-check";

const stride=16*16*3;
const solid=(value:number)=>Buffer.alloc(stride,value);
/** A flat frame per value, so every adjacent difference is exactly the value change. */
const ramp=(values:number[])=>values.map(solid);
const steady=(seamValue:number)=>{
  const values=Array.from({length:157},(_,index)=>10+index);values[81]=seamValue;return ramp(values);
};

describe("SCAIL replace seam check",()=>{
  it("names the seam every 81 frames and 76 apart, and nothing before the first cut",()=>{
    expect(seamFrameIndices(1)).toEqual([]);
    expect(seamFrameIndices(81)).toEqual([]);
    expect(seamFrameIndices(82)).toEqual([81]);
    expect(seamFrameIndices(157)).toEqual([81]);
    expect(seamFrameIndices(613)).toEqual([81,157,233,309,385,461,537]);
    expect(seamFrameIndices(613,81,76)).toEqual(seamFrameIndices(613));
    for(const bad of [0,-1,2.5,NaN])expect(()=>seamFrameIndices(bad)).toThrow();
  });

  it("passes a flat ramp: no seam stands above the local motion",()=>{
    const report=analyseReplaceSeams(ramp(Array.from({length:157},(_,index)=>10+index)),{sample:{width:16,height:16}});
    expect(report.frames).toBe(157);
    expect(report.sample).toEqual({width:16,height:16});
    expect(report.seams).toHaveLength(1);
    expect(report.seams[0]).toMatchObject({frame:81,from:80,to:81,meanAbsoluteRgb8:1,localMedianMeanAbsoluteRgb8:1,ratio:1,suspicious:false});
    expect(report.suspiciousFrames).toEqual([]);
  });

  it("flags exactly the seam a garbage frame sits on",()=>{
    const report=analyseReplaceSeams(steady(255));
    expect(report.seams.map(seam=>seam.frame)).toEqual([81]);
    expect(report.seams[0]).toMatchObject({meanAbsoluteRgb8:165,maxChannelDelta8:165,localMedianMeanAbsoluteRgb8:1,ratio:165,suspicious:true});
    expect(report.suspiciousFrames).toEqual([81]);
  });

  it("only calls a seam suspicious above three times its neighbours",()=>{
    expect(analyseReplaceSeams(steady(93)).seams[0]).toMatchObject({meanAbsoluteRgb8:3,ratio:3,suspicious:false});
    expect(analyseReplaceSeams(steady(94)).seams[0]).toMatchObject({meanAbsoluteRgb8:4,ratio:4,suspicious:true});
    expect(analyseReplaceSeams(steady(94)).suspiciousFrames).toEqual([81]);
  });

  it("asks for two frames and equal samples rather than inventing a seam",()=>{
    expect(()=>analyseReplaceSeams([solid(1)])).toThrow();
    expect(()=>analyseReplaceSeams([solid(1),Buffer.alloc(4)])).toThrow();
  });

  it("decodes a finished two-chunk render and finds the one bad seam",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"comfyfield-seam-"));
    try{
      const width=64,height=48,frames=157,raw=Buffer.alloc(width*height*3*frames);
      for(let index=0;index<frames;index++){
        const value=index===81?255:10+(index%50)*4;
        raw.fill(value,index*width*height*3,(index+1)*width*height*3);
      }
      const source=path.join(root,"frames.rgb"),video=path.join(root,"render.mp4");
      await writeFile(source,raw);
      await promisify(execFile)("ffmpeg",["-v","error","-nostdin","-y","-f","rawvideo","-pix_fmt","rgb24","-s",`${width}x${height}`,"-r","16","-i",source,"-c:v","libx264","-pix_fmt","yuv420p",video],{windowsHide:true});
      const report=await inspectReplaceSeams(video);
      expect(report.frames).toBe(frames);
      expect(report.sample).toEqual({width:256,height:192});
      expect(report.seams.map(seam=>seam.frame)).toEqual([81]);
      expect(report.suspiciousFrames).toEqual([81]);
    }finally{if(path.dirname(root)!==path.resolve(tmpdir()))throw new Error("Unexpected test cleanup path");await rm(root,{recursive:true,force:true});}
  });
});
