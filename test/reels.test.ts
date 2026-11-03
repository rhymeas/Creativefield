import {existsSync, readdirSync, statSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {LIBRARY_EXAMPLE_VIDEOS,reelForManifest,reelForSection} from "../src/team/reels";

const FEATURE_REELS: Array<[string,string]> = [
  ["scail2-character-replace","/reels/feature-replace.mp4"],
  ["wan-animate2-distilled","/reels/mj-07.mp4"],
  ["wan21-vace-masked-edit","/reels/feature-swap.mp4"],
  ["wan21-vace-masked-edit-reference","/reels/feature-swap.mp4"],
  ["wan21-vace-two-region-edit","/reels/feature-swap.mp4"],
  ["vace-reference-restyle","/reels/mj-04.mp4"],
  ["vace-canny-restyle","/reels/feature-effects.mp4"],
  ["vace-depth-restyle","/reels/feature-effects.mp4"],
  ["wan22-flf2v-14b","/reels/mj-01.mp4"],
  ["wan22-i2v-14b","/reels/mj-02.mp4"],
  ["wan22-ti2v-5b","/reels/wan22-t2v-5b.mp4"],
  ["wan22-ti2v-5b-t2v","/reels/wan22-t2v-5b.mp4"],
];

const local = (url: string) => `public${url}`;

describe("feature reels", () => {
  it("offers every bundled video example in the Library",()=>{
    const files=readdirSync('public/reels').filter(name=>name.endsWith('.mp4')).map(name=>`/reels/${name}`).sort();
    expect([...LIBRARY_EXAMPLE_VIDEOS].sort()).toEqual(files);
  });
  it.each(FEATURE_REELS)("gives %s its own loop", (id, url) => {
    expect(reelForManifest(id)).toBe(url);
  });

  it("leaves a workflow without a loop without one", () => {
    expect(reelForManifest("nvidia-vfx-upscale")).toBeUndefined();
    expect(reelForManifest()).toBeUndefined();
  });

  it("points the video section at a real take instead of the old gradient", () => {
    expect(reelForSection("video")).toBe("/reels/wan22-t2v-5b.mp4");
  });

  it("does not decorate 3D or an unmapped workspace with an unrelated video",()=>{expect(reelForSection("3d")).toBeUndefined();expect(reelForSection("unknown")).toBeUndefined();});

  it("ships every mapped loop with a poster, under 1.5 MB", () => {
    for (const url of new Set(FEATURE_REELS.map(([,path]) => path).concat(reelForSection("video")!))) {
      const file = local(url);
      expect(existsSync(file), file).toBe(true);
      expect(statSync(file).size, file).toBeLessThanOrEqual(1.5 * 1024 * 1024);
      expect(existsSync(file.replace(/\.mp4$/, ".png")), `${file} poster`).toBe(true);
    }
  });
});
