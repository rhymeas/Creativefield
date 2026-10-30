/* Memory guard for ComfyUI workers. It never touches how ComfyUI is started: it only reads /system_stats and /queue
   and calls /free. Runs start only while enough system RAM is free, and models are unloaded after a quiet spell.
   A Comfy Cloud worker keeps its own memory, so the guard sends it nothing at all. */

/** Share of system RAM that must stay free before a run starts. Operators with a dedicated machine can lower or
    raise it with COMFYFIELD_MIN_FREE_RAM_SHARE (0.02–0.95); anything else falls back to the 15 % default. */
export function minFreeRamShare(raw: string | undefined = process.env.COMFYFIELD_MIN_FREE_RAM_SHARE): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value >= 0.02 && value <= 0.95 ? value : 0.15;
}
export const MIN_FREE_RAM_SHARE = minFreeRamShare();
/** How long a worker may sit idle before its models are unloaded. An operator can keep models
    warm for a recording session with COMFYFIELD_IDLE_UNLOAD_MINUTES (1–1440); anything else
    falls back to five minutes. */
export function idleUnloadMs(raw: string | undefined = process.env.COMFYFIELD_IDLE_UNLOAD_MINUTES): number {
  const minutes = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440 ? minutes * 60_000 : 5 * 60_000;
}
export const IDLE_UNLOAD_MS = idleUnloadMs();

type Call = (path: string, init?: RequestInit) => Promise<Response>;
/** A local ComfyUI answers /system_stats and /free. Comfy Cloud keeps its own memory,
 *  so the guard asks it nothing and never sends it /free. */
export type WorkerKind = "local" | "cloud";

/** Free share of system RAM (0..1), or null when the worker does not report it (then the gate stays open). */
export async function freeRamShare(call: Call, kind: WorkerKind = "local"): Promise<number | null> {
  if (kind === "cloud") return null;
  const res = await call("/system_stats");
  if (!res.ok) return null;
  const sys = ((await res.json()) as any)?.system;
  const total = Number(sys?.ram_total), free = Number(sys?.ram_free);
  return total > 0 && Number.isFinite(free) ? free / total : null;
}

/** What the wait is about, in numbers a person can act on: "5.9 of 64 GB free, needs 9.6 GB". */
export function memoryWaitNote(total: number, free: number, min = MIN_FREE_RAM_SHARE): string {
  const gb = (bytes: number) => (bytes / 1e9).toFixed(1);
  return `${gb(free)} of ${Math.round(total / 1e9)} GB free, needs ${gb(total * min)} GB`;
}
export async function ramNote(call: Call, kind: WorkerKind = "local", min = MIN_FREE_RAM_SHARE): Promise<string | undefined> {
  if (kind === "cloud") return undefined;
  try {
    const res = await call("/system_stats");
    if (!res.ok) return undefined;
    const sys = ((await res.json()) as any)?.system;
    const total = Number(sys?.ram_total), free = Number(sys?.ram_free);
    return total > 0 && Number.isFinite(free) ? memoryWaitNote(total, free, min) : undefined;
  } catch { return undefined; }
}

export async function hasRoomToStart(call: Call, min = MIN_FREE_RAM_SHARE, kind: WorkerKind = "local"): Promise<boolean> {
  try { const share = await freeRamShare(call, kind); return share === null || share > min; }
  catch { return true; /* an unreachable worker is handled by submit itself */ }
}

async function queueBusy(call: Call): Promise<boolean> {
  const res = await call("/queue");
  if (!res.ok) return true;
  const q = (await res.json()) as any;
  return (q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0) > 0;
}

/** A waiting app run is not an active worker job. Release only an idle worker's
 * caches, otherwise cached models can hold the RAM gate closed indefinitely. */
export async function freeIdleWorkerForMemory(call:Call,kind:WorkerKind="local"):Promise<"busy"|"freed"|"unavailable">{
  if(kind==="cloud")return "unavailable";
  try{
    const response=await call("/queue");if(!response.ok)return "unavailable";
    const queue=await response.json() as {queue_running?:unknown;queue_pending?:unknown};
    if(!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending))return "unavailable";
    if(queue.queue_running.length||queue.queue_pending.length)return "busy";
    const freed=await call("/free",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({unload_models:true,free_memory:true})});
    return freed.ok?"freed":"unavailable";
  }catch{return "unavailable";}
}

/** Tracks when each worker last had work and unloads its models once it has been empty for the idle window. */
export class IdleUnloader {
  private lastBusy = new Map<string, number>();
  private unloaded = new Set<string>();
  constructor(private readonly idleMs = IDLE_UNLOAD_MS, private readonly now = () => Date.now()) {}
  /** `hasOwnRuns` is true while ComfyField itself still has an unfinished run on this worker. */
  async check(workerId: string, call: Call, hasOwnRuns: boolean, kind: WorkerKind = "local"): Promise<"busy" | "idle" | "unloaded"> {
    if (kind === "cloud") return "idle";
    const t = this.now();
    if (hasOwnRuns || (await queueBusy(call))) { this.lastBusy.set(workerId, t); this.unloaded.delete(workerId); return "busy"; }
    const since = this.lastBusy.get(workerId) ?? (this.lastBusy.set(workerId, t), t);
    if (t - since < this.idleMs || this.unloaded.has(workerId)) return "idle";
    const res = await call("/free", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
    if (!res.ok) return "idle";
    this.unloaded.add(workerId);
    return "unloaded";
  }
}
