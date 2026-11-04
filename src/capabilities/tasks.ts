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
  "video.create": { label: "Create video", candidates: ["h3-t2v"], reason: "MiniMax H3: video with sound from a description" },
  "video.from-image": { label: "Picture to video", candidates: ["h3-i2v", "minimax-h3-video"], reason: "MiniMax H3: the picture is the first frame" },
  "video.first-last": { label: "First and last frame", candidates: ["h3-flf2v"], reason: "MiniMax H3 between two frames" },
  "video.upscale": { label: "Upscale video", candidates: ["seedvr2-video-upscale", "nvidia-vfx-upscale"], reason: "SeedVR2: restores faces and texture, steady over time" },
  "video.swap-person": { label: "Replace character", candidates: ["openjutsu-h3-swap"], reason: "MiniMax H3 character swap" },
  "video.swap-thing": { label: "Swap a thing", candidates: ["h3-object-swap"], reason: "MiniMax H3 object swap" },
  "video.previs": { label: "Grey-block to video", candidates: ["previs-to-video"], reason: "MiniMax H3 turns grey shapes into your character, vehicle and place" },
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

/** Model choices for video creation under the current H3-only selection. */
export function isSelectedVideoCreate(id:string):boolean {
  return (['video.create','video.from-image','video.first-last'] as const).some(task=>taskPacks(task).includes(id));
}

/** The selected H3 picture-to-video workflow and its actual image input. */
export function routeImageToVideo<T extends {id:string;inputs:readonly {id:string;type:string}[]}>(ready:readonly T[]):{pack:T;inputId:string}|undefined {
  const supported=ready.filter(pack=>pack.inputs.some(port=>port.type==='image'&&['start_image','character_image'].includes(port.id)));
  const selected=routeTask('video.from-image',supported)?.pack;
  if(!selected)return undefined;
  const port=selected.inputs.find(input=>input.type==='image'&&['start_image','character_image'].includes(input.id));
  return port?{pack:selected,inputId:port.id}:undefined;
}

/** Preparing a draft does not require a running worker; prefer one when available. */
export function routeImageToVideoDraft<T extends {id:string;inputs:readonly {id:string;type:string}[]}>(ready:readonly T[],available:readonly T[]):{pack:T;inputId:string}|undefined {
  return routeImageToVideo(ready) ?? routeImageToVideo(available);
}
