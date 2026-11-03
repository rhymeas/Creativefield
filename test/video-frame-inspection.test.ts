import {describe,it,expect} from "vitest";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import sharp from "sharp";
import {extractVideoFrameInspection,inspectionFrameIndices,rgbDifference} from "../server/video-frame-inspection";

describe("decoded FLF frame inspection",()=>{
  it("includes both endpoints, samples at most eight real positions and rejects invalid counts",()=>{
    expect(inspectionFrameIndices(17)).toEqual([0,2,5,7,9,11,14,16]);
    expect(inspectionFrameIndices(2)).toEqual([0,1]);expect(inspectionFrameIndices(81)).toHaveLength(8);
    for(const count of [0,1,82,2.5,NaN])expect(()=>inspectionFrameIndices(count)).toThrow();
  });
  it("measures aligned RGB differences without inventing a quality verdict",()=>{
    expect(rgbDifference(Buffer.from([10,20,30]),Buffer.from([11,22,33]))).toEqual({meanAbsoluteRgb8:2,maxChannelDelta8:3});
    expect(()=>rgbDifference(Buffer.alloc(0),Buffer.alloc(0))).toThrow();expect(()=>rgbDifference(Buffer.alloc(2),Buffer.alloc(3))).toThrow();
  });
  it("extracts actual PNGs, hashes every decoded frame and exposes a mismatched final endpoint",async()=>{
    const root=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-frame-test-"),scratch=root+"/frames";await mkdir(scratch);
    try{
      const first=root+"/red.png",last=root+"/blue.png",video=root+"/constant.mp4";
      for(const [file,color]of [[first,"red"],[last,"blue"]])await writeFile(file,await sharp({create:{width:320,height:240,channels:3,background:color}}).png().toBuffer());
      await promisify(execFile)("ffmpeg",["-v","error","-nostdin","-y","-f","lavfi","-i","color=c=red:s=320x240:r=16","-frames:v","17","-c:v","libx264","-pix_fmt","yuv420p",video],{windowsHide:true});
      const result=await extractVideoFrameInspection(video,scratch,17,{first,last});
      expect(result.images.map(i=>i.index)).toEqual(inspectionFrameIndices(17));
      expect(result.measurement.decodedFrameMd5).toHaveLength(17);expect(result.measurement.adjacent).toHaveLength(16);
      expect(result.measurement.duplicatePairs.length).toBeGreaterThan(0);
      expect(result.measurement.firstSourceDelta.meanAbsoluteRgb8).toBeLessThan(3);expect(result.measurement.lastSourceDelta.meanAbsoluteRgb8).toBeGreaterThan(100);
      for(const image of result.images)expect(await sharp(image.bytes).metadata()).toMatchObject({format:"png",width:320,height:240});
      await expect(extractVideoFrameInspection(video,scratch,21,{first,last})).rejects.toThrow("frozen");
    }finally{if(!root.startsWith((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-frame-test-"))throw new Error("Unexpected test cleanup path");await rm(root,{recursive:true,force:true});}
  });
});
