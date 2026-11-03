#!/usr/bin/env node
/** Build feature-card loops from user-provided inputs.
 * Set COMFYFIELD_REELS_CONFIG to JSON with inputDir, outputDir and reels.
 * Each reel needs a safe name and either before/after file objects or a loop
 * file object; optional start, seconds, y, copies and poster control the crop.
 * Paths are resolved relative to the configuration file. Requires ffmpeg and ffprobe.
 */
import { readFileSync } from 'node:fs';
import { mkdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

if (!process.env.COMFYFIELD_REELS_CONFIG) throw new Error('Set COMFYFIELD_REELS_CONFIG to a reel JSON configuration');
const configPath = path.resolve(process.env.COMFYFIELD_REELS_CONFIG);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (!config.inputDir || !config.outputDir || !Array.isArray(config.reels)) throw new Error('Reels config requires inputDir, outputDir and reels');
const ROOT = path.resolve(path.dirname(configPath), config.inputDir);
const OUT = path.resolve(path.dirname(configPath), config.outputDir);

/** 640 px wide, 16:9; `y` picks the slice of a taller source (0 is the top). */
const CARD = { width: 640, height: 360 };
/** Longest half of a before → after loop. Two halves land at 3.8 s. */
const HALF = 1.9;
const MAX_BYTES = 1.5 * 1024 * 1024;

/**
 * One entry per feature card. `before` and `after` are QA clips; `y` is the crop
 * offset after scaling the source to 640 px wide. `poster` is the second the
 * poster frame is taken from.
 */
export const REELS = config.reels;
if (REELS.some(reel => !/^[A-Za-z0-9_-]+$/.test(reel.name ?? ''))) throw new Error('Reel names may contain letters, digits, hyphens and underscores only');

function resolve(file) {
  return path.isAbsolute(file) ? file : path.join(ROOT, file);
}

function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${bin} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function crop(source) {
  const y = Math.max(0, Math.round(source.y ?? 0));
  return `scale=${CARD.width}:${CARD.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${CARD.width}:${CARD.height}:0:${y}`;
}

function segment(input, index, source) {
  const start = source.start ?? 0;
  const seconds = source.seconds ?? HALF;
  return `[${index}:v]trim=start=${start}:duration=${seconds},setpts=PTS-STARTPTS,fps=24,${crop(source)},setsar=1[v${index}]`;
}

async function build(reel) {
  await mkdir(OUT, { recursive: true });
  const out = path.join(OUT, `${reel.name}.mp4`);
  const poster = path.join(OUT, `${reel.name}.png`);
  const args = ["-hide_banner", "-loglevel", "error", "-y"];

  if (reel.loop) {
    const source = resolve(reel.loop.file);
    args.push("-stream_loop", String((reel.loop.copies ?? 1) - 1), "-i", source);
    args.push(
      "-filter_complex",
      `[0:v]trim=start=0:duration=${reel.seconds ?? 3.8},setpts=PTS-STARTPTS,fps=24,${crop(reel.loop)},setsar=1[v]`,
      "-map", "[v]",
    );
  } else {
    args.push("-i", resolve(reel.before.file), "-i", resolve(reel.after.file));
    args.push(
      "-filter_complex",
      `${segment("0", 0, reel.before)};${segment("1", 1, reel.after)};[v0][v1]concat=n=2:v=1:a=0[v]`,
      "-map", "[v]",
    );
  }

  args.push(
    "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-pix_fmt", "yuv420p",
    "-profile:v", "high", "-movflags", "+faststart", out,
  );
  run("ffmpeg", args);

  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-ss", String(reel.poster ?? 2.8), "-i", out,
    "-frames:v", "1", poster,
  ]);

  const bytes = (await stat(out)).size;
  const probe = JSON.parse(run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height",
    "-of", "json", out,
  ]));
  const stream = probe.streams?.[0] ?? {};
  const seconds = Number(probe.format?.duration ?? 0);
  if (stream.codec_name !== "h264") throw new Error(`${reel.name}: not H.264`);
  if (stream.width !== CARD.width) throw new Error(`${reel.name}: ${stream.width} px wide, want ${CARD.width}`);
  if (!(seconds >= 3 && seconds <= 4.05)) throw new Error(`${reel.name}: ${seconds.toFixed(2)} s, want 3–4 s`);
  if (bytes > MAX_BYTES) throw new Error(`${reel.name}: ${bytes} bytes, over 1.5 MB`);
  console.log(`${reel.name}.mp4  ${stream.width}x${stream.height}  ${seconds.toFixed(2)} s  ${(bytes / 1024).toFixed(0)} KB`);
}

const wanted = process.argv.slice(2);
const chosen = wanted.length ? REELS.filter((reel) => wanted.includes(reel.name)) : REELS;
if (!chosen.length) {
  console.error(`No reel matches ${wanted.join(", ")}. Known: ${REELS.map((reel) => reel.name).join(", ")}`);
  process.exit(1);
}
for (const reel of chosen) await build(reel);
