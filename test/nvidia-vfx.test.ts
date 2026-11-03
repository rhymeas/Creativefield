import {beforeAll,describe,expect,it} from "vitest";
import {loadServerCatalogue} from "../server/catalogue";
import {validateCapability} from "../src/capabilities/validate";
import type {CapabilityBundle} from "../src/capabilities/types";

const ID="nvidia-vfx-upscale";
let bundle:CapabilityBundle;

describe("NVIDIA VFX workflow pack",()=>{
  beforeAll(async()=>{
    const found=(await loadServerCatalogue()).find(item=>item.manifest.id===ID);
    if(!found)throw new Error(`${ID} is missing from the server catalogue`);
    bundle=found;
  });

  it("loads through the server catalogue and validates",()=>{
    expect(bundle.manifest.title).toBe("Sharpen and upscale");
    expect(bundle.manifest.category).toBe("enhance");
    expect(validateCapability(bundle)).toEqual([]);
    expect(bundle.manifest.routes).toEqual([
      expect.objectContaining({id:"local",execution:"local_comfy",provider:"comfy-local",implementation:"implemented",workflowId:ID}),
      expect.objectContaining({id:"cloud",execution:"comfy_cloud",provider:"comfy-cloud",implementation:"implemented",workflowId:ID,endpointOrigin:"https://cloud.comfy.org"}),
    ]);
  });

  it("uses the node classes and links from the published pack",()=>{
    const template=bundle.template!;
    expect(Object.fromEntries(Object.entries(template).map(([id,node])=>[id,node.class_type]))).toEqual({
      "1":"LoadVideo",
      "2":"GetVideoComponents",
      "3":"RTXVideoSuperResolution",
      "4":"CreateVideo",
      "5":"SaveVideo",
    });
    expect(template["2"].inputs.video).toEqual(["1",0]);
    expect(template["3"].inputs.images).toEqual(["2",0]);
    expect(template["4"].inputs.images).toEqual(["3",0]);
    expect(template["5"].inputs.video).toEqual(["4",0]);
    expect(template["3"].inputs).toEqual(expect.objectContaining({
      "resize_type":"scale by multiplier",
      "resize_type.scale":2,
      quality:"ULTRA",
      strength:1,
      image_encoding:"8-bit RGB",
    }));
  });

  it("keeps the source audio and frame rate and exposes only real controls",()=>{
    const template=bundle.template!;
    expect(bundle.manifest.inputs).toEqual([
      expect.objectContaining({id:"source_video",type:"video",required:true,binding:{node:"1",field:"file"}}),
    ]);
    expect(bundle.manifest.audioPolicies).toEqual(["preserve","mute"]);
    expect(template["4"].inputs.audio).toEqual(["2",1]);
    expect(template["4"].inputs.fps).toEqual(["2",2]);
    expect(bundle.manifest.controls).toEqual([
      expect.objectContaining({id:"scale",label:"Scale",type:"select",options:[2,4],default:2,binding:{node:"3",field:"resize_type.scale"}}),
      expect.objectContaining({id:"mode",label:"Mode",type:"select",options:["ULTRA","DENOISE_HIGH","DEBLUR_HIGH"],default:"ULTRA",binding:{node:"3",field:"quality"}}),
    ]);
    expect(bundle.manifest.routes[0].requirements).toContainEqual(expect.objectContaining({
      id:"node:RTXVideoSuperResolution",kind:"node",name:"RTXVideoSuperResolution",
    }));
    expect(bundle.manifest.routes[0].evidence.join(" ")).toContain("38d790d");
    expect(bundle.manifest.routes[0].evidence.join(" ")).toMatch(/not had a GPU run/i);
  });
});
