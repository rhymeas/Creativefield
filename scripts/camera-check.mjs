// Usage: node scripts/camera-check.mjs <pan-left|pan-right|pan-up|pan-down|zoom-in|zoom-out> clip.mp4 [more.mp4 ...]
// Says per clip whether the camera did the asked move. Exit 1 if any clip did not. Needs ffmpeg and ffprobe.
import { measureCamera, cameraVerdict, EXPECTED } from "./camera-check-lib.mjs";

const [move, ...files] = process.argv.slice(2);
if (!EXPECTED[move] || !files.length) { console.error("Usage: node scripts/camera-check.mjs <move> clip.mp4 [more.mp4 ...]"); process.exit(2); }
let failed = 0;
for (const file of files) {
  const m = measureCamera(file), { followed, reason } = cameraVerdict(m, move);
  if (!followed) failed++;
  console.log(`${followed ? "FOLLOWED" : "MISSED  "} ${file}\n         ${reason}\n         dx ${m.dx}  dy ${m.dy}  zoom ${m.zoom}  (fit ${m.fit}, unmoved ${m.still})`);
}
process.exit(failed ? 1 : 0);
