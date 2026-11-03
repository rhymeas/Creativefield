import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileSha256 } from "../server/masked-media";
import { admitAlignedDepthVideo,verifyEffectInputs } from "../server/depth-video-admission";
import {writeFile,readFile} from "node:fs/promises";
import { maskFixtures } from "./masked-fixtures";
const execute = promisify(execFile);

describe("preprocessed depth video admission", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { await cleanup?.(); cleanup = undefined; });

  async function fixture() {
    const f = await maskFixtures();
    cleanup = () => {if(!path.resolve(f.dir).toLowerCase().startsWith(path.resolve((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/mask-fixture-").toLowerCase()))throw Error('Unexpected fixture directory');return rm(f.dir, { recursive: true, force: true });};
    const asset = async (id: string, project_id: string, file: string) => ({
      id, project_id, media_type: "video", content_type: "video/mp4", sha256: await fileSha256(file),
    });
    return { f, asset };
  }

  it("accepts a grayscale clip whose decoded dimensions, frames and timestamps match", async () => {
    const { f, asset } = await fixture();
    const receipt = await admitAlignedDepthVideo(await asset("source-id", "project-id", f.source), await asset("depth-id", "project-id", f.mask), f.source, f.mask, "project-id");
    expect(receipt).toMatchObject({ validationVersion: 1, sourceAssetId: "source-id", depthAssetId: "depth-id", width: 160, height: 96, fps: 16, frames: 17, depthEncoding: "grayscale_rgb8" });
    expect(receipt.timingDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects depth media with different dimensions or frame timing", async () => {
    const { f, asset } = await fixture();
    const wrongGeometry = await f.make("wrong-geometry", "color=c=gray:s=176x96:r=16");
    const wrongFrames = await f.make("wrong-frames", "color=c=gray:s=160x96:r=16", 21);
    const source = await asset("source-id", "project-id", f.source);
    await expect(admitAlignedDepthVideo(source, await asset("depth-id", "project-id", wrongGeometry), f.source, wrongGeometry, "project-id")).rejects.toThrow(/dimensions, frame count/);
    await expect(admitAlignedDepthVideo(source, await asset("depth-id", "project-id", wrongFrames), f.source, wrongFrames, "project-id")).rejects.toThrow(/dimensions, frame count/);
  });

  it("rejects color video, audio-bearing depth, cross-project assets and changed files", async () => {
    const { f, asset } = await fixture();
    const color = await f.make("color-depth", "color=c=red:s=160x96:r=16");
    const audio = path.join(f.dir, "audio-depth.mp4");
    await execute(process.env.FFMPEG_PATH ?? "ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=160x96:r=16", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=16000", "-frames:v", "17", "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", audio], { windowsHide: true, timeout: 15000 });
    await expect(admitAlignedDepthVideo(await asset("source-id", "project-id", f.source), await asset("depth-id", "project-id", color), f.source, color, "project-id")).rejects.toThrow(/grayscale/);
    await expect(admitAlignedDepthVideo(await asset("source-id", "project-id", f.source), await asset("depth-id", "project-id", audio), f.source, audio, "project-id")).rejects.toThrow(/must not contain audio/);
    await expect(admitAlignedDepthVideo(await asset("source-id", "other-project", f.source), await asset("depth-id", "other-project", f.mask), f.source, f.mask, "project-id")).rejects.toThrow(/this project/);
    const depth = await asset("depth-id", "project-id", f.mask);
    await expect(admitAlignedDepthVideo(await asset("source-id", "project-id", f.source), { ...depth, sha256: "0".repeat(64) }, f.source, f.mask, "project-id")).rejects.toThrow(/changed since upload/);
  });
  it("revalidates frozen depth identities and timeline before execution",async()=>{
    const {f,asset}=await fixture(),id=(n:number)=>`d4567890-0000-4000-8000-${String(n).padStart(12,'0')}`,project=id(3);
    const source=await asset(id(1),project,f.source),depth=await asset(id(2),project,f.mask),snapshot=await admitAlignedDepthVideo(source,depth,f.source,f.mask,project);
    const rows=[{...source,role:'source_video',storage_key:f.source},{...depth,role:'depth_video',storage_key:f.mask}],invocation={inputs:{source_video:source.id,depth_video:depth.id},depthAlignmentSnapshot:snapshot};
    await expect(verifyEffectInputs('vace-depth-restyle',invocation,rows,project,async key=>key)).resolves.toBeUndefined();
    await expect(verifyEffectInputs('vace-depth-restyle',{...invocation,depthAlignmentSnapshot:{...snapshot,timingDigest:'0'.repeat(64)}},rows,project,async key=>key)).rejects.toThrow('timeline changed');
    await expect(verifyEffectInputs('vace-depth-restyle',{...invocation,inputs:{...invocation.inputs,depth_video:id(9)}},rows,project,async key=>key)).rejects.toThrow('receipt');
    const original=await readFile(f.mask);await writeFile(f.mask,'changed');
    try{await expect(verifyEffectInputs('vace-depth-restyle',invocation,rows,project,async key=>key)).rejects.toThrow('changed since upload');}finally{await writeFile(f.mask,original);}
    await writeFile(f.source,'changed');
    await expect(verifyEffectInputs('vace-canny-restyle',invocation,rows,project,async key=>key)).rejects.toThrow('effect source changed');
  });
});
