/* GPU lane: every ComfyUI on this computer shares one graphics card. Two of them holding models at once
   (an H3 video on :8288 next to a FLUX image on :8188) overflow its memory and freeze the desktop.
   So only one run at a time goes to a ComfyUI on this computer, and before a different one takes the
   card, the others are asked to unload their models through /free. Cloud and remote workers are untouched.
   Only in local single-user mode: on a shared server another workspace's loopback worker must not hold
   or unload anyone else's jobs. */

/** The lane runs only when this server is one person's own computer (LOCAL_SINGLE_USER=1). */
export function gpuLaneEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return env.LOCAL_SINGLE_USER === "1"; }

/** A job untouched this long is treated as stuck and no longer holds the card. */
export const GPU_BUSY_STALE_MINUTES = 60;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** A local worker whose ComfyUI runs on this computer and so shares its graphics card. */
export function onThisComputer(worker: { kind?: string; origin?: string }): boolean {
  if (worker.kind === "cloud" || !worker.origin) return false;
  try { return LOOPBACK.has(new URL(worker.origin).hostname); } catch { return false; }
}

/** Run states that mean a ComfyUI has the job and may be using the card. */
export const GPU_BUSY_STATES = ["submitting", "submission_unknown", "queued", "running", "cancel_requested"] as const;

export type LaneDecision = { go: false } | { go: true; free: string[] };

/** Detect work submitted directly to a local ComfyUI, outside CreativeField. */
export async function localQueueState(call:()=>Promise<Response>):Promise<'busy'|'idle'|'unavailable'> {
  try {
    const response=await call();
    // A reachable worker with an unreadable queue cannot be assumed idle.
    if(!response.ok)return 'busy';
    let queue:{queue_running?:unknown;queue_pending?:unknown};
    try { queue=await response.json() as typeof queue; } catch { return 'busy'; }
    if(!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending))return 'busy';
    return queue.queue_running.length||queue.queue_pending.length?'busy':'idle';
  } catch { return 'unavailable'; }
}

/** Whether a pending run on `workerId` may start now, and which other workers on this computer must unload first.
 *  Ids are ComfyUI addresses; `busyWorkerIds` have a run in a GPU_BUSY_STATES state, `lastOwner` used the card last. */
export function laneDecision(workerId: string, localWorkerIds: string[], busyWorkerIds: string[], lastOwner: string | null): LaneDecision {
  if (busyWorkerIds.some((id) => id !== workerId)) return { go: false };
  const free = lastOwner === workerId ? [] : localWorkerIds.filter((id) => id !== workerId);
  return { go: true, free };
}

/** The model family a pack loads: its main diffusion model file (H3, FLUX 3, Fibo, SeedVR2, ...), or its id when it names none.
 *  Packs of one family (h3-t2v and h3-i2v) share weights, so switching between them needs no unload. */
export function modelFamily(manifest: { id: string; routes: Array<{ requirements: Array<{ kind: string; name: string; location?: string }> }> }): string {
  const main = manifest.routes.flatMap((r) => r.requirements).find((r) => r.kind === "model" && r.location === "diffusion_models");
  return main?.name ?? manifest.id;
}

/** Whether a ComfyUI should unload before this job: it last ran a different model family. ComfyUI applies /free
 *  between prompts, so a job still running there finishes first. */
export function familyChanged(last: string | undefined, next: string): boolean {
  return last !== undefined && last !== next;
}
