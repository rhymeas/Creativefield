// Build a teaser from user-supplied clips. Set COMFYFIELD_TEASER_CONFIG to JSON
// containing outputDir, fontFile and segments [{kind: card|image|pair|video,
// file? or files?, seconds, title, note}]. Relative paths use the config folder.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (!process.env.COMFYFIELD_TEASER_CONFIG) throw new Error('Set COMFYFIELD_TEASER_CONFIG to a teaser JSON configuration');
const configPath = path.resolve(process.env.COMFYFIELD_TEASER_CONFIG);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.outputDir || !config.fontFile || !Array.isArray(config.segments)) throw new Error('Teaser config requires outputDir, fontFile and segments');
const configDir = path.dirname(configPath);
const out = path.resolve(configDir, config.outputDir);
fs.mkdirSync(out, {recursive: true});
const BS = String.fromCharCode(92), W = 1280, H = 720;
const esc = (p) => p.split(BS).join('/').replace(':', BS + ':');
const font = esc(path.resolve(configDir, config.fontFile));
const segments = config.segments.map(s => ({...s, ...(s.file ? {file: path.resolve(configDir, s.file)} : {}), ...(s.files ? {files: s.files.map(f => path.resolve(configDir, f))} : {})}));
const text = (i, s) => { const f = path.join(out, `teaser-text-${i}.txt`); fs.writeFileSync(f, `${s.title}\n${s.note}`, "utf8"); return esc(f); };
const caption = (i, s) => `drawtext=fontfile='${font}':textfile='${text(i, s)}':fontcolor=white:fontsize=34:line_spacing=12:x=48:y=h-130:box=1:boxcolor=0x000000B0:boxborderw=22`;
/* A blurred copy fills the frame, the picture sits sharp on top: portrait and square clips fit a 16:9 screen. */
const fit = "split[a][b];[a]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,boxblur=30:5[bg];[b]scale=1280:720:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2";
const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", "24", "-an"];
const ff = (args) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { windowsHide: true });
const parts = [];
segments.forEach((s, i) => {
  const target = path.join(out, `teaser-${i}.mp4`), d = String(s.seconds);
  if (s.kind === "card") {
    const f = path.join(out, `teaser-card-${i}.txt`); fs.writeFileSync(f, `${s.title}\n${s.note}`, "utf8");
    ff(["-f", "lavfi", "-i", `color=c=0x0b0b0f:s=${W}x${H}:d=${d}`, "-vf", `drawtext=fontfile='${font}':textfile='${esc(f)}':fontcolor=white:fontsize=54:line_spacing=22:x=(w-text_w)/2:y=(h-text_h)/2,fade=in:0:12,fade=out:st=${s.seconds - 0.5}:d=0.5`, ...enc, target]);
  } else if (s.kind === "image") {
    ff(["-loop", "1", "-i", s.file, "-t", d, "-vf", `${fit},${caption(i, s)},fade=in:0:8`, ...enc, target]);
  } else if (s.kind === "pair") {
    ff(["-i", s.files[0], "-i", s.files[1], "-t", d, "-filter_complex", `[0:v]scale=-2:440[l];[1:v]scale=-2:440[r];[l][r]hstack=inputs=2,${fit},${caption(i, s)}`, ...enc, target]);
  } else {
    ff(["-stream_loop", "-1", "-i", s.file, "-t", d, "-vf", `${fit},${caption(i, s)},fade=in:0:6`, ...enc, target]);
  }
  parts.push(target); console.log("part", i, s.kind, s.title);
});
const list = path.join(out, "teaser-list.txt");
fs.writeFileSync(list, parts.map((f) => `file '${f.split(BS).join("/")}'`).join("\n"), "utf8");
const reel = path.join(out, "comfyfield-teaser.mp4");
ff(["-f", "concat", "-safe", "0", "-i", list, ...enc, reel]);
console.log(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames,duration", "-of", "csv=p=0", reel], { encoding: "utf8" }).trim());
