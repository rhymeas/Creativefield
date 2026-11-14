/*
 * Offscreen renderer for shot artefacts: rectangular wireframe stills for the
 * timeline and a grey-block webm clip for the AI handoff. It uses the same
 * scene builder and frame painter as the live viewport, so a still, a clip and
 * the stage never disagree about where anything stands.
 */
import {CanvasTexture, Fog, Mesh, MeshStandardMaterial, NearestFilter, PerspectiveCamera, PlaneGeometry, RepeatWrapping, SRGBColorSpace, WebGLRenderer} from "three";
import {evaluateFrame} from "../score/evaluate";
import type {StageScore} from "../score/schema";
import type {SceneBlock} from "../analysis-contract";
import {applyCamera, applySceneSet, applyStageFrame, buildStageScene, type BuiltScene} from "./StageViewport";
import {clipFrameTimes} from "./clip-timing";

/**
 * How a clip looks. "stage" is the studio's own dark diorama. "handoff" is the pass a video model
 * reads (after the clay/RGB passes of ComfyUI Motion Previs Studio, MIT): a lit neutral world with
 * a tiled floor and a horizon, so camera travel shows as parallax; opaque figures in their colours;
 * the shot's rebuilt set; and none of the studio's marks, rings or trails.
 */
export type ClipLook = "stage" | "handoff";

const NEUTRAL_SKY = 0xc3c8cd;

function tiledFloor(): Mesh {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "#8d9298";
    context.fillRect(0, 0, size, size);
    context.fillStyle = "#7c8187";
    context.fillRect(0, 0, size / 2, size / 2);
    context.fillRect(size / 2, size / 2, size / 2, size / 2);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = NearestFilter;
  // One checker square per metre: 300 m floor, 150 repeats of a 2x2 tile.
  texture.repeat.set(150, 150);
  const floor = new Mesh(new PlaneGeometry(300, 300), new MeshStandardMaterial({map: texture, roughness: 1, metalness: 0}));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.004;
  floor.name = "handoff-floor";
  return floor;
}

function prepareHandoffScene(built: BuiltScene, score: StageScore, set: readonly SceneBlock[] | undefined) {
  const grid = built.scene.getObjectByName("stage-grid");
  if (grid) grid.visible = false;
  built.scene.add(tiledFloor());
  built.scene.fog = new Fog(NEUTRAL_SKY, 40, 160);
  applySceneSet(built, set);
  for (const entity of score.entities) {
    const visual = built.entities.get(entity.id);
    if (!visual) continue;
    visual.group.traverse((object) => {
      const material = (object as Mesh).material as MeshStandardMaterial | undefined;
      if (material && "opacity" in material && !(object.type === "Sprite")) {
        material.transparent = false;
        material.opacity = 1;
        material.depthWrite = true;
      }
    });
  }
}

/** Per frame: the studio's marks, selection rings and walk trails never reach the model. */
function hideStudioMarks(built: BuiltScene, score: StageScore) {
  for (const entity of score.entities) {
    const visual = built.entities.get(entity.id);
    if (!visual) continue;
    if (entity.kind === "marker") visual.group.visible = false;
    visual.ring.visible = false;
    visual.trail.visible = false;
    visual.label.visible = false;
  }
}

export type ShotRenderer = {
  /** A rectangular still of the film camera at time t, as a PNG data URL. */
  still: (t: number) => string;
  /** The same frame as a JPEG data URL, for deterministic clip encoding. */
  jpeg: (t: number) => string;
  /** Real-time recording of the film camera between two timestamps, as webm. */
  recordClip: (startSec: number, endSec: number, fps: number) => Promise<Blob>;
  dispose: () => void;
};



export type ClipFrames = {frames: string[]; fps: number; durationSec: number; width: number; height: number; truncated: boolean};

/**
 * Render a shot to JPEG frames at exact times (deterministic), capped so a long
 * shot never blocks the dialog for minutes. The server encodes the frames to MP4.
 */
