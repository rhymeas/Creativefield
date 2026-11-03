import {execFile,spawnSync} from "node:child_process";
import {createReadStream} from "node:fs";
import {mkdir,mkdtemp,readdir,rm} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {DiskStore} from "../server/storage";
import {EXPORT_PROFILES,ExportProfileError,exportProfile,exportReadiness,exportVideo} from "../server/export-profiles";

const execute=promisify(execFile);
const binariesAvailable=spawnSync(process.env.FFMPEG_PATH??"ffmpeg",["-version"],{windowsHide:true}).status===0&&spawnSync(process.env.FFPROBE_PATH??"ffprobe",["-version"],{windowsHide:true}).status===0;

describe("export profile contract",()=>{
  it("publishes only immutable, exact mute-only MP4/H.264 profiles",()=>{
    expect(Object.keys(EXPORT_PROFILES)).toEqual(["mp4-h264-720p24","mp4-h264-1080p24"]);
    expect(EXPORT_PROFILES["mp4-h264-720p24"]).toMatchObject({version:1,width:1280,height:720,fps:24,container:"mp4",videoCodec:"h264",encoder:"libx264",pixelFormat:"yuv420p",sampleAspectRatio:"1:1",audio:"mute"});
    expect(EXPORT_PROFILES["mp4-h264-1080p24"]).toMatchObject({version:1,width:1920,height:1080,fps:24,container:"mp4",videoCodec:"h264",encoder:"libx264",pixelFormat:"yuv420p",sampleAspectRatio:"1:1",audio:"mute"});
    expect(Object.isFrozen(EXPORT_PROFILES)).toBe(true);
    expect(Object.values(EXPORT_PROFILES).every(Object.isFrozen)).toBe(true);
    expect(()=>exportProfile("mp4-h264-720p30")).toThrow(ExportProfileError);
    expect(()=>exportProfile("toString")).toThrow(ExportProfileError);
    expect(()=>exportProfile("constructor")).toThrow(ExportProfileError);
    expect(()=>exportProfile("__proto__")).toThrow(ExportProfileError);
  });

  it("reports profile-specific missing tools without requiring AAC",async()=>{
    const oldFfmpeg=process.env.FFMPEG_PATH,oldFfprobe=process.env.FFPROBE_PATH;
    process.env.FFMPEG_PATH="comfyfield-definitely-missing-ffmpeg";
    process.env.FFPROBE_PATH="comfyfield-definitely-missing-ffprobe";
    try{
      const report=await exportReadiness("mp4-h264-720p24");
      expect(report).toMatchObject({profileId:"mp4-h264-720p24",state:"install_required"});
      expect(report.missing).toContain("FFmpeg with the libx264 encoder");
      expect(report.missing).toContain("FFprobe");
      expect(report.instructions).toContain("do not require an audio encoder");
      expect(JSON.stringify(report)).not.toMatch(/AAC/i);
    }finally{
      if(oldFfmpeg===undefined)delete process.env.FFMPEG_PATH;else process.env.FFMPEG_PATH=oldFfmpeg;
      if(oldFfprobe===undefined)delete process.env.FFPROBE_PATH;else process.env.FFPROBE_PATH=oldFfprobe;
    }
  });
});

