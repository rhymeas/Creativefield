// Builds the 30 s teaser from real, already rendered clips and the app itself. No model run, nothing downloaded.
// Usage: node scripts/marketing-video.mjs   -> .comfyfield/qa/marketing/comfyfield-teaser.mp4
// Sources: .comfyfield/qa/transform/*.mp4 (cleared QA clips), .comfyfield/qa/marketing/ (camera clips, app screens).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const out = path.resolve(".comfyfield/qa/marketing"), qa = path.resolve(".comfyfield/qa/transform");
const BS = String.fromCharCode(92), font = `C${BS}:/Windows/Fonts/arialbd.ttf`, W = 1280, H = 720;
const esc = (p) => p.split(BS).join("/").replace(":", `${BS}:`);
const segments = [
  { kind: "card", seconds: 3, title: "ComfyField", note: "ComfyUI, made simple. Runs on your computer." },
  { kind: "image", file: path.join(out, "app-create.png"), seconds: 4, title: "Pick a picture. Pick a move.", note: "Make a video from a photo, in one panel" },
  { kind: "pair", files: [path.join(out, "camrun-panleft.mp4"), path.join(out, "camrun-zoomin.mp4")], seconds: 3, title: "Camera moves that are really followed", note: "Pan left  ·  Zoom in  ·  on a fixed camera path, measured on the clip" },
  { kind: "video", file: path.join(qa, "ui-restyle-noir.mp4"), seconds: 4, title: "New look", note: "The same video as noir, motion kept" },
  { kind: "video", file: path.join(qa, "object-swap-multi.mp4"), seconds: 4, title: "Swap a thing", note: "Mark it, describe it. The rest stays" },
  { kind: "video", file: path.join(qa, "motion-transfer.mp4"), seconds: 4, title: "Copy moves", note: "A performance drives your character" },
  { kind: "video", file: path.join(qa, "ui-swap-profile.mp4"), seconds: 4, title: "Replace character", note: "A face from a photo, onto someone in a video" },
  { kind: "card", seconds: 4, title: "Every clip here ran on this computer", note: "Open source  ·  GPL-3.0  ·  built on ComfyUI" },
];
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
