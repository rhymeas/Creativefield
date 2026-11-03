import {describe,it,expect} from "vitest";
import {buildCatalogue} from "../src/capabilities/catalogue";
import {providers} from "../src/pipelines/registry";
import {compileLocal} from "../src/capabilities/compile";
import {storyboardTiming} from "../server/storyboard-timing";
import {fromLegacy} from "../src/capabilities/legacy";
import {validateCapability} from "../src/capabilities/validate";
import {hasQualifiedDurationMapping} from "../src/capabilities/timing";
import type {ApiGraph} from "../src/workflow/build";

const bundle=buildCatalogue(providers).find(b=>b.manifest.category==="t2v")!;
const i2v=providers.find(p=>p.manifest.id==="wan22-i2v-14b")!;
describe("storyboard frame planning",()=>{
  it.each([16,24])("covers fractional cuts using the compiled %i fps binding",fps=>{
    const b=structuredClone(bundle);b.manifest.timing!.fps=fps;
    for(const outputFps of [24,25,30,60])for(const seconds of [1,1.04,1.4,1.5,2.18,4.99,5]){
      const planned=storyboardTiming(b.manifest,seconds,outputFps);
      const graph=compileLocal(b,{capabilityId:b.manifest.id,version:b.manifest.version,routeId:"local",inputs:{},controls:{length:planned.controlSeconds},audioPolicy:"mute"});
      const binding=b.manifest.controls.find(c=>c.id==="length")!.binding!;
      expect(graph[binding.node].inputs[binding.field]).toBe(planned.generationFrames);
      expect(planned.generationDurationSeconds).toBeGreaterThanOrEqual(planned.effectiveDurationSeconds);
      expect(planned.frames).toBe(Math.round(seconds*outputFps));
    }
  });
  it("preserves sufficient original controls and respects maximums before queueing",()=>{
    expect(storyboardTiming(bundle.manifest,1,24).controlSeconds).toBe(1);
    const m=structuredClone(bundle.manifest);m.timing!.fps=16;m.controls.find(c=>c.id==="length")!.max=1.5;
    expect(storyboardTiming(m,1.4,24).controlSeconds).toBe(1.5);
    m.controls.find(c=>c.id==="length")!.max=1.4;
    expect(()=>storyboardTiming(m,1.4,24)).toThrow("cannot cover");
    expect(()=>storyboardTiming(m,0.5,24)).toThrow("between");
    m.controls.find(c=>c.id==="length")!.binding!.transform=undefined;
    expect(()=>storyboardTiming(m,1,24)).toThrow("no qualified");
  });
  it.each([16,24])("covers seconds-expression cuts using independently evaluated graph/latent math at %i fps",fps=>{
    const legacy=structuredClone(i2v.manifest),template=structuredClone(i2v.template);
    legacy.limits.fps=fps;template["129:162"].inputs.value=fps;
    const b=fromLegacy(legacy,template,"i2v");
    for(const outputFps of [24,25,30,60])for(const seconds of [1,1.04,1.4,1.5,2.18,4.99,5]){
      const plan=storyboardTiming(b.manifest,seconds,outputFps);
      const graph=compileLocal(b,{capabilityId:b.manifest.id,version:b.manifest.version,routeId:"local",inputs:{start_image:"comfyfield-fixture.png"},controls:{length:plan.controlSeconds},audioPolicy:"mute"});
      const a=Number(graph["129:161"].inputs.value),rate=Number(graph["129:162"].inputs.value);
      expect(graph["129:163"].inputs.expression).toBe("floor (a * b + 1)");
      const requested=Math.floor(a*rate+1),latent=Math.floor((requested-1)/4)+1,decoded=latent*4-3;
      expect(plan.generationFrames).toBe(decoded);
      expect(decoded/rate).toBeGreaterThanOrEqual(plan.frames/outputFps);
      expect(plan.frames).toBe(Math.round(seconds*outputFps));
    }
  });
  it("plans 25 source frames for a fractional 14B shot without changing ordinary compilation",()=>{
    const b=fromLegacy(i2v.manifest,i2v.template,"i2v"),old=structuredClone(i2v.manifest);delete old.timing;
    const request={capabilityId:b.manifest.id,version:b.manifest.version,routeId:"local",inputs:{start_image:"comfyfield-fixture.png"},controls:{length:1.4},audioPolicy:"mute" as const};
    expect(compileLocal(b,request)).toEqual(compileLocal(fromLegacy(old,i2v.template,"i2v"),request));
    expect(hasQualifiedDurationMapping(fromLegacy(old,i2v.template,"i2v").manifest)).toBe(false);
    expect(storyboardTiming(b.manifest,1.4,24)).toMatchObject({frames:34,controlSeconds:1.5,generationFrames:25,generationFps:16});
    const m=structuredClone(b.manifest);m.controls.find(c=>c.id==="length")!.max=1.4;
    expect(()=>storyboardTiming(m,1.4,24)).toThrow("cannot cover");
    for(const bad of [0,NaN,Infinity])expect(()=>storyboardTiming(b.manifest,1.4,bad)).toThrow("frame rate");
    m.timing!.fps=NaN;expect(hasQualifiedDurationMapping(m)).toBe(false);
  });
  it.each([
    ["formula",(g:ApiGraph)=>{g["129:163"].inputs.expression="ceil(a*b)";}],
    ["duration link",(g:ApiGraph)=>{g["129:163"].inputs["values.a"]=["129:162",0];}],
    ["integer output",(g:ApiGraph)=>{g["129:98"].inputs.length=["129:163",0];}],
    ["fps",(g:ApiGraph)=>{g["129:162"].inputs.value=24;}],
    ["output fps",(g:ApiGraph)=>{g["129:94"].inputs.fps=16;}],
    ["output images",(g:ApiGraph)=>{g["129:94"].inputs.images=["97",0];}],
    ["sampler cycle",(g:ApiGraph)=>{g["129:86"].inputs.latent_image=["129:85",0];}],
    ["latent output",(g:ApiGraph)=>{g["129:86"].inputs.latent_image=["129:98",0];}],
    ["vae",(g:ApiGraph)=>{g["129:90"].inputs.vae_name="other.safetensors";}],
    ["save output",(g:ApiGraph)=>{g["108"].inputs.video=["97",0];}],
  ] as const)("rejects changed %s before qualifying timing",(_label,change)=>{
    const graph=structuredClone(i2v.template);change(graph);
    expect(()=>fromLegacy(i2v.manifest,graph,"i2v")).toThrow("timing binding");
    const b=fromLegacy(i2v.manifest,i2v.template,"i2v");b.template=graph;
    expect(validateCapability(b).join(" ")).toContain("timing binding");
  });
  it("rejects unsupported timing declarations and transform conflicts",()=>{
    const legacy=structuredClone(i2v.manifest);legacy.timing={frameMapping:"unknown" as never};
    expect(()=>fromLegacy(legacy,i2v.template,"i2v")).toThrow("timing declaration");
    const b=fromLegacy(i2v.manifest,i2v.template,"i2v");b.manifest.controls.find(c=>c.id==="length")!.binding!.transform="seconds_to_wan_frames";
    expect(hasQualifiedDurationMapping(b.manifest)).toBe(false);
    expect(validateCapability(b)).toContain("Invalid duration mapping");
  });
});
