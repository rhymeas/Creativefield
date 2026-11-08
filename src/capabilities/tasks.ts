/* Task router: what a person wants to do, mapped to the packs that can do it, best first.
   A screen asks for a task and gets the first pack that is ready on this computer, with the
   reason in plain words. The order is the product decision (user, 2026-10-31): FLUX 3 Klein
   creates images, Fibo 2.0 edits them, MiniMax H3 makes video. Later entries are fallbacks for
   a computer that does not have the first one installed. */

export type TaskId =
  | "image.create" | "image.edit" | "image.angles" | "image.relight" | "image.upscale"
  | "video.create" | "video.from-image" | "video.first-last" | "video.upscale"
  | "video.swap-person" | "video.swap-thing" | "video.previs";

export type Task = { label: string; candidates: readonly string[]; reason: string };

export const TASKS: Readonly<Record<TaskId, Task>> = {
  "image.create": { label: "Create image", candidates: ["flux2-klein-t2i", "qwen-image-21-t2i"], reason: "FLUX 3 Klein creates an image from your prompt" },
  "image.edit": { label: "Edit image", candidates: ["fibo2-edit", "flux2-klein-edit"], reason: "Fibo 2.0: best-ranked open image editor" },
  "image.angles": { label: "Camera angles", candidates: ["flux2-klein-angles", "qwen-image-21-angles"], reason: "FLUX 3 Klein angles" },
  "image.relight": { label: "Relight", candidates: ["flux2-klein-relight"], reason: "FLUX 3 Klein relight" },
  "image.upscale": { label: "Upscale image", candidates: ["z-image-2k-upscale", "upscale-image-esrgan"], reason: "Z-Image Turbo 2K: enlarges and adds fine detail" },
  "video.create": { label: "Create video", candidates: ["hyperflow-h3-flash-t2v", "h3-t2v"], reason: "HyperFlow H3 Flash creates video with sound from a description" },
  "video.from-image": { label: "Picture to video", candidates: ["hyperflow-h3-flash-i2v", "h3-i2v", "minimax-h3-video"], reason: "HyperFlow H3 Flash animates a reference image" },
  "video.first-last": { label: "First and last frame", candidates: ["hyperflow-h3-flash-flf2v", "h3-flf2v"], reason: "HyperFlow H3 Flash animates between two images" },
  "video.upscale": { label: "Upscale video", candidates: ["seedvr2-video-upscale", "nvidia-vfx-upscale"], reason: "SeedVR2: restores faces and texture, steady over time" },
  "video.swap-person": { label: "Replace character", candidates: ["openjutsu-h3-swap"], reason: "MiniMax H3 character swap" },
  "video.swap-thing": { label: "Swap a thing", candidates: ["h3-object-swap-hyperflow"], reason: "HyperFlow H3 Flash object swap" },
  "video.previs": { label: "Grey-block to video", candidates: ["previs-to-video-hyperflow", "previs-to-video"], reason: "HyperFlow H3 Flash turns grey shapes into your character, vehicle and place" },
};

export type Routed<T> = { task: TaskId; pack: T; reason: string; fallback: boolean };

/** The first candidate of a task that `ready` contains, or undefined when none is ready here. */
export function routeTask<T extends { id: string }>(task: TaskId, ready: readonly T[]): Routed<T> | undefined {
  const { candidates, reason } = TASKS[task];
  for (const [index, id] of candidates.entries()) {
    const pack = ready.find((m) => m.id === id);
    if (pack) return { task, pack, reason: index === 0 ? reason : `Fallback: ${candidates[0]} is not ready here`, fallback: index > 0 };
  }
  return undefined;
}

/** Every pack a task may use, so screens can keep the others out of their default picks. */
export const taskPacks = (task: TaskId): readonly string[] => TASKS[task].candidates;

const videoCreationTasks = ["video.create", "video.from-image", "video.first-last"] as const;

/** Model choices for video creation under the current H3-only selection. */
export function isSelectedVideoCreate(id:string):boolean {
  return videoCreationTasks.some(task=>taskPacks(task).includes(id));
}

export const isObjectSwapWorkflow = (id: string) => id === "h3-object-swap" || taskPacks("video.swap-thing").includes(id);
export const EFFECT_CLIP_WORKFLOWS = ["h3-effects-hyperflow", "h3-effects"] as const;
export const isEffectClips = (id: string) => EFFECT_CLIP_WORKFLOWS.some(workflow => workflow === id);
/** Keep the Flash experiment addressable for explicit runs and recreation. */
export const isOpenJutsuSingleSwap = (id: string) => id === "openjutsu-h3-swap-hyperflow" || taskPacks("video.swap-person").includes(id);

/** Create Video has been qualified on Flash. The shared lists still serve Storyboard and Keyframes. */
export const isFlashVideoCreate = (id: string) => videoCreationTasks.some(task => taskPacks(task)[0] === id);

/** The Create Video handoff uses the Flash picture-to-video graph, even in an offline draft. */
export function routeImageToVideo<T extends {id:string;inputs:readonly {id:string;type:string}[]}>(ready:readonly T[]):{pack:T;inputId:string}|undefined {
  const pack=ready.find(item=>item.id===taskPacks('video.from-image')[0]&&item.inputs.some(port=>port.type==='image'&&port.id==='start_image'));
  return pack?{pack,inputId:'start_image'}:undefined;
}

/** Preparing a draft does not require a running worker; prefer one when available. */
export function routeImageToVideoDraft<T extends {id:string;inputs:readonly {id:string;type:string}[]}>(ready:readonly T[],available:readonly T[]):{pack:T;inputId:string}|undefined {
  return routeImageToVideo(ready) ?? routeImageToVideo(available);
}
