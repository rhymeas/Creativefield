import {describe,expect,it} from "vitest";
import {loadServerCatalogue} from "../server/catalogue";
import {compileLocal} from "../src/capabilities/compile";
import {validateCapability} from "../src/capabilities/validate";

const request=(bundle:Awaited<ReturnType<typeof loadServerCatalogue>>[number],inputs:Record<string,string>,controls:Record<string,string|number|boolean>)=>({capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs,controls,audioPolicy:"mute" as const});

describe("imported utility packs",()=>{
  it("one size control reaches both scale nodes of Join two clips",async()=>{
    const bundle=(await loadServerCatalogue({log:()=>undefined})).find(b=>b.manifest.id==="video-concat-2")!;
    const graph=compileLocal(bundle,request(bundle,{first_video:"comfyfield-a.mp4",second_video:"comfyfield-b.mp4"},{width:640,height:360}));
    expect([graph["3"].inputs.width,graph["6"].inputs.width]).toEqual([640,640]);
    expect([graph["3"].inputs.height,graph["6"].inputs.height]).toEqual([360,360]);
    expect([graph["1"].inputs.file,graph["4"].inputs.file]).toEqual(["comfyfield-a.mp4","comfyfield-b.mp4"]);
  });
  it("a second binding that points at a missing field is refused when the pack loads",async()=>{
    const bundle=structuredClone((await loadServerCatalogue({log:()=>undefined})).find(b=>b.manifest.id==="video-concat-2")!);
    bundle.manifest.controls[0].alsoBindings=[{node:"6",field:"not_a_field"}];
    expect(validateCapability(bundle).join(";")).toMatch(/Invalid binding: width/);
    expect(()=>compileLocal(bundle,request(bundle,{first_video:"comfyfield-a.mp4",second_video:"comfyfield-b.mp4"},{width:640,height:360}))).toThrow(/Unbound control: width/);
  });
  it("Remove video background declares both files its graph writes",async()=>{
    const bundle=(await loadServerCatalogue({log:()=>undefined})).find(b=>b.manifest.id==="video-bg-remove-birefnet")!;
    expect(Object.values(bundle.template!).map(n=>n.class_type)).toEqual(expect.arrayContaining(["SaveWEBM","SaveVideo"]));
    expect(bundle.manifest.outputs.map(o=>o.id)).toEqual(["cutout","matte"]);
  });
  it("every imported pack names where it comes from, with an https link",async()=>{
    const ids=["bg-remove-birefnet","upscale-image-esrgan","scene-mesh-moge","palette-transfer-image","image-face-mosaic-sam3","video-trim","video-concat-2","kenburns-still","video-bg-remove-birefnet"];
    const catalogue=await loadServerCatalogue({log:()=>undefined});
    for(const id of ids){const credit=catalogue.find(b=>b.manifest.id===id)!.manifest.credit;expect(credit?.name,id).toBe("Fuobe");expect(credit?.url.startsWith("https://github.com/workingprototype/Fuobe/"),id).toBe(true);}
  });
  it("a credit that is not an https link is refused",async()=>{
    const bundle=structuredClone((await loadServerCatalogue({log:()=>undefined})).find(b=>b.manifest.id==="video-trim")!);
    bundle.manifest.credit={name:"x",url:"javascript:alert(1)",license:"MIT",what:"w"};
    expect(validateCapability(bundle).join(";")).toMatch(/Invalid credit/);
  });
});
