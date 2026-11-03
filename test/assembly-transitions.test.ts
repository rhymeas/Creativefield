import {describe, expect, it} from "vitest";
import {mkdtemp, rm} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import os from "node:os";
import path from "node:path";
import {assembleVideo, assemblySchema, AssemblyError} from "../server/assembly";
import {DiskStore} from "../server/storage";
import {keyframeShotTiming} from "../server/keyframe-storyboard";
import {buildCatalogue} from "../src/capabilities/catalogue";
import {providers} from "../src/pipelines/registry";
import h3Manifest from "../native-workflows/h3-flf2v/manifest.json";
import type {CapabilityManifestV2} from "../src/capabilities/types";

const execute = promisify(execFile);
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

async function silentClip(dir: string, name: string, seconds: number, colour: string) {
  // A real clip with no audio, so the assembly paths can be exercised without a worker.
  await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=320x180:r=24:d=${seconds}`, "-pix_fmt", "yuv420p", path.join(dir, name)]);
  return path.join(dir, name);
}

describe("storyboard assembly transitions", () => {
  it("accepts a cross-fade setting and rejects nonsense", () => {
    expect(assemblySchema.parse({width: 320, height: 180, fps: 24, audioPolicy: "mute"}).transition).toBeUndefined();
    expect(assemblySchema.parse({width: 320, height: 180, fps: 16, audioPolicy: "mute"}).fps).toBe(16);
    expect(assemblySchema.parse({width: 320, height: 180, fps: 24, audioPolicy: "mute", transition: {kind: "crossfade", seconds: 0.5}}).transition).toEqual({kind: "crossfade", seconds: 0.5});
    expect(() => assemblySchema.parse({width: 320, height: 180, fps: 24, audioPolicy: "mute", transition: {kind: "crossfade", seconds: 0}})).toThrow();
    expect(() => assemblySchema.parse({width: 320, height: 180, fps: 24, audioPolicy: "mute", transition: {kind: "wipe", seconds: 0.5}})).toThrow();
  });

  it("joins two shots with a cross-fade, shortening the film by the overlap", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "assembly-fade-"));
    const store = new DiskStore(path.join(dir, "storage"), 40 * 1024 * 1024);
    try {
      const first = await store.put(WORKSPACE, (await import("node:fs")).createReadStream(await silentClip(dir, "a.mp4", 1, "red")));
      const second = await store.put(WORKSPACE, (await import("node:fs")).createReadStream(await silentClip(dir, "b.mp4", 1, "blue")));
      const result = await assembleVideo(store, WORKSPACE,
        [{key: first.key, frames: 24}, {key: second.key, frames: 24}],
        {width: 320, height: 180, fps: 24, audioPolicy: "mute", transition: {kind: "crossfade", seconds: 0.5}},
        new AbortController().signal);
      // Two 1 s shots with a 0.5 s dissolve: 1.5 s of film, not 2 s.
      expect(result.metadata.frames).toBe(36);
      expect(result.metadata.durationSeconds).toBeGreaterThan(1.35);
      expect(result.metadata.durationSeconds).toBeLessThan(1.65);
      expect(result.metadata.assembly.transition).toEqual({kind: "crossfade", seconds: 0.5});
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  }, 120000);

  it("can omit the shared first frame of a later keyframe segment", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "assembly-keyframe-"));
    const store = new DiskStore(path.join(dir, "storage"), 40 * 1024 * 1024);
    try {
      const first = await store.put(WORKSPACE, (await import("node:fs")).createReadStream(await silentClip(dir, "first.mp4", 1, "red")));
      const native=await assembleVideo(store,WORKSPACE,[{key:first.key,frames:16}],{width:320,height:180,fps:16,audioPolicy:"mute"},new AbortController().signal);
      expect(native.metadata.frames).toBe(16);
      const secondPath=path.join(dir,"second.mp4");
      await execute("ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=red:s=320x180:r=24:d=0.041667","-f","lavfi","-i","color=blue:s=320x180:r=24:d=0.958333","-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0[v]","-map","[v]","-pix_fmt","yuv420p",secondPath]);
      const second=await store.put(WORKSPACE,(await import("node:fs")).createReadStream(secondPath));
      const result=await assembleVideo(store,WORKSPACE,[{key:first.key,frames:24},{key:second.key,startFrame:1,frames:23}],{width:320,height:180,fps:24,audioPolicy:"mute"},new AbortController().signal);
      expect(result.metadata.frames).toBe(47);
      const file=await store.file(WORKSPACE,result.key);
      const {stdout}=await execute("ffmpeg",["-hide_banner","-loglevel","error","-i",file,"-vf","select=eq(n\\,24),scale=1:1","-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],{encoding:"buffer"});
      const pixel=Buffer.from(stdout);expect(pixel[2]).toBeGreaterThan(pixel[0]);
    } finally {await rm(dir,{recursive:true,force:true});}
  }, 120000);

  it.each([[2,2,2],[2,3,4]])("retains four keyframes with segment durations %s, %s and %s seconds", async (firstSeconds, secondSeconds, thirdSeconds) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "assembly-four-keys-"));
    const store = new DiskStore(path.join(dir, "storage"), 40 * 1024 * 1024);
    const model = buildCatalogue(providers).find(item => item.manifest.id === "wan22-flf2v-14b")!.manifest;
    try {
      const images = ["a", "b", "c", "d"];
      const colors = ["red", "green", "blue", "white"];
      const durations = [firstSeconds, secondSeconds, thirdSeconds];
      const positions = [0, firstSeconds*16, (firstSeconds+secondSeconds)*16, (firstSeconds+secondSeconds+thirdSeconds)*16];
      const clips = [];
      for (let index = 0; index < 3; index++) {
        const timing = keyframeShotTiming(model, durations[index], 16, index, {start_image:images[index],end_image:images[index+1]}, `segment ${index+1}`, index ? images[index] : undefined);
        const clip = path.join(dir, `segment-${index}.mp4`);
        await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${colors[index]}:s=320x180:r=16`, "-vf", `drawbox=x=0:y=0:w=iw:h=ih:color=${colors[index+1]}:t=fill:enable=eq(n\\,${durations[index]*16})`, "-frames:v", String(timing.generationFrames), "-pix_fmt", "yuv420p", clip]);
        const stored = await store.put(WORKSPACE, (await import("node:fs")).createReadStream(clip));
        clips.push({key:stored.key,frames:timing.frames,startFrame:timing.assemblyStartFrame});
      }
      const result = await assembleVideo(store, WORKSPACE, clips, {width:320,height:180,fps:16,audioPolicy:"mute"}, new AbortController().signal);
      expect(result.metadata.frames).toBe(positions[3]+1);
      const output = await store.file(WORKSPACE, result.key);
      for (const [frame,channel] of [[positions[0],0],[positions[1],1],[positions[2],2],[positions[3],-1]] as const) {
        const {stdout} = await execute("ffmpeg", ["-hide_banner","-loglevel","error","-i",output,"-vf",`select=eq(n\\,${frame}),scale=1:1`,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"], {encoding:"buffer"});
        const pixel = Buffer.from(stdout);
        expect(pixel).toHaveLength(3);
        if(channel===-1) expect(Math.min(...pixel)).toBeGreaterThan(200);
        else expect(pixel[channel]).toBeGreaterThan(Math.max(pixel[(channel+1)%3],pixel[(channel+2)%3])+30);
      }
    } finally {await rm(dir,{recursive:true,force:true});}
  }, 120000);

  it("keeps unequal H3 keyframe boundaries on their exact frames", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "assembly-h3-keys-"));
    const store = new DiskStore(path.join(dir, "storage"), 40 * 1024 * 1024);
    const model = h3Manifest as unknown as CapabilityManifestV2;
    const images = ["a", "b", "c", "d"], colors = ["red", "green", "blue", "white"];
    const spans = [38, 55, 72], positions = [0, 38, 93, 165], clips = [];
    try {
      for (let index = 0; index < spans.length; index++) {
        const timing = keyframeShotTiming(model, spans[index]/24, 24, index, {start_image:images[index],end_image:images[index+1]}, `segment ${index+1}`, index ? images[index] : undefined);
        const clip = path.join(dir, `segment-${index}.mp4`);
        await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${colors[index]}:s=320x180:r=24`, "-vf", `drawbox=x=0:y=0:w=iw:h=ih:color=${colors[index+1]}:t=fill:enable=eq(n\\,${spans[index]})`, "-frames:v", String(timing.generationFrames), "-pix_fmt", "yuv420p", clip]);
        const stored = await store.put(WORKSPACE, (await import("node:fs")).createReadStream(clip));
        clips.push({key:stored.key,frames:timing.frames,startFrame:timing.assemblyStartFrame});
      }
      const result = await assembleVideo(store, WORKSPACE, clips, {width:320,height:180,fps:24,audioPolicy:"mute",keyframeBoundaries:true}, new AbortController().signal);
      expect(result.metadata.frames).toBe(positions[3]+1);
      const output = await store.file(WORKSPACE, result.key);
      for (const [frame,channel] of [[positions[0],0],[positions[1],1],[positions[2],2],[positions[3],-1]] as const) {
        const {stdout} = await execute("ffmpeg", ["-hide_banner","-loglevel","error","-i",output,"-vf",`select=eq(n\\,${frame}),scale=1:1`,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"], {encoding:"buffer"});
        const pixel = Buffer.from(stdout);
        expect(pixel).toHaveLength(3);
        if(channel===-1) expect(Math.min(...pixel)).toBeGreaterThan(200);
        else expect(pixel[channel]).toBeGreaterThan(Math.max(pixel[(channel+1)%3],pixel[(channel+2)%3])+30);
      }
    } finally {await rm(dir,{recursive:true,force:true});}
  }, 120000);

  it("refuses a cross-fade longer than the shortest shot", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "assembly-fade-long-"));
    const store = new DiskStore(path.join(dir, "storage"), 40 * 1024 * 1024);
    try {
      const file = (await import("node:fs")).createReadStream(await silentClip(dir, "a.mp4", 0.5, "green"));
      const first = await store.put(WORKSPACE, file);
      const second = await store.put(WORKSPACE, (await import("node:fs")).createReadStream(await silentClip(dir, "b.mp4", 0.5, "yellow")));
      await expect(assembleVideo(store, WORKSPACE,
        [{key: first.key, frames: 12}, {key: second.key, frames: 12}],
        {width: 320, height: 180, fps: 24, audioPolicy: "mute", transition: {kind: "crossfade", seconds: 1}},
        new AbortController().signal)).rejects.toThrow(AssemblyError);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  }, 120000);
});
