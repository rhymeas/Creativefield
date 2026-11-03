// Build a captioned reel from user-supplied clips.
// Set COMFYFIELD_REEL_CONFIG to JSON with inputDir, outputDir, fontFile and
// segments [{kind: card|image|video, file?, seconds, title, note}].
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import fs from "node:fs";
import path from "node:path";

const run = promisify(execFile);
if (!process.env.COMFYFIELD_REEL_CONFIG) throw new Error('Set COMFYFIELD_REEL_CONFIG to a reel JSON configuration');
const configPath = path.resolve(process.env.COMFYFIELD_REEL_CONFIG);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.inputDir || !config.outputDir || !config.fontFile || !Array.isArray(config.segments)) throw new Error('Reel config requires inputDir, outputDir, fontFile and segments');
const baseDir = path.dirname(configPath);
const clips = path.resolve(baseDir, config.inputDir);
const work = path.resolve(baseDir, config.outputDir);
fs.mkdirSync(work, {recursive: true});
const segments = config.segments;
const font = path.resolve(baseDir, config.fontFile).split(path.sep).join('/').replace(':', String.fromCharCode(92) + ':');
const caption = (index, segment) => {
  const file = path.join(work, `caption-${index}.txt`);
  fs.writeFileSync(file, `${segment.title}\n${segment.note}`, "utf8");
  return `drawtext=fontfile='${font}':textfile=caption-${index}.txt:fontcolor=white:fontsize=30:line_spacing=10:x=44:y=h-118:box=1:boxcolor=0x000000B0:boxborderw=20`;
};
const parts = [];
for (const [index, segment] of segments.entries()) {
  const target = path.join(work, `part-${index}.mp4`);
  const base = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x0b0b0f";
  const tail = "fps=24,setsar=1";
  if (segment.kind === "card") {
    const filter = `drawtext=fontfile='${font}':textfile=card-${index}.txt:fontcolor=white:fontsize=52:line_spacing=18:x=(w-text_w)/2:y=(h-text_h)/2-30`;
    fs.writeFileSync(path.join(work, `card-${index}.txt`), `${segment.title}\n${segment.note}`, "utf8");
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=0x0b0b0f:s=1280x720:d=${segment.seconds}`, "-vf", `${filter},${tail}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", target], {windowsHide: true, cwd: work});
  } else {
    const source = path.resolve(clips, segment.file);
    if (!fs.existsSync(source)) { console.log(`skip missing ${segment.file}`); continue; }
    const loop = segment.kind === "image" ? ["-loop", "1"] : ["-stream_loop", "-1"];
    await run("ffmpeg", ["-y", "-v", "error", ...loop, "-i", source, "-t", String(segment.seconds), "-vf", `${base},${caption(index, segment)},${tail}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", target], {windowsHide: true, cwd: work});
  }
  parts.push(target);
  console.log(`part ${index}: ${segment.kind} ${segment.file ?? segment.title}`);
}

if (!parts.length) { console.error("no clips found"); process.exit(1); }
const list = path.join(work, "list.txt");
fs.writeFileSync(list, parts.map(file => `file '${file.replace(/\\/g, "/")}'`).join("\n"), "utf8");
const reel = path.join(work, "comfyfield-demo-reel.mp4");
await run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "24", "-an", reel], {windowsHide: true});
const {stdout} = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration", "-of", "csv=p=0", reel]);
console.log(`reel: ${path.relative(process.cwd(), reel)}  ${stdout.trim()}`);
