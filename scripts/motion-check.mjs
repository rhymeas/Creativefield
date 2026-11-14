// Usage: node scripts/motion-check.mjs [--strict] clip.mp4 [more.mp4 ...]
// Says per clip whether it is alive (every third of the picture moves), partial (only some of it moves) or
// static. Exit 1 on static; with --strict also on partial. Needs ffmpeg and ffprobe.
import { measureMotion, motionVerdict } from "./motion-check-lib.mjs";

const args = process.argv.slice(2), strict = args.includes("--strict"), files = args.filter((arg) => !arg.startsWith("--"));
if (!files.length) { console.error("Usage: node scripts/motion-check.mjs [--strict] clip.mp4 [more.mp4 ...]"); process.exit(2); }
let failed = 0;
for (const file of files) {
  const motion = measureMotion(file), { level, reason } = motionVerdict(motion);
  if (level === "static" || (strict && level === "partial")) failed++;
  console.log(`${level.toUpperCase().padEnd(7)} ${file}\n        ${reason}\n        top ${motion.top}  middle ${motion.middle}  bottom ${motion.bottom}  (${motion.frames} frames)`);
}
process.exit(failed ? 1 : 0);
