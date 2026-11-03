import {beforeAll,describe,it,expect} from "vitest";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {copyFile,mkdir,readdir,readFile,symlink,writeFile} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {Readable} from "node:stream";
import path from "node:path";
import {
  inspectMotionVideo,MAX_MOTION_FRAMES,motionMediaReadiness,motionReceiptSchema,
  normalizeMotionInput,verifyMotionOutput,withMotionInspection,motionNormalizationSchema,MOTION_NORMALIZATION,
} from "../server/motion-media";
import {DiskStore} from "../server/storage";
import {expectedTimingDigest,motionFixtures} from "./motion-fixtures";
const execute=promisify(execFile);
describe("strict 24-CFR motion media",()=>{
  it("retains legacy normalization receipts while declaring limited-range conversion for new ones",()=>{
    const {colorRange,...legacy}=MOTION_NORMALIZATION as typeof MOTION_NORMALIZATION&{colorRange?:string};
    expect(motionNormalizationSchema.parse({...legacy,version:"motion-normalize-v1"}).version).toBe("motion-normalize-v1");
    expect(colorRange).toBe("tv");expect(MOTION_NORMALIZATION.version).toBe("motion-normalize-v2");
    expect(()=>motionNormalizationSchema.parse({...legacy,version:"motion-normalize-v2"})).toThrow();
  });
  let f:Awaited<ReturnType<typeof motionFixtures>>,ready=false;
  beforeAll(async()=>{ready=(await motionMediaReadiness()).state==="ready";if(ready)f=await motionFixtures();},120000);
  const needsTools=({skip}:{skip:(message?:string)=>void})=>{if(!ready)skip("FFmpeg/FFprobe with libx264 unavailable");};
  async function scratchEntries(){
    try{return await readdir(path.join(f.store.root,".motion-media"));}catch{return [];}
  }
  async function probeJson(file:string,args:string[]){
    const result=await execute(process.env.FFPROBE_PATH??"ffprobe",["-v","error",...args,"-of","json",file],{windowsHide:true,timeout:30000});
    return JSON.parse(String(result.stdout));
  }
  async function firstFrameMd5(file:string){
    const result=await execute(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-i",file,"-frames:v","1","-f","md5","-"],{windowsHide:true,timeout:30000});
    return String(result.stdout).trim();
  }
  it("bounds concurrent motion media work",async()=>{
    let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
    const first=withMotionInspection(()=>held),second=withMotionInspection(()=>held);
    await expect(withMotionInspection(async()=>undefined)).rejects.toMatchObject({statusCode:429});
    release();await Promise.all([first,second]);
  });
  it("reports toolchain readiness with versions",async(ctx)=>{
    needsTools(ctx);const readiness=await motionMediaReadiness();
    expect(readiness.state).toBe("ready");expect(readiness.ffmpegVersion).toContain("ffmpeg version");
    expect(readiness.missing).toEqual([]);
  });
  it("rejects non-DiskStore keys and paths before processing",async(ctx)=>{
    needsTools(ctx);
    for(const key of ["../escape",(process.env.SystemRoot ?? process.env.WINDIR ?? "C:") + "/win.ini",`${f.workspaceId}/not-a-uuid`,`${"0".repeat(8)}-0000-0000-0000-000000000000/${"0".repeat(8)}-0000-0000-0000-000000000000`])
      await expect(normalizeMotionInput(f.store,f.workspaceId,key)).rejects.toThrow();
    await expect(verifyMotionOutput({file:"relative/candidate.mp4",ownedRoot:f.dir},{width:160,height:96,decodedFrameCount:48})).rejects.toThrow();
    expect(await scratchEntries()).toEqual([]);
  });
  it("normalizes already-24-CFR input with an exact frozen receipt and leaves the source untouched",async(ctx)=>{
    needsTools(ctx);const source=await f.makeStored("cfr24","testsrc2=size=160x96:rate=24",48);
    const receipt=await normalizeMotionInput(f.store,f.workspaceId,source.key);
    expect(receipt).toMatchObject({schema:"comfyfield/motion-media-receipt",version:1,width:160,height:96,decodedFrameCount:48,fps:24,
      rFrameRate:"24/1",avgFrameRate:"24/1",durationSeconds:2,startTimeSeconds:0,firstFramePtsMicroseconds:0,sampleAspectRatio:"1:1",
      rotationDegrees:0,hasAudio:false,streamCount:1,codec:"h264",container:"mp4",pixelFormat:"yuv420p",sourceSha256:source.sha256});
    expect(receipt.durationRational).toEqual({numerator:48,denominator:24});
    expect(receipt.timingDigest).toBe(expectedTimingDigest(48));
    expect(Object.isFrozen(receipt)&&Object.isFrozen(receipt.normalization)&&Object.isFrozen(receipt.durationRational)).toBe(true);
    expect(motionReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(()=>motionReceiptSchema.parse({...receipt,fps:30})).toThrow();
    expect(await f.sha256(await f.store.file(f.workspaceId,source.key))).toBe(source.sha256);
    const verified=await verifyMotionOutput({store:f.store,workspaceId:f.workspaceId,key:receipt.normalizedKey},receipt);
    expect(verified.sha256).toBe(receipt.normalizedSha256);
    const frames=await probeJson(await f.store.file(f.workspaceId,receipt.normalizedKey),["-select_streams","v:0","-show_frames","-show_entries","frame=best_effort_timestamp_time"]);
    expect(frames.frames.map((frame:any)=>Math.round(Number(frame.best_effort_timestamp_time)*1000000)))
      .toEqual(Array.from({length:48},(_,i)=>Math.round(i*1000000/24)));
    expect(await scratchEntries()).toEqual([]);
  },120000);
  it("normalizes full-range camera input into strict limited-range yuv420p",async(ctx)=>{
    needsTools(ctx);
    const full=await f.makeStored("full-range","testsrc2=size=160x96:rate=24",48,["-vf","scale=in_range=tv:out_range=pc","-color_range","pc"]);
    const result=await normalizeMotionInput(f.store,f.workspaceId,full.key),file=await f.store.file(f.workspaceId,result.normalizedKey);
    expect(result).toMatchObject({pixelFormat:"yuv420p",normalization:{version:"motion-normalize-v2",colorRange:"tv"}});
    const sourceHeader=await probeJson(full.file,["-show_streams"]);expect(sourceHeader.streams[0].color_range).toBe("pc");
    const header=await probeJson(file,["-show_streams"]);expect(header.streams[0].pix_fmt).toBe("yuv420p");expect(header.streams[0].color_range).not.toBe("pc");
    // Limited range can be implicit in H.264. Compare decoded RGB too: merely
    // retagging full-range samples as limited would change contrast.
    const rgb=async(filename:string)=>(await execute(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-i",filename,"-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","-"],{encoding:"buffer",windowsHide:true,timeout:30000,maxBuffer:160*96*3+1024})).stdout;
    const [before,after]=await Promise.all([rgb(full.file),rgb(file)]);expect(after.length).toBe(before.length);let difference=0;for(let i=0;i<before.length;i++)difference+=Math.abs(before[i]-after[i]);expect(difference/before.length).toBeLessThan(4);
    expect((await inspectMotionVideo(file)).decodedFrameCount).toBe(48);
  },120000);
  it("converts 30 FPS and VFR input to exact 24 CFR and removes audio",async(ctx)=>{
    needsTools(ctx);
    const fps30=await f.makeStored("fps30","testsrc2=size=160x96:rate=30",60);
    const converted=await normalizeMotionInput(f.store,f.workspaceId,fps30.key);
    expect(converted.decodedFrameCount).toBeGreaterThanOrEqual(47);expect(converted.decodedFrameCount).toBeLessThanOrEqual(49);
    expect(converted.timingDigest).toBe(expectedTimingDigest(converted.decodedFrameCount));
    const vfr=await f.make("vfr","testsrc2=size=160x96:rate=30,select=not(eq(n\\,10)+eq(n\\,25))",60,["-fps_mode","vfr"]);
    const vfrStored=await f.put(await f.withAudio("vfr-audio",vfr));
    const fromVfr=await normalizeMotionInput(f.store,f.workspaceId,vfrStored.key);
    expect(fromVfr.hasAudio).toBe(false);expect(fromVfr.timingDigest).toBe(expectedTimingDigest(fromVfr.decodedFrameCount));
    const verified=await verifyMotionOutput({file:await f.store.file(f.workspaceId,fromVfr.normalizedKey),ownedRoot:path.join(f.store.root,f.workspaceId)},fromVfr);
    expect(verified.decodedFrameCount).toBe(fromVfr.decodedFrameCount);
  },120000);
  it("resets nonzero timestamps and bakes supported rotation while stripping metadata",async(ctx)=>{
    needsTools(ctx);
    const offset=await f.makeStored("offset","testsrc2=size=160x96:rate=24",48,["-output_ts_offset","2"]);
    expect((await normalizeMotionInput(f.store,f.workspaceId,offset.key)).firstFramePtsMicroseconds).toBe(0);
    const base=await f.make("rotate-base","testsrc2=size=160x96:rate=24",48);
    const rotatedFile=await f.rotated("rotated90",base),rotated=await f.put(rotatedFile);
    const receipt=await normalizeMotionInput(f.store,f.workspaceId,rotated.key);
    expect(receipt).toMatchObject({width:96,height:160,rotationDegrees:0});
    const autorotateReference=path.join(f.dir,"autorotate-reference.mp4");
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-y","-i",rotatedFile,
      "-vf","setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,fps=fps=24:start_time=0:round=near:eof_action=pass,setpts=N/(24*TB),format=yuv420p",
      "-an","-sn","-dn","-c:v","libx264","-threads","1","-preset","veryfast","-crf","18","-pix_fmt","yuv420p",autorotateReference],
      {windowsHide:true,timeout:60000});
    expect(await firstFrameMd5(await f.store.file(f.workspaceId,receipt.normalizedKey))).toBe(await firstFrameMd5(autorotateReference));
    const sarRotated=await f.put(await f.sarAndRotated("rotated-sar",base));
    const sarReceipt=await normalizeMotionInput(f.store,f.workspaceId,sarRotated.key);
    expect(sarReceipt).toMatchObject({width:96,height:320,sampleAspectRatio:"1:1",rotationDegrees:0});
    const header=await probeJson(await f.store.file(f.workspaceId,receipt.normalizedKey),["-show_streams","-show_format"]);
    expect(header.format?.tags?.title).toBeUndefined();
    expect(header.streams[0].tags?.rotate).toBeUndefined();
  },120000);
  it("produces a deterministic receipt for identical bytes and settings apart from the new storage key",async(ctx)=>{
    needsTools(ctx);const source=await f.makeStored("deterministic","testsrc2=size=160x96:rate=24",48);
    const first=await normalizeMotionInput(f.store,f.workspaceId,source.key);
    const second=await normalizeMotionInput(f.store,f.workspaceId,source.key);
    const strip=({normalizedKey:_,...rest}:typeof first)=>rest;
    expect(strip(second)).toEqual(strip(first));expect(second.normalizedKey).not.toBe(first.normalizedKey);
  },120000);
  it("rejects corrupt, oversize, playlist and over-length sources and cleans scratch",async(ctx)=>{
    needsTools(ctx);
    const corrupt=await f.store.put(f.workspaceId,Readable.from(Buffer.from("not media")));
    await expect(normalizeMotionInput(f.store,f.workspaceId,corrupt.key)).rejects.toThrow();
    const playlist=path.join(f.dir,"playlist.mp4");await writeFile(playlist,"ffconcat version 1.0\nfile 'cfr24.mp4'\n");
    await expect(normalizeMotionInput(f.store,f.workspaceId,(await f.put(playlist)).key)).rejects.toThrow();
    const smallStore=new DiskStore(f.store.root,1024);
    const valid=await f.makeStored("oversize","testsrc2=size=160x96:rate=24",48);
    await expect(normalizeMotionInput(smallStore,f.workspaceId,valid.key)).rejects.toThrow(/size limit/);
    const long=await f.makeStored("too-long","color=c=black:s=64x64:r=24",MAX_MOTION_FRAMES+24);
    await expect(normalizeMotionInput(f.store,f.workspaceId,long.key)).rejects.toThrow();
    expect(await scratchEntries()).toEqual([]);
  },180000);
  it("honours cancellation, removes scratch and does not publish",async(ctx)=>{
    needsTools(ctx);const source=await f.makeStored("cancel","testsrc2=size=160x96:rate=24",48);
    const dir=path.join(f.store.root,f.workspaceId),before=await readdir(dir);
    const control=new AbortController();control.abort();
    await expect(normalizeMotionInput(f.store,f.workspaceId,source.key,control.signal)).rejects.toThrow();
    expect(await readdir(dir)).toEqual(before);expect(await scratchEntries()).toEqual([]);
    const duringPut=new AbortController();
    class AbortingStore extends DiskStore{
      override async put(workspaceId:string,stream:Parameters<DiskStore["put"]>[1]){
        const candidate=await super.put(workspaceId,stream);duringPut.abort();return candidate;
      }
    }
    await expect(normalizeMotionInput(new AbortingStore(f.store.root,f.store.maxBytes),f.workspaceId,source.key,duringPut.signal)).rejects.toThrow();
    expect(await readdir(dir)).toEqual(before);expect(await scratchEntries()).toEqual([]);
  },120000);
  it("rejects a source replaced during normalization and does not publish it",async(ctx)=>{
    needsTools(ctx);
    const heavy=await f.make("tamper","testsrc2=size=640x360:rate=24",240),other=await f.make("tamper-other","color=c=white:s=640x360:r=24",240);
    const stored=await f.put(heavy),storedFile=await f.store.file(f.workspaceId,stored.key);
    const before=await readdir(path.join(f.store.root,f.workspaceId));
    class TamperingStore extends DiskStore{
      private fileCalls=0;
      override async file(workspaceId:string,key:string){
        const filename=await super.file(workspaceId,key);
        this.fileCalls++;
        if(this.fileCalls===2)await copyFile(other,storedFile);
        return filename;
      }
    }
    const tamperingStore=new TamperingStore(f.store.root,f.store.maxBytes);
    await expect(normalizeMotionInput(tamperingStore,f.workspaceId,stored.key)).rejects.toThrow(/changed during normalization/);
    expect(await readdir(path.join(f.store.root,f.workspaceId))).toEqual(before);expect(await scratchEntries()).toEqual([]);
  },180000);
  it("rejects outputs with wrong rate, count, dimensions, audio, timestamps or digest",async(ctx)=>{
    needsTools(ctx);const source=await f.makeStored("verify-base","testsrc2=size=160x96:rate=24",48);
    const receipt=await normalizeMotionInput(f.store,f.workspaceId,source.key);
    const normalized=await f.store.file(f.workspaceId,receipt.normalizedKey);
    const owned={file:normalized,ownedRoot:path.join(f.store.root,f.workspaceId)};
    await expect(verifyMotionOutput(owned,{...receipt,decodedFrameCount:receipt.decodedFrameCount+1})).rejects.toThrow();
    await expect(verifyMotionOutput(owned,{...receipt,width:receipt.width+16})).rejects.toThrow();
    await expect(verifyMotionOutput(owned,{...receipt,sha256:"0".repeat(64)})).rejects.toThrow();
    const fps30=await f.make("verify-30","testsrc2=size=160x96:rate=30",60);
    await expect(verifyMotionOutput({file:fps30,ownedRoot:f.dir},{width:160,height:96,decodedFrameCount:60})).rejects.toThrow();
    await expect(verifyMotionOutput({file:await f.withAudio("verify-audio",normalized),ownedRoot:f.dir},receipt)).rejects.toThrow();
    const offset=await f.make("verify-offset","testsrc2=size=160x96:rate=24",48,["-output_ts_offset","1"]);
    await expect(inspectMotionVideo(offset)).rejects.toThrow();
    const before=await readFile(normalized);
    await verifyMotionOutput(owned,receipt);expect(await readFile(normalized)).toEqual(before);
    const outside=path.join(f.dir,"outside-root"),junction=path.join(f.dir,"owned-root","escape"),outsideFile=path.join(outside,"candidate.mp4");
    await mkdir(path.dirname(junction),{recursive:true});await mkdir(outside,{recursive:true});await copyFile(normalized,outsideFile);
    await symlink(outside,junction,"junction");
    await expect(verifyMotionOutput({file:path.join(junction,"candidate.mp4"),ownedRoot:path.dirname(junction)},receipt)).rejects.toThrow(/escapes its owned root/);
    void createReadStream;
  },180000);
});
