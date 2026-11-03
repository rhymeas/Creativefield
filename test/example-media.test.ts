import {afterEach,describe,expect,it,vi} from "vitest";
import {acceptsMediaType,readExampleFile} from "../src/ds/example-media";

afterEach(()=>vi.unstubAllGlobals());
describe("bundled example imports",()=>{
  it("returns a compatible example as a named file",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Blob(["video"],{type:"video/mp4"}))));
    const file=await readExampleFile("/reels/mj-00.mp4","video/mp4,video/quicktime");
    expect(file.name).toBe("mj-00.mp4");expect(file.type).toBe("video/mp4");
  });
  it("rejects incompatible types and external paths",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Blob(["video"],{type:"video/mp4"}))));
    await expect(readExampleFile("/reels/mj-00.mp4","image/*")).rejects.toThrow("does not match");
    await expect(readExampleFile("https://example.com/movie.mp4","video/*")).rejects.toThrow("cannot be used");
    await expect(readExampleFile("/examples/pool/../private.png","image/*")).rejects.toThrow("cannot be used");
  });
  it("accepts the image pool used by the workspace examples",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Blob(["image"],{type:"image/webp"}))));
    const file=await readExampleFile("/examples/pool/img-16.webp","image/*");
    expect(file.name).toBe("img-16.webp");expect(file.type).toBe("image/webp");
  });
  it("matches concrete and family drag types without accepting a different media kind",()=>{
    expect(acceptsMediaType("video/mp4,video/quicktime","video/*")).toBe(true);
    expect(acceptsMediaType("image/*","video/mp4")).toBe(false);
    expect(acceptsMediaType("image/png,image/jpeg","image/jpeg")).toBe(true);
    expect(acceptsMediaType("video/*","")).toBe(false);
  });
});