export async function renderShotClipFrames(
  score: StageScore,
  shotId: string,
  options: {fps?: number; width?: number; maxFrames?: number; maxDurationSec?: number; look?: ClipLook; set?: readonly SceneBlock[]} = {},
): Promise<ClipFrames> {
  const shot = score.shots.find((entry) => entry.id === shotId);
  if (!shot) throw new Error("That shot is no longer in the score.");
  const fps = Math.max(1, Math.min(60, Math.round(options.fps ?? 24)));
  const width = Math.max(320, Math.min(1920, Math.round(options.width ?? 1280)));
  const maxFrames = Math.max(2, Math.min(480, Math.round(options.maxFrames ?? 180)));
  const maxDuration = Math.max(1 / fps, options.maxDurationSec ?? 6);
  const end = Math.min(shot.endSec, shot.startSec + maxDuration);
  const timing = clipFrameTimes(shot.startSec + 0.001, Math.max(shot.startSec + 0.05, end), fps, maxFrames);
  const renderer = createShotRenderer(score, width, {look: options.look, set: options.set});
  try {
    const frames: string[] = [];
    for (const [index, time] of timing.times.entries()) {
      frames.push(renderer.jpeg(time));
      if (index % 24 === 23) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const height = Math.max(48, Math.round(width / score.aspectRatio));
    return {frames, fps: timing.fps, durationSec: timing.durationSec, width, height, truncated: timing.truncated};
  } finally {
    renderer.dispose();
  }
}


/** The scene's own aspect ratio decides the frame: 2.39:1 stays wide, 16:9 stays 16:9. */
export function createShotRenderer(score: StageScore, width = 360, options: {look?: ClipLook; set?: readonly SceneBlock[]} = {}): ShotRenderer {
  const height = Math.max(48, Math.round(width / score.aspectRatio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const renderer = new WebGLRenderer({canvas, antialias: true, alpha: false, preserveDrawingBuffer: true});
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setSize(width, height, false);
  const handoff = options.look === "handoff";
  renderer.setClearColor(handoff ? NEUTRAL_SKY : 0x090b0d, 1);
  const built = buildStageScene(score);
  if (handoff) prepareHandoffScene(built, score, options.set);
  const camera = new PerspectiveCamera(40, score.aspectRatio, 0.05, 500);
  const paint = (timeSec: number) => {
    const frame = evaluateFrame(score, timeSec);
    applyStageFrame(built, score, frame, {labels: "off", showCameraRig: false});
    if (handoff) hideStudioMarks(built, score);
    applyCamera(camera, frame.stageCamera, score.aspectRatio);
    renderer.render(built.scene, camera);
  };
  return {
    still(timeSec) {
      paint(timeSec);
      return canvas.toDataURL("image/png");
    },
    jpeg(timeSec) {
      paint(timeSec);
      return canvas.toDataURL("image/jpeg", 0.9);
    },
    async recordClip(startSec, endSec, fps) {
      if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") {
        throw new Error("This browser cannot record the viewport.");
      }
      const stream = canvas.captureStream(fps);
      // MP4 first where Chrome can record it (the H3 previs input is a normal video);
      // webm is the fallback and the server can encode it afterwards when FFmpeg is set up.
      const mime = ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "video/webm";
      const recorder = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 6_000_000});
      const chunks: BlobPart[] = [];
      const finished = new Promise<Blob>((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onstop = () => resolve(new Blob(chunks, {type: mime.split(";")[0]}));
        recorder.onerror = () => reject(new Error("The grey-block clip could not be recorded."));
      });
      recorder.start(100);
      const duration = Math.max(0.5, endSec - startSec);
      const frames = Math.max(2, Math.round(duration * fps));
      for (let index = 0; index < frames; index++) {
        paint(startSec + index / fps);
        await new Promise((resolve) => setTimeout(resolve, 1000 / fps));
      }
      recorder.stop();
      return finished;
    },
    dispose() {
      renderer.dispose();
      built.dispose();
    },
  };
}

/** One rectangular still per shot, keyed by shot id. Rendered in the scene aspect ratio. */
export function renderShotStills(score: StageScore, width = 300): Map<string, string> {
  const renderer = createShotRenderer(score, width);
  const stills = new Map<string, string>();
  try {
    for (const shot of score.shots) {
      const at = shot.startSec + Math.min(0.2, Math.max(0.02, (shot.endSec - shot.startSec) / 2));
      stills.set(shot.id, renderer.still(at));
    }
  } finally {
    renderer.dispose();
  }
  return stills;
}

