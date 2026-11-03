import {afterEach,describe,expect,it} from "vitest";
import {rm} from "node:fs/promises";
import {assertBackgroundMaskRegions} from "../server/masked-media";
import {maskFixtures} from "./masked-fixtures";
describe("protected-subject background masks",()=>{
  let dir:string|undefined;
  afterEach(async()=>{if(dir){if(!dir.replaceAll("\\","/").startsWith((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp").replaceAll("\\","/") + "/comfyfield-platform/mask-fixture-"))throw Error("Unexpected fixture directory");await rm(dir,{recursive:true,force:true});dir=undefined;}});
  it("accepts a decoded mask with both edited background and protected subject on every frame",async()=>{
    const f=await maskFixtures();dir=f.dir;
    await expect(assertBackgroundMaskRegions(f.mask,160,96,17)).resolves.toBeUndefined();
  });
  it("rejects a lost subject at the actual frame rather than allowing full-frame background edits",async()=>{
    const f=await maskFixtures();dir=f.dir;
    const lost=await f.make("lost-subject","color=c=white:s=160x96:r=16,drawbox=x=32:y=16:w=64:h=64:color=black:t=fill:enable='lt(n,8)'");
    await expect(assertBackgroundMaskRegions(lost,160,96,17)).rejects.toThrow(/No protected subject was found in frame 9/);
  });
  it("rejects masks with no editable background",async()=>{
    const f=await maskFixtures();dir=f.dir;
    const black=await f.make("no-background","color=c=black:s=160x96:r=16");
    await expect(assertBackgroundMaskRegions(black,160,96,17)).rejects.toThrow(/No editable background was found in frame 1/);
  });
});
