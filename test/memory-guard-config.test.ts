import {describe,it,expect} from "vitest";
import {idleUnloadMs,minFreeRamShare} from "../server/memory-guard";

describe("memory guard configuration",()=>{
  it("defaults to 15 % free RAM and five idle minutes",()=>{
    expect(minFreeRamShare(undefined)).toBe(0.15);
    expect(minFreeRamShare("")).toBe(0.15);
    expect(idleUnloadMs(undefined)).toBe(5*60_000);
  });
  it("accepts an operator override inside its range",()=>{
    expect(minFreeRamShare("0.1")).toBe(0.1);
    expect(minFreeRamShare("0.95")).toBe(0.95);
    expect(idleUnloadMs("60")).toBe(60*60_000);
    expect(idleUnloadMs("1440")).toBe(1440*60_000);
  });
  it("ignores values outside the range instead of trusting them",()=>{
    expect(minFreeRamShare("0.01")).toBe(0.15);
    expect(minFreeRamShare("0.99")).toBe(0.15);
    expect(minFreeRamShare("not a number")).toBe(0.15);
    expect(idleUnloadMs("0.5")).toBe(5*60_000);
    expect(idleUnloadMs("1441")).toBe(5*60_000);
    expect(idleUnloadMs("soon")).toBe(5*60_000);
  });
});
