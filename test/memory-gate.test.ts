import {describe, expect, it, vi} from "vitest";
import {freeIdleWorkerForMemory, freeRamShare, hasRoomToStart} from "../server/memory-guard";

const json = (body: unknown, ok = true) => ({ok, json: async () => body}) as unknown as Response;
const stats = (free: number, total: number) => json({system: {ram_free: free, ram_total: total}});

describe("memory gate", () => {
  it("reads the share of free RAM from the worker", async () => {
    expect(await freeRamShare(async () => stats(10, 100))).toBeCloseTo(0.1);
  });

  it("treats a missing or unusable reading as unknown rather than zero", async () => {
    expect(await freeRamShare(async () => json(null, false))).toBeNull();
    expect(await freeRamShare(async () => json({system: {ram_free: 0, ram_total: 0}}))).toBeNull();
  });

  it("holds a run back below the threshold and lets it start above", async () => {
    // The situation on this machine: about 4 % free of 64 GB.
    expect(await hasRoomToStart(async () => stats(2.5, 64))).toBe(false);
    expect(await hasRoomToStart(async () => stats(20, 64))).toBe(true);
    // Exactly at the line is not room: the gate wants strictly more.
    expect(await hasRoomToStart(async () => stats(15, 100), 0.15)).toBe(false);
    expect(await hasRoomToStart(async () => stats(16, 100), 0.15)).toBe(true);
  });

  it("lets submission decide when the worker cannot be read", async () => {
    expect(await hasRoomToStart(async () => json(null, false))).toBe(true);
    expect(await hasRoomToStart(async () => { throw new Error("offline"); })).toBe(true);
  });
});

describe("freeing an idle worker", () => {
  it("never frees a worker that is running or holding work", async () => {
    const call = vi.fn(async (path: string) => path === "/queue" ? json({queue_running: [1], queue_pending: []}) : json({}));
    expect(await freeIdleWorkerForMemory(call)).toBe("busy");
    expect(call.mock.calls.map(([path]) => path)).toEqual(["/queue"]);
  });

  it("frees an empty worker and reports it", async () => {
    const call = vi.fn(async (path: string) => path === "/queue" ? json({queue_running: [], queue_pending: []}) : json({}));
    expect(await freeIdleWorkerForMemory(call)).toBe("freed");
    expect(call.mock.calls.map(([path]) => path)).toEqual(["/queue", "/free"]);
  });

  it("reports unavailable when the queue cannot be read or the free call fails", async () => {
    expect(await freeIdleWorkerForMemory(async () => json(null, false))).toBe("unavailable");
    expect(await freeIdleWorkerForMemory(async () => json({running: []}))).toBe("unavailable");
    expect(await freeIdleWorkerForMemory(async (path: string) => path === "/queue" ? json({queue_running: [], queue_pending: []}) : json(null, false))).toBe("unavailable");
    expect(await freeIdleWorkerForMemory(async () => { throw new Error("offline"); })).toBe("unavailable");
  });
});