describe.skipIf(!binariesAvailable)("real mute-only export profiles",()=>{
  let root:string,source:string,store:DiskStore,workspaceId:string;
  beforeAll(async()=>{
    const parent=(process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-export-tests";
    await mkdir(parent,{recursive:true});
    root=await mkdtemp(path.join(parent,"attempt-"));
    workspaceId="164f1692-c56d-4a20-9841-c16e6f80ad31";
    store=new DiskStore(root,32*1024*1024);
    const fixture=path.join(root,"audio-bearing-source.mkv");
    // Audio deliberately outlasts the twelve video frames. Muting must use
    // the video stream's duration, not the longer container/audio duration.
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","testsrc2=s=320x180:r=30:d=0.4","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=0.8","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-c:a","pcm_s16le",fixture],{timeout:20_000,windowsHide:true});
    source=(await store.put(workspaceId,createReadStream(fixture))).key;
  },30_000);
  afterAll(async()=>{if(root)await rm(root,{recursive:true,force:true});});

  it("qualifies both installed profiles from a short audio-bearing source and cleans scratch",async()=>{
    const readiness=await exportReadiness("mp4-h264-720p24");
    expect(readiness.state,readiness.missing.join(", ")).toBe("ready");
    for(const id of ["mp4-h264-720p24","mp4-h264-1080p24"] as const){
      const result=await exportVideo(store,workspaceId,source,id,new AbortController().signal);
      expect(result.metadata).toMatchObject({contract:"comfyfield_export_v1",profile:EXPORT_PROFILES[id],width:EXPORT_PROFILES[id].width,height:EXPORT_PROFILES[id].height,container:"mp4",codec:"h264",pixelFormat:"yuv420p",fps:24,sampleAspectRatio:"1:1",hasAudio:false});
      expect(result.metadata).not.toHaveProperty("sourceKey");
      expect(result.metadata.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.metadata.frames).toBe(10);
      expect(result.metadata.durationSeconds).toBeCloseTo(result.metadata.frames/24,5);
      expect(result.key).not.toBe(source);
    }
    expect(await readdir(path.join(root,".exports"))).toEqual([]);
  },30_000);

  it("honors cancellation before encoding and leaves no candidate",async()=>{
    const controller=new AbortController();controller.abort();
    await expect(exportVideo(store,workspaceId,source,"mp4-h264-720p24",controller.signal)).rejects.toThrow("canceled or timed out");
    expect(await readdir(path.join(root,".exports"))).toEqual([]);
  });

  it("rejects invalid video input and still cleans its private attempt",async()=>{
    const {Readable}=await import("node:stream");
    const invalid=(await store.put(workspaceId,Readable.from("not a video"))).key;
    await expect(exportVideo(store,workspaceId,invalid,"mp4-h264-720p24",new AbortController().signal)).rejects.toThrow("Export failed");
    expect(await readdir(path.join(root,".exports"))).toEqual([]);
  });

  it("rejects an indirect concat input before it can consume a sibling asset",async()=>{
    const {Readable}=await import("node:stream");
    const siblingName=source.split("/")[1];
    const manifest=`ffconcat version 1.0\nfile '${siblingName}'\nduration 0.5\n`;
    const indirect=(await store.put(workspaceId,Readable.from(manifest))).key;
    await expect(exportVideo(store,workspaceId,indirect,"mp4-h264-720p24",new AbortController().signal)).rejects.toThrow("Export failed");
    expect(await readdir(path.join(root,".exports"))).toEqual([]);
  });

  it("rolls back an output when cancellation arrives during publication",async()=>{
    const before=await readdir(path.join(root,workspaceId)),controller=new AbortController();
    const abortingStore=Object.create(store) as DiskStore;
    abortingStore.put=async(workspace,stream)=>{const value=await store.put(workspace,stream);controller.abort();return value;};
    abortingStore.remove=store.remove.bind(store);
    await expect(exportVideo(abortingStore,workspaceId,source,"mp4-h264-720p24",controller.signal)).rejects.toThrow("canceled or timed out");
    expect((await readdir(path.join(root,workspaceId))).sort()).toEqual(before.sort());
    expect(await readdir(path.join(root,".exports"))).toEqual([]);
  },30_000);

  it("preserves anamorphic display aspect before producing square pixels",async()=>{
    const fixture=path.join(root,"anamorphic-source.mkv");
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","color=c=red:s=320x240:r=24:d=0.25","-vf","setsar=2/1","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-an",fixture],{timeout:20_000,windowsHide:true});
    const anamorphic=(await store.put(workspaceId,createReadStream(fixture))).key;
    const result=await exportVideo(store,workspaceId,anamorphic,"mp4-h264-720p24",new AbortController().signal),file=await store.file(workspaceId,result.key);
    const pixel=async(y:number)=>(await execute(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-i",file,"-vf",`crop=2:2:640:${y},scale=1:1`,"-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","pipe:1"],{encoding:"buffer",timeout:20_000,windowsHide:true})).stdout as Buffer;
    expect((await pixel(10))[0]).toBeLessThan(20);
    expect((await pixel(360))[0]).toBeGreaterThan(200);
  },30_000);
});
