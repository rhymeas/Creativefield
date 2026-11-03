import {describe,it,expect} from "vitest";
import {MaskCoverageBuilder,validatedMaskCoverage,flaggedMaskFrames} from "../src/capabilities/mask-coverage";
import {fileSha256,inspectMaskCoverage} from "../server/masked-media";
import {maskFixtures} from "./masked-fixtures";
const sha="a".repeat(64),geometry={width:16,height:16,frames:17};
function fixture(){const builder=new MaskCoverageBuilder(16,16,17);for(let frame=0;frame<17;frame++)for(let pixel=0;pixel<256;pixel++)builder.add(frame===4||frame!==2&&pixel===17);return builder.finish(sha);}
describe("decoded mask coverage",()=>{
  it("records exact extents and distinguishes empty/full frames without inventing confidence",()=>{
    const report=fixture();expect(report.frames[0]).toEqual({selectedPixels:1,bounds:{left:1,top:1,width:1,height:1}});expect(report.frames[2]).toEqual({selectedPixels:0,bounds:null});expect(report.frames[4]).toEqual({selectedPixels:256,bounds:{left:0,top:0,width:16,height:16}});expect(flaggedMaskFrames(report)).toEqual([2,4]);
  });
  it("rejects incomplete, extra and unbounded decoded sequences",()=>{
    expect(()=>new MaskCoverageBuilder(900,16,17)).toThrow();const short=new MaskCoverageBuilder(16,16,17);short.add(true);expect(()=>short.finish(sha)).toThrow("Incomplete");const full=new MaskCoverageBuilder(16,16,17);for(let i=0;i<256*17;i++)full.add(false);expect(()=>full.add(false)).toThrow("Unexpected");
  });
  it("rejects stale hashes, geometry, frame counts and forged pixel/extents metadata",()=>{
    const report=fixture();expect(validatedMaskCoverage(report,geometry,sha)).toBe(report);
    for(const value of [null,{...report,maskSha256:"b".repeat(64)},{...report,width:32},{...report,frames:report.frames.slice(1)},{...report,frames:report.frames.map((f,i)=>i===0?{...f,selectedPixels:257}:f)},{...report,frames:report.frames.map((f,i)=>i===0?{...f,bounds:{left:16,top:0,width:1,height:1}}:f)}])expect(validatedMaskCoverage(value,geometry,sha)).toBe(null);
  });
  it("scans all real encoded frames and binds the report to the file hash",async()=>{
    const f=await maskFixtures(),mask=await f.make("coverage-gaps","color=c=black:s=160x96:r=16,drawbox=x=32:y=16:w=64:h=64:color=white:t=fill,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='eq(n,4)',drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,8)'");
    const report=await inspectMaskCoverage(mask,{width:160,height:96,frames:17},await fileSha256(mask));expect(report.frames).toHaveLength(17);expect(report.frames[0]).toEqual({selectedPixels:4096,bounds:{left:32,top:16,width:64,height:64}});expect(flaggedMaskFrames(report)).toEqual([4,8]);
    await expect(inspectMaskCoverage(mask,{width:160,height:96,frames:17},sha)).rejects.toThrow("changed");
  });
});
