import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {planUpscale,upscaleBundle,upscaleControls,UPSCALE_EXTRA_SHARE_LIMIT,UPSCALE_MODE,UPSCALE_PACK} from "../server/chain-upscale";
import type {CapabilityBundle} from "../src/capabilities/types";

/** The last step of every video result: one upscale, chained into the same request.
 *  See docs/TRANSFORM-VIDEO.md for the GPU timing this still owes. */
const pack=(id:string):CapabilityBundle=>({manifest:JSON.parse(readFileSync(`native-workflows/${id}/manifest.json`,"utf8")),template:JSON.parse(readFileSync(`native-workflows/${id}/template.api.json`,"utf8"))}) as CapabilityBundle;

describe("a video result is upscaled to at least 720p",()=>{
  it("doubles a 360p result to 720p",()=>{
    expect(planUpscale({width:640,height:360})).toEqual({scale:2,width:1280,height:720,reason:"720p"});
  });

  it("asks for 1080p only when the result is 480p or more and the extra pass is affordable",()=>{
    // 540p doubles straight to 1080p.
    expect(planUpscale({width:960,height:540})).toEqual({scale:2,width:1920,height:1080,reason:"1080p"});
    // 480p would need the 4x pass to reach 1080p; that pass is over the limit, so 960p it is.
    expect(planUpscale({width:854,height:480})).toEqual({scale:2,width:1708,height:960,reason:"720p"});
    // With a cheap 4x pass the bigger size is taken.
    expect(planUpscale({width:854,height:480},{2:0.15,4:0.2})).toMatchObject({scale:4,height:1920,reason:"1080p"});
  });

  it("reaches 720p from a small result even when that costs the bigger pass",()=>{
    const plan=planUpscale({width:426,height:240});
    expect(plan).toMatchObject({scale:4,height:960,reason:"720p"});
    expect(UPSCALE_EXTRA_SHARE_LIMIT).toBe(0.3);
  });

  it("leaves a result that is already 1080p alone, and rejects nothing it cannot read",()=>{
    expect(planUpscale({width:1920,height:1080})).toBeUndefined();
    expect(planUpscale({width:3840,height:2160})).toBeUndefined();
    expect(planUpscale({width:0,height:0})).toBeUndefined();
  });
});

describe("the chain runs the pack this workspace already has",()=>{
  it("picks the NVIDIA VFX pack by name",()=>{
    const chosen=upscaleBundle([pack("film-frame-interpolation"),pack(UPSCALE_PACK)]);
    expect(chosen?.manifest.id).toBe(UPSCALE_PACK);
    expect(upscaleControls({scale:2,width:1280,height:720,reason:"720p"})).toEqual({scale:2,mode:UPSCALE_MODE});
    expect(UPSCALE_MODE).toBe("ULTRA");
  });

  it("picks a local upscaler when the NVIDIA pack is absent",()=>{
    const base=pack(UPSCALE_PACK);
    const named:CapabilityBundle={template:base.template,manifest:{...base.manifest,id:"other-upscale",title:"Sharpen and upscale"}};
    expect(upscaleBundle([named])?.manifest.id).toBe("other-upscale");
  });

  it("does not chain a pack that cannot upscale a clip",()=>{
    expect(upscaleBundle([pack("film-frame-interpolation")])).toBeUndefined();
    expect(upscaleBundle([pack("vace-canny-restyle")])).toBeUndefined();
    expect(upscaleBundle([])).toBeUndefined();
  });
});
