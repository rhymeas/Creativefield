import { describe, expect, it } from "vitest";
import { freeRamShare, hasRoomToStart, IdleUnloader,freeIdleWorkerForMemory, memoryWaitNote, ramNote } from "../server/memory-guard";

const json = (b: unknown) => new Response(JSON.stringify(b));
const stats = (free: number) => async () => json({ system: { ram_total: 100, ram_free: free } });

describe("memory wait note", () => {
  it("says how much RAM is free and how much the run needs", () => {
    expect(memoryWaitNote(68.5e9, 5.9e9, 0.15)).toBe("5.9 of 69 GB free, needs 10.3 GB");
  });
  it("reads it from /system_stats and says nothing for Comfy Cloud or a missing answer", async () => {
    const stats = async () => new Response(JSON.stringify({ system: { ram_total: 64e9, ram_free: 6e9 } }));
    expect(await ramNote(stats, "local", 0.15)).toBe("6.0 of 64 GB free, needs 9.6 GB");
    expect(await ramNote(stats, "cloud")).toBeUndefined();
    expect(await ramNote(async () => new Response("no", { status: 500 }))).toBeUndefined();
  });
});

describe("memory guard", () => {
  it("computes the free share and gates at 15 %", async () => {
    expect(await freeRamShare(stats(24))).toBe(0.24);
    expect(await hasRoomToStart(stats(16))).toBe(true);
    expect(await hasRoomToStart(stats(15))).toBe(false);
    expect(await hasRoomToStart(stats(5))).toBe(false);
  });
  it("stays open when RAM is unknown or the worker is unreachable", async () => {
    expect(await hasRoomToStart(async () => json({}))).toBe(true);
    expect(await hasRoomToStart(async () => { throw new Error("down"); })).toBe(true);
  });
  it("unloads once after 5 idle minutes and re-arms after new work", async () => {
    let t = 0, busy = false; const freed: string[] = [];
    const call = async (path: string) => { if (path === "/free") { freed.push(path); return json({}); } return json({ queue_running: busy ? [1] : [], queue_pending: [] }); };
    const u = new IdleUnloader(300_000, () => t);
    expect(await u.check("w", call, false)).toBe("idle");
    t = 299_000; expect(await u.check("w", call, false)).toBe("idle");
    t = 301_000; expect(await u.check("w", call, false)).toBe("unloaded");
    t = 700_000; expect(await u.check("w", call, false)).toBe("idle");
    expect(freed).toHaveLength(1);
    t = 700_000; busy = true; expect(await u.check("w", call, false)).toBe("busy");
    busy = false; t = 800_000; expect(await u.check("w", call, false)).toBe("idle");
    t = 1_001_000; expect(await u.check("w", call, false)).toBe("unloaded");
    expect(freed).toHaveLength(2);
  });
  it("counts own unfinished runs as busy", async () => {
    const u = new IdleUnloader(0, () => 1);
    expect(await u.check("w", async () => json({}), true)).toBe("busy");
  });
  it("releases idle caches without interrupting queued or active worker jobs",async()=>{
    const calls:string[]=[];
    expect(await freeIdleWorkerForMemory(async path=>{calls.push(path);return json({queue_running:[1],queue_pending:[]});})).toBe("busy");
    expect(calls).toEqual(["/queue"]);calls.length=0;
    expect(await freeIdleWorkerForMemory(async(path,init)=>{calls.push(path);if(path==="/free"){expect(JSON.parse(init!.body as string)).toEqual({unload_models:true,free_memory:true});return json({});}return json({queue_running:[],queue_pending:[]});})).toBe("freed");
    expect(calls).toEqual(["/queue","/free"]);
    expect(await freeIdleWorkerForMemory(async()=>json({}))).toBe("unavailable");
  });
});
