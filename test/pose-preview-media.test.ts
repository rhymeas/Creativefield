import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {readFile,writeFile,readdir,rm} from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {motionFixtures} from "./motion-fixtures";
import {normalizeMotionInput,type MotionMediaReceipt} from "../server/motion-media";
import {extractPoseSamples} from "../server/pose-preview-media";

describe("actual normalized driving frame sampling",()=>{
  let f:Awaited<ReturnType<typeof motionFixtures>>,receipt:MotionMediaReceipt;
  beforeAll(async()=>{f=await motionFixtures();const source=await f.makeStored("pose-driving","testsrc2=size=128x96:rate=24",24);receipt=await normalizeMotionInput(f.store,f.workspaceId,source.key);});
  afterAll(async()=>{if(f&&path.resolve(f.dir).startsWith(path.resolve((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform")+path.sep))await rm(f.dir,{recursive:true,force:true});});
  it("decodes six distinct actual frames with the frozen 24 FPS clock and cleans scratch",async()=>{
    const samples=await extractPoseSamples(f.store,f.workspaceId,receipt);expect(samples.frames.map(frame=>frame.frameIndex)).toEqual([0,5,9,14,18,23]);expect(samples.frames.map(frame=>frame.seconds)).toEqual([0,5/24,9/24,14/24,18/24,23/24]);expect(new Set(samples.frames.map(frame=>frame.sha256)).size).toBe(6);expect(samples.frames.every(frame=>frame.bytes.readUInt32BE(16)===128&&frame.bytes.readUInt32BE(20)===96)).toBe(true);expect((await readdir(f.store.root)).filter(name=>name.startsWith("pose-samples-"))).toEqual([]);
  });
  it("rejects a changed stored source and changed normalized pixels before returning samples",async()=>{
    for(const [key,message] of [[receipt.sourceKey,"changed before"],[receipt.normalizedKey,undefined]] as const){const file=await f.store.file(f.workspaceId,key),original=await readFile(file);try{await writeFile(file,"changed media");await expect(extractPoseSamples(f.store,f.workspaceId,receipt)).rejects.toThrow(message);}finally{await writeFile(file,original);}}
  });
  it("rejects a foreign receipt and cancellation without creating scratch",async()=>{
    await expect(extractPoseSamples(f.store,randomUUID(),receipt)).rejects.toThrow("another workspace");const abort=new AbortController();abort.abort();await expect(extractPoseSamples(f.store,f.workspaceId,receipt,abort.signal)).rejects.toThrow();expect((await readdir(f.store.root)).filter(name=>name.startsWith("pose-samples-"))).toEqual([]);
  });
});
