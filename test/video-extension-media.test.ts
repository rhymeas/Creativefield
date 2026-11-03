import {afterAll,beforeAll,describe,it,expect} from "vitest";
import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {promisify} from "node:util";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";
import {DiskStore} from "../server/storage";
import {inspectVideoSource,videoExtensionReadiness} from "../server/video-extension-media";
import {planVideoExtension} from "../server/video-extension-plan";
import {stitchVideoExtension} from "../server/video-stitch";

const execute=promisify(execFile),workspace="11111111-1111-4111-8111-111111111111",project="22222222-2222-4222-8222-222222222222",asset="33333333-3333-4333-8333-333333333333";
const attempt=()=>({attemptId:randomUUID(),candidateId:randomUUID()});
describe("video extension FFmpeg contract",()=>{
  let root:string,source:string,child:string,store:DiskStore,sourceKey:string,childKey:string;
  beforeAll(async()=>{
    root=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-video-extension-");source=path.join(root,"source.mp4");child=path.join(root,"child.mp4");store=new DiskStore(path.join(root,"store"),20*1024*1024);
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","color=c=red:s=512x320:r=16:d=0.5","-f","lavfi","-i","color=c=green:s=512x320:r=16:d=0.5","-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0[v]","-map","[v]","-c:v","libx264","-pix_fmt","yuv420p","-an",source],{windowsHide:true});
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","color=c=green:s=512x320:r=16:d=0.3125","-f","lavfi","-i","color=c=blue:s=512x320:r=16:d=0.75","-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0[v]","-map","[v]","-frames:v","17","-c:v","libx264","-pix_fmt","yuv420p","-an",child],{windowsHide:true});
    const a=await store.put(workspace,(await import("node:fs")).createReadStream(source)),b=await store.put(workspace,(await import("node:fs")).createReadStream(child));sourceKey=a.key;childKey=b.key;
  }, 120000);
  afterAll(async()=>{if(root)await rm(root,{recursive:true,force:true});});
  it("hashes and probes the exact source envelope",async()=>{
    const ready=await videoExtensionReadiness();expect(ready.state,ready.missing.join(", ")).toBe("ready");
    const envelope=await inspectVideoSource(source,{sourceAssetId:asset,projectId:project});expect(envelope).toMatchObject({width:512,height:320,frameRate:{numerator:16,denominator:1},frameCount:16,hasAudio:false});expect(envelope.timestampDigest).toMatch(/^[a-f0-9]{64}$/);
  },15000);
  it("trims and stitches exact frame counts while dropping overlap",async()=>{
    const envelope=await inspectVideoSource(await store.file(workspace,sourceKey),{sourceAssetId:asset,projectId:project});
    const trim=planVideoExtension({contractVersion:1,projectId:project,sourceAssetId:asset,startFrame:4,endFrameExclusive:12,extensionFrames:0,overlapFrames:0},envelope),trimmed=await stitchVideoExtension(store,workspace,sourceKey,trim,null,new AbortController().signal,attempt());
    expect(trimmed.metadata.output).toMatchObject({frames:8,hasAudio:false});
    const extend=planVideoExtension({contractVersion:1,projectId:project,sourceAssetId:asset,startFrame:0,endFrameExclusive:16,extensionFrames:10,overlapFrames:5},envelope),stitched=await stitchVideoExtension(store,workspace,sourceKey,extend,childKey,new AbortController().signal,attempt());
    expect(stitched.metadata.output).toMatchObject({frames:26,hasAudio:false});expect(stitched.metadata).toMatchObject({planDigest:extend.planDigest,operation:"forward_extend"});
    const output=await store.file(workspace,stitched.key);
    for(const [time,channel,minimum] of [[0.25,0,150],[0.75,1,70],[1.25,2,150]] as const){const pixel=(await execute(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-ss",String(time),"-i",output,"-frames:v","1","-vf","scale=1:1","-pix_fmt","rgb24","-f","rawvideo","pipe:1"],{encoding:"buffer",windowsHide:true})) as unknown as {stdout:Buffer};expect(pixel.stdout[channel]).toBeGreaterThan(minimum);}
  }, 120000);
  it("rejects variable frame rate and source tampering",async()=>{
    const vfr=path.join(root,"vfr.mp4");await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-i",source,"-vf","setpts=if(lt(N\\,8)\\,N/(16*TB)\\,(N+1)/(16*TB))","-fps_mode","vfr","-c:v","libx264","-an",vfr],{windowsHide:true});
    await expect(inspectVideoSource(vfr,{sourceAssetId:asset,projectId:project})).rejects.toThrow();
    const envelope=await inspectVideoSource(await store.file(workspace,sourceKey),{sourceAssetId:asset,projectId:project}),plan=planVideoExtension({contractVersion:1,projectId:project,sourceAssetId:asset,startFrame:0,endFrameExclusive:8,extensionFrames:0,overlapFrames:0},envelope);
    plan.source.sha256="f".repeat(64);await expect(stitchVideoExtension(store,workspace,sourceKey,plan,null,new AbortController().signal,attempt())).rejects.toThrow("changed");
  }, 120000);
  it("preserves source audio on trim and refuses it for silent sources",async()=>{
    const withAudio=path.join(root,"with-audio.mp4");
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","color=c=red:s=512x320:r=16:d=1","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=1","-map","0:v","-map","1:a","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest",withAudio],{windowsHide:true});
    const stored=await store.put(workspace,(await import("node:fs")).createReadStream(withAudio)),envelope=await inspectVideoSource(await store.file(workspace,stored.key),{sourceAssetId:asset,projectId:project});
    expect(envelope).toMatchObject({frameCount:16,hasAudio:true});expect(envelope.audioSeconds).toBeCloseTo(1,1);
    const preserve=planVideoExtension({contractVersion:1,projectId:project,sourceAssetId:asset,startFrame:4,endFrameExclusive:12,extensionFrames:0,overlapFrames:0,audioPolicy:"preserve"},envelope),trimmed=await stitchVideoExtension(store,workspace,stored.key,preserve,null,new AbortController().signal,attempt());
    expect(trimmed.metadata.output).toMatchObject({frames:8,hasAudio:true});expect(trimmed.metadata.output).toMatchObject({audioPolicy:"preserve"});
    const output=await store.file(workspace,trimmed.key);
    const volume=async(file:string,start:string)=>{const result=await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-nostdin","-ss",start,"-t","0.2","-i",file,"-af","volumedetect","-f","null","-"],{windowsHide:true}),match=/mean_volume: (-?\d+(?:\.\d+)?) dB/.exec(String(result.stderr));return match?Number(match[1]):null;};
    expect(await volume(output,"0.2")).toBeGreaterThan(-60);
    const extend=planVideoExtension({contractVersion:1,projectId:project,sourceAssetId:asset,startFrame:0,endFrameExclusive:16,extensionFrames:10,overlapFrames:5,audioPolicy:"preserve"},envelope),stitched=await stitchVideoExtension(store,workspace,stored.key,extend,childKey,new AbortController().signal,attempt());
    expect(stitched.metadata.output).toMatchObject({frames:26,hasAudio:true});expect(stitched.metadata.output).toMatchObject({audioPolicy:"preserve"});
    const extended=await store.file(workspace,stitched.key);expect(await volume(extended,"0.2")).toBeGreaterThan(-60);expect(await volume(extended,"1.0")).toBeLessThan(-60);
    const mute=planVideoExtension({contractVersion:1,projectId:project,sourceAssetId:asset,startFrame:0,endFrameExclusive:8,extensionFrames:0,overlapFrames:0},envelope),muted=await stitchVideoExtension(store,workspace,stored.key,mute,null,new AbortController().signal,attempt());
    expect(muted.metadata.output).toMatchObject({frames:8,hasAudio:false});
    const silentEnvelope=await inspectVideoSource(await store.file(workspace,sourceKey),{sourceAssetId:asset,projectId:project});
    expect(()=>planVideoExtension({contractVersion:1,projectId:project,sourceAssetId:asset,startFrame:0,endFrameExclusive:8,extensionFrames:0,overlapFrames:0,audioPolicy:"preserve"},silentEnvelope)).toThrow("no audio stream to preserve");
  }, 120000);
  it("trims a constant 24 FPS source and normalizes output to 16 FPS",async()=>{
    const phone=path.join(root,"phone-24.mp4");
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","color=c=blue:s=512x320:r=24:d=2","-c:v","libx264","-pix_fmt","yuv420p","-an",phone],{windowsHide:true});
    const stored=await store.put(workspace,(await import("node:fs")).createReadStream(phone)),envelope=await inspectVideoSource(await store.file(workspace,stored.key),{sourceAssetId:asset,projectId:project});
    expect(envelope).toMatchObject({width:512,height:320,frameRate:{numerator:24,denominator:1},frameCount:48,hasAudio:false});
    const plan=planVideoExtension({contractVersion:1,projectId:project,sourceAssetId:asset,startFrame:0,endFrameExclusive:24,extensionFrames:0,overlapFrames:0},envelope);
    expect(plan.output.frames).toBe(16);expect(plan.output.frameRate).toEqual({numerator:16,denominator:1});
    const trimmed=await stitchVideoExtension(store,workspace,stored.key,plan,null,new AbortController().signal,attempt());
    expect(trimmed.metadata.output).toMatchObject({frames:16,hasAudio:false});
    const facts=await inspectVideoSource(await store.file(workspace,trimmed.key),{sourceAssetId:asset,projectId:project});
    expect(facts).toMatchObject({frameRate:{numerator:16,denominator:1},frameCount:16});
  }, 120000);
  it("preserves fractional source FPS and audio for quick trim",async()=>{
    const input=path.join(root,"fractional-with-audio.mp4");
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","testsrc2=s=512x320:r=30000/1001:d=1","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=1","-map","0:v","-map","1:a","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest",input],{windowsHide:true});
    const stored=await store.put(workspace,(await import("node:fs")).createReadStream(input)),envelope=await inspectVideoSource(await store.file(workspace,stored.key),{sourceAssetId:asset,projectId:project});
    const plan=planVideoExtension({contractVersion:1,projectId:project,sourceAssetId:asset,startFrame:5,endFrameExclusive:25,extensionFrames:0,overlapFrames:0,audioPolicy:"preserve",preserveFrameRate:true},envelope);
    const trimmed=await stitchVideoExtension(store,workspace,stored.key,plan,null,new AbortController().signal,attempt());
    const facts=await inspectVideoSource(await store.file(workspace,trimmed.key),{sourceAssetId:asset,projectId:project});
    expect(facts.frameRate).toEqual({numerator:30000,denominator:1001});expect(facts.frameCount).toBe(20);expect(facts.hasAudio).toBe(true);expect(facts.audioSeconds).toBeCloseTo(20*1001/30000,1);
  },120000);
});
