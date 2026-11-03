import {describe,expect,it} from "vitest";
import sharp from "sharp";
import {measurePreservation,estimateCropCanvasPixels,MAX_UPSCALED_CROP_PIXELS} from "../server/edit-preservation";
import {capabilitySurface,isImageWorkflow} from "../src/capabilities/surfaces";
import {validateEditPreservation} from "../src/capabilities/edit-preservation";
import {loadServerCatalogue} from "../server/catalogue";
import {compileLocal} from "../src/capabilities/compile";

const png=(data:Buffer,width=8,height=8)=>sharp(data,{raw:{width,height,channels:3}}).png().toBuffer();
describe("measured preservation, without replacing the upstream algorithm",()=>{
  it("excludes the effective feather band and counts only protected deltas over2/255",async()=>{
    const original=Buffer.alloc(8*8*3,100),final=Buffer.from(original),mask=Buffer.alloc(original.length);
    final[0]=255;mask[0]=mask[1]=mask[2]=1; // feather band is deliberately excluded
    final[3]=102; // exactly the declared channel tolerance
    final[6]=103; // one protected pixel exceeds it
    const result=await measurePreservation(await png(original),await png(final),await png(mask),true);
    expect(result.qa).toMatchObject({protectedPixels:63,changedProtectedPixels:1,maxChannelDelta:3,withinTolerance:false,channelTolerance:2});
    expect(result.qa.driftPercent).toBeCloseTo(100/63);
    const drift=await sharp(result.driftPng).greyscale().raw().toBuffer();
    expect(drift[0]).toBe(0);expect(drift[2]).toBe(255);
  });
  it("never claims protection when the mask contains no protected region",async()=>{
    const p=await png(Buffer.alloc(8*8*3,255));const {qa}=await measurePreservation(p,p,p);
    expect(qa).toMatchObject({protectedPixels:0,driftPercent:null,meanChannelDelta:null,withinTolerance:false});
  });
  it("rejects differently sized output rather than resizing it for a better score",async()=>{
    await expect(measurePreservation(await png(Buffer.alloc(8*8*3)),await png(Buffer.alloc(4*4*3),4,4),await png(Buffer.alloc(8*8*3)))).rejects.toThrow("aligned RGB");
  });
  it("validates the reviewed graph and rejects an unrelated text report source",async()=>{
    const bundle=(await loadServerCatalogue()).find(bundle=>bundle.manifest.id==="flux2-klein-preserve-edit")!;
    expect(validateEditPreservation(bundle)).toEqual([]);
    expect(capabilitySurface(bundle.manifest)).toBe("canvas");expect(isImageWorkflow(bundle.manifest)).toBe(false);
    expect(()=>compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_image:"comfyfield-original.png",edit_mask:"comfyfield-mask.png"},controls:Object.fromEntries(bundle.manifest.controls.map(c=>[c.id,c.default])),audioPolicy:"mute"})).not.toThrow();
    const altered=structuredClone(bundle);altered.template![altered.manifest.editPreservation!.reportNode].inputs.source=["76",0];
    expect(validateEditPreservation(altered)).toContain("Invalid upstream Klein/report wiring");
  });
  it("renders the Fibo edit at the crop dimensions expected by InpaintStitch",async()=>{
    const bundle=(await loadServerCatalogue()).find(bundle=>bundle.manifest.id==="flux2-klein-preserve-edit")!;
    const graph=bundle.template!;
    expect(graph["93"].class_type).toBe("TextEncodeFibo2");
    expect(graph["482"].inputs.force_width).toBe(768);
    expect(graph["482"].inputs.force_height).toBe(768);
    expect(graph["93"].inputs.width).toBe(graph["482"].inputs.force_width);
    expect(graph["93"].inputs.height).toBe(graph["482"].inputs.force_height);
    expect(graph["483"].inputs.inpainted_image).toEqual(["95",0]);
  });
  it("bounds the forced-size crop estimate for a tiny corner selection",()=>{
    const tiny={left:0,top:0,right:1,bottom:1};
    expect(estimateCropCanvasPixels(2048,2048,tiny,0,768,768)).toBeGreaterThan(MAX_UPSCALED_CROP_PIXELS);
    expect(estimateCropCanvasPixels(2048,2048,tiny,512,768,768)).toBeLessThan(MAX_UPSCALED_CROP_PIXELS);
  });
});
