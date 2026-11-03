import {execFileSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll,describe,expect,it} from "vitest";
import {load,planTrim,scoreWindow,spliceRatio} from "../scripts/seam-check-lib.mjs";

const fixtures=new URL("../fixtures/real/",import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,"$1");
const ffmpegOk=(()=>{try{execFileSync("ffmpeg",["-version"],{stdio:"pipe"});return true;}catch{return false;}})();
const dir=mkdtempSync(join(tmpdir(),"seam-check-"));
const make=(name:string,args:string[])=>{const out=join(dir,name);execFileSync("ffmpeg",["-y","-v","error",...args,"-pix_fmt","yuv420p",out],{stdio:"pipe"});return out;};
afterAll(()=>rmSync(dir,{recursive:true,force:true}));

/* Ported from OpenField's Seam Doctor (MIT) and Body Double's QC (Apache-2.0); the clips are Pexels fixtures. */
describe.skipIf(!ffmpegOk)("seam check on real clips",()=>{
  const ocean=()=>make("ocean.mp4",["-i",join(fixtures,"clip-ocean-waves.mp4"),"-t","3","-an","-vf","scale=480:-2,fps=24"]);
  it("a clip that does not come back to its first frame has a visible loop seam",()=>{
    const m=scoreWindow(load(ocean()));
    expect(m.verdict).toBe("visible");expect(m.ratio).toBeGreaterThan(2);
  });
  it("a forward-and-back clip closes cleanly",()=>{
    const pingpong=make("pingpong.mp4",["-i",ocean(),"-filter_complex","[0]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1"]);
    const m=scoreWindow(load(pingpong));
    expect(m.verdict).toBe("seamless");expect(m.ratio).toBeLessThan(1);
  });
  it("a cut from the ocean to a synthetic scene is flagged at its frame and not elsewhere",()=>{
    const traffic=make("traffic.mp4",["-f","lavfi","-i","color=c=red:s=480x270:r=24:d=2"]);
    const joined=make("joined.mp4",["-i",ocean(),"-i",traffic,"-filter_complex","[0][1]concat=n=2:v=1"]);
    const clip=load(joined);
    expect(spliceRatio(clip,72)).toBeGreaterThan(2);expect(spliceRatio(clip,30)).toBeLessThan(2);
  });
  it("the trim plan finds the window of a clip that closes inside it",()=>{
    const pingpong=make("pp.mp4",["-i",ocean(),"-filter_complex","[0]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1"]);
    const withTail=make("tail.mp4",["-i",pingpong,"-i",ocean(),"-filter_complex","[1]trim=end_frame=20,setpts=PTS-STARTPTS[t];[0][t]concat=n=2:v=1"]);
    const clip=load(withTail);expect(scoreWindow(clip).verdict).toBe("visible");
    const plan=planTrim(clip);expect(plan).not.toBeNull();expect(plan!.predicted.verdict).toBe("seamless");expect(plan!.frames).toBeGreaterThan(clip.tex.length/2);
  });
});
