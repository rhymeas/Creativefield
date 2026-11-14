// Usage: node scripts/seam-check.mjs clip.mp4 [--join FRAME] [--fix looped.mp4]
// Says whether the clip loops cleanly: SEAMLESS, or VISIBLE when the last frame jumps back to the first.
// --join FRAME   also judges the join at that frame (a cut inside the clip, e.g. where two clips were put together).
// --fix OUT      when the loop is visible, writes the longest trimmed window that does close to OUT and measures it.
// Exit 1 when the clip (or the fixed file) is not seamless. Needs ffmpeg and ffprobe. Credits: see seam-check-lib.mjs.
import { execFileSync } from "node:child_process";
import { load, planTrim, scoreWindow, spliceRatio, SEAM_T } from "./seam-check-lib.mjs";

const args = process.argv.slice(2), flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const join = flag("--join"), fixOut = flag("--fix"), file = args.find((arg) => !arg.startsWith("--"));
if (!file) { console.error("Usage: node scripts/seam-check.mjs clip.mp4 [--join FRAME] [--fix looped.mp4]"); process.exit(2); }

const line = (label, m) => `${label} ${m.verdict.toUpperCase().padEnd(8)} wrap is ${m.ratio}x an ordinary frame step  (texture ${m.texture.ratio}x, composition ${m.composition.ratio}x)  ${m.frames} frames at ${m.fps.toFixed(2)} fps`;
const loaded = load(file), measure = scoreWindow(loaded);
console.log(line("loop ", measure) + `\n      ${file}`);
let failed = measure.verdict !== "seamless";
if (join !== undefined) {
  const ratio = spliceRatio(loaded, Number(join));
  console.log(`join  frame ${join}: ${ratio}x an ordinary frame step${ratio > SEAM_T.textureSeamless ? "  VISIBLE (above " + SEAM_T.textureSeamless + "x)" : "  smooth"}`);
  if (ratio > SEAM_T.textureSeamless) failed = true;
}
if (fixOut && measure.verdict !== "seamless") {
  const plan = planTrim(loaded);
  if (!plan) { console.log("fix   no trimmed window of at least half the clip closes; re-render the clip instead"); }
  else {
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-vf", `trim=start_frame=${plan.start}:end_frame=${plan.start + plan.frames},setpts=PTS-STARTPTS`, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "14", fixOut], { stdio: "pipe" });
    const after = scoreWindow(load(fixOut));
    console.log(line("fixed", after) + `\n      ${fixOut}  (frames ${plan.start} to ${plan.start + plan.frames - 1} of ${loaded.tex.length}, sound dropped)`);
    failed = after.verdict !== "seamless";
  }
}
process.exit(failed ? 1 : 0);
