import {describe,expect,it} from "vitest";
import {loadServerCatalogue} from "../server/catalogue";
import {compileLocal} from "../src/capabilities/compile";
import {assertLocalGraphPolicy} from "../src/capabilities/policy";

const load=async(id:string)=>(await loadServerCatalogue({log:()=>undefined})).find(b=>b.manifest.id===id)!;
const run=(bundle:Awaited<ReturnType<typeof load>>,inputs:Record<string,string>,controls:Record<string,string|number|boolean>,presetId?:string)=>compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs,controls,audioPolicy:bundle.manifest.audioPolicies[0],...(presetId?{presetId}:{})});

describe("local MiniMax H3 packs",()=>{
  it("fits H3 keyframes to the selected canvas without stretching them",async()=>{
    for(const id of ['h3-i2v','h3-flf2v']){
      const bundle=await load(id),graph=run(bundle,{start_image:'comfyfield-first.png',...(id==='h3-flf2v'?{end_image:'comfyfield-last.png'}:{})},{});
      expect(()=>assertLocalGraphPolicy(graph)).not.toThrow();
      expect(graph['105:104'].inputs.first_frame).toEqual(['cf:fit-first',0]);
      expect(graph['cf:fit-first'].class_type).toBe('ResizeAndPadImage');
      expect(graph['cf:fit-first'].inputs).toMatchObject({image:['114',0],target_width:['115',0],target_height:['115',1]});
      if(id==='h3-flf2v'){
        expect(graph['105:104'].inputs.last_frame).toEqual(['cf:fit-last',0]);
        expect(graph['cf:fit-last'].inputs).toMatchObject({image:['116',0],target_width:['115',0],target_height:['115',1]});
      }
    }
  });
  it("OpenJutsu swap: one length reaches the trim and the H3 preparation, without an anchor frame",async()=>{
    const bundle=await load("openjutsu-h3-swap");
    expect(()=>assertLocalGraphPolicy(bundle.template!)).not.toThrow();
    const graph=run(bundle,{source_video:"comfyfield-clip.mp4",character_image:"comfyfield-face.png"},{seconds:10,resolution:768,start_time:2});
    expect([graph.trim.inputs.duration,graph["31"].inputs.duration_seconds,graph["31"].inputs.resolution,graph.trim.inputs.start_time]).toEqual([10,10,768,2]);
    // The first-frame analysis must use the trimmed, prepared video.
    expect(graph.trim.inputs.video).toEqual(["30",0]);
    expect(graph["31"].inputs.video).toEqual(["trim",0]);
    expect(graph["102"].inputs.image).toEqual(["31",0]);
    expect(graph["803"].inputs.source).toEqual(["31",0]);
    expect(graph.anchor_image).toBeUndefined();expect(graph["803"].inputs.use_anchor).toBe(false);
    expect([graph["30"].inputs.file,graph["9"].inputs.image]).toEqual(["comfyfield-clip.mp4","comfyfield-face.png"]);
    expect(bundle.manifest.credit?.url).toMatch(/^https:\/\/github\.com\/Comfy-Org\/comfy-openjutsu\//);
  });
  it("MiniMax H3 video defaults to 720p and 10 s; Quick makes a 480p 5 s draft",async()=>{
    const bundle=await load("minimax-h3-video");
    expect(()=>assertLocalGraphPolicy(bundle.template!)).not.toThrow();
    const standard=run(bundle,{character_image:"comfyfield-face.png"},{prompt:"a walk in the park"});
    // The size lives in its own nodes since the Sharpen stage reads it (sh:w / sh:h).
    expect([standard["sh:w"].inputs.value,standard["sh:h"].inputs.value,standard["6"].inputs.length]).toEqual([1280,704,243]);
    const quick=run(bundle,{character_image:"comfyfield-face.png"},{prompt:"a walk in the park"},"quick-480p-5s");
    expect([quick["sh:w"].inputs.value,quick["sh:h"].inputs.value,quick["6"].inputs.length]).toEqual([832,480,124]);
  });
  it("Effect clips: each card is an official H3 effect embedding with a site-local picture",async()=>{
    const bundle=await load("h3-effects");
    expect(bundle.manifest.presets.length).toBe(7);
    for(const preset of bundle.manifest.presets){expect(String(preset.values.prompt)).toMatch(new RegExp(`^embedding:minimaxh3_${preset.id} `));expect(preset.thumb).toBe(`/examples/effects/${preset.id}.webp`);}
    for(const preset of bundle.manifest.presets){
      const combined=run(bundle,{character_image:"comfyfield-face.png"},{prompt:"A blue jacket in the rain"},preset.id);
      expect(String(combined["6"].inputs.prompt)).toBe(`${preset.values.prompt}\n\nA blue jacket in the rain`);
      expect(combined["50"].inputs.image).toBe("comfyfield-face.png");
    }
    const graph=run(bundle,{character_image:"comfyfield-face.png"},{},"fire_breath");
    expect(String(graph["6"].inputs.prompt)).toMatch(/^embedding:minimaxh3_fire_breath /);expect([graph["sh:w"].inputs.value,graph["sh:h"].inputs.value]).toEqual([480,832]);
  });
  it("a preset picture from outside the site is refused",async()=>{
    const bundle=structuredClone(await load("h3-effects"));bundle.manifest.presets[0].thumb="https://example.com/x.png";
    const {validateCapability}=await import("../src/capabilities/validate");expect(validateCapability(bundle).join(";")).toMatch(/Invalid preset picture/);
  });
});
