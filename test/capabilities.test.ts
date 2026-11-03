import { describe, it, expect } from "vitest";
import { providers, enhancers } from "../src/pipelines/registry";
import { buildCatalogue, plannedCapabilities } from "../src/capabilities/catalogue";
import { validateCapability } from "../src/capabilities/validate";
import { capabilityReadiness } from "../src/capabilities/readiness";
import { assertIndependentProvider, assertLocalGraphPolicy, assertRoutePolicy, assertWorkerUrl } from "../src/capabilities/policy";
import { compileLocal } from "../src/capabilities/compile";
import { fromLegacy } from "../src/capabilities/legacy";
import type { Invocation } from "../src/capabilities/types";

const catalogue = buildCatalogue([...providers, ...enhancers]);
describe("independent capability contract", () => {
  it("does not use the first/last-frame template's example as the user's prompt",()=>{
    const provider=providers.find(candidate=>candidate.pipeline==="flf2v")!;
    const bundle=fromLegacy(provider.manifest,provider.template,provider.pipeline);
    expect(bundle.manifest.controls.find(control=>control.id==="prompt")?.default).toBe("");
    expect(bundle.manifest.controls.find(control=>control.id==="negative")?.default).toBe(provider.template[provider.manifest.inputs.negative!.node!].inputs.text);
  });
  it("adapts all six templates without mutating their graphs", () => {
    expect(catalogue.filter(b => b.template)).toHaveLength(6);
    for (const bundle of catalogue) expect(validateCapability(bundle)).toEqual([]);
  });
  it("keeps planned capability routes unsupported even with an online worker", () => {
    for (const m of plannedCapabilities) expect(capabilityReadiness(m, "local", { online: true, nodes: [], models: [], credentials: [] }).state).toBe("unsupported");
  });
  it("keeps GPU-qualified motion publicly ready and compilable without an experimental override",()=>{
    const provider=providers.find(candidate=>candidate.pipeline==="motion")!;
    const bundle=fromLegacy(provider.manifest,provider.template,provider.pipeline);
    const route=bundle.manifest.routes[0],nodes=route.requirements.filter(r=>r.kind==="node").map(r=>r.name);
    const models=route.requirements.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`);
    expect(route.implementation).toBe("implemented");
    expect(route.evidence.join(" ")).toContain("GPU-qualified 2026-10-18");
    // The template's example character and action are examples, never defaults.
    expect(bundle.manifest.controls.find(control=>control.id==="prompt")?.default).toBe("");
    expect(bundle.manifest.controls.find(control=>control.id==="motion_prompt")?.default).toBe("");
    expect(capabilityReadiness(bundle.manifest,"local",{online:true,nodes,models,credentials:[]})).toMatchObject({state:"ready"});
    const inputs=Object.fromEntries(bundle.manifest.inputs.map(port=>[port.id,`comfyfield-${port.id}.png`]));
    const invocation:Invocation={capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs,controls:{},audioPolicy:"mute"};
    expect(()=>compileLocal(bundle,invocation)).not.toThrow();
  });
  it("requires live node/model inventory before ready", () => {
    const { manifest } = catalogue.find(bundle=>bundle.manifest.routes[0]?.implementation==="implemented")!;
    const route = manifest.routes[0];
    expect(capabilityReadiness(manifest, "local", { online: false, nodes: [], models: [], credentials: [] }).state).toBe("offline");
    expect(capabilityReadiness(manifest, "local", { online: true, nodes: [], models: [], credentials: [] }).state).toBe("install_required");
    const nodes = route.requirements.filter(r => r.kind === "node").map(r => r.name);
    expect(capabilityReadiness(manifest, "local", { online: true, nodes, models: [], credentials: [] }).state).toBe("download_required");
    const models = route.requirements.filter(r => r.kind === "model").map(r => `${r.location}/${r.name}`);
    expect(capabilityReadiness(manifest, "local", { online: true, nodes, models, credentials: [] }).state).toBe("ready");
    expect(capabilityReadiness(manifest, "other", { online: true, nodes, models, credentials: [] }).state).toBe("unsupported");
  });
  it("distinguishes an unverified model folder from a confirmed missing model",()=>{
    const {manifest}=catalogue[0],route=manifest.routes[0],nodes=route.requirements.filter(r=>r.kind==="node").map(r=>r.name);
    const unverified=capabilityReadiness(manifest,"local",{online:true,nodes,models:[],credentials:[],objectInfoChecked:true,checkedModelFolders:[],inventoryIssues:[{scope:"models",folder:"diffusion_models",code:"request_failed"}]});
    expect(unverified.state).toBe("incompatible");expect(unverified.reasons.join(" ")).toContain("could not be inventoried");
    const folders=[...new Set(route.requirements.filter(r=>r.kind==="model").map(r=>r.location!))];
    const confirmed=capabilityReadiness(manifest,"local",{online:true,nodes,models:[],credentials:[],objectInfoChecked:true,checkedModelFolders:folders,inventoryIssues:[]});
    expect(confirmed.state).toBe("download_required");
  });
  it("denies forbidden providers, wrappers, origins and unreviewed custom nodes", () => {
    for (const provider of ["higgsfield", "Higgs_Field", "genjutsu", "pryx", "unknown"]) expect(() => assertIndependentProvider(provider)).toThrow();
    expect(() => assertIndependentProvider("wan", ["higgsfield"])).toThrow();
    expect(() => assertWorkerUrl("https://api.higgsfield.ai")).toThrow();
    expect(() => assertWorkerUrl("https://user:secret@worker.test")).toThrow();
    expect(() => assertLocalGraphPolicy({ a: { class_type: "SecretWrapper", inputs: {} } })).toThrow();
    expect(() => assertLocalGraphPolicy({ a: { class_type: "LoadImage", inputs: { image: "https://api.higgsfield.ai/x" } } })).toThrow();
    expect(() => assertLocalGraphPolicy({ a: { class_type: "CLIPTextEncode", inputs: { text: "Higgsfield inspired lighting" } } })).not.toThrow();
  });
  it("rejects hosted declarations on a local route", () => {
    expect(() => assertRoutePolicy({ ...catalogue[0].manifest.routes[0], upstreamProviders: ["wan"] })).toThrow();
  });
  it("compiles real graph bindings, validates types and keeps source immutable", () => {
    const provider = providers.find(p => p.pipeline === "t2v")!;
    const bundle = fromLegacy(provider.manifest, provider.template, provider.pipeline);
    const before = JSON.stringify(provider.template);
    const request: Invocation = { capabilityId: bundle.manifest.id, version: "1.0.0", routeId: "local", inputs: {}, controls: { prompt: "test prompt", seed: 42 }, audioPolicy: "mute" };
    const graph = compileLocal(bundle, request);
    const binding = provider.manifest.inputs.prompt;
    expect(graph[binding.node!].inputs[binding.field]).toBe("test prompt");
    expect(JSON.stringify(provider.template)).toBe(before);
    expect(() => compileLocal(bundle, { ...request, controls: { seed: -1 } })).toThrow();
    expect(() => compileLocal(bundle, { ...request, controls: { seed: "42" } })).toThrow();
    expect(() => compileLocal(bundle, { ...request, controls: { endpoint: "x" } })).toThrow();
    expect(() => compileLocal(bundle, { ...request, routeId: "hosted" })).toThrow();
    expect(() => compileLocal(bundle, { ...request, version: "0.0.0" })).toThrow();
  });
  it("applies a preset instruction while keeping the user prompt note",()=>{
    const provider=providers.find(p=>p.pipeline==="t2v")!;
    const bundle=fromLegacy(provider.manifest,provider.template,provider.pipeline);
    bundle.manifest.presets=[{id:"noir",title:"Noir",values:{prompt:"Low-key noir lighting.",seed:7}}];
    const request:Invocation={capabilityId:bundle.manifest.id,version:"1.0.0",routeId:"local",inputs:{},controls:{prompt:"A red cabin beside a frozen lake."},audioPolicy:"mute",presetId:"noir"};
    const graph=compileLocal(bundle,request);
    const promptBinding=provider.manifest.inputs.prompt;
    expect(graph[promptBinding.node!].inputs[promptBinding.field]).toBe("Low-key noir lighting.\n\nA red cabin beside a frozen lake.");
    expect(graph[provider.manifest.inputs.seed.node!].inputs[provider.manifest.inputs.seed.field]).toBe(7);
    expect(()=>compileLocal(bundle,{...request,presetId:"missing"})).toThrow("preset");
    bundle.manifest.presets=[{id:"broken",title:"Broken",values:{unknown:1}}];
    expect(()=>compileLocal(bundle,{...request,presetId:"broken"})).toThrow("unknown control");
  });
  it("requires server-resolved asset names and preserves enhancement transform", () => {
    const p = enhancers[0], b = fromLegacy(p.manifest, p.template, p.pipeline);
    const request: Invocation = { capabilityId: b.manifest.id, version: "1.0.0", routeId: "local", inputs: { source_video: "comfyfield-a.mp4" }, controls: { scale: 2 }, audioPolicy: "preserve" };
    const graph = compileLocal(b, request), binding = p.manifest.inputs.scale;
    expect(graph[binding.node!].inputs[binding.field]).toBe(0.5);
    expect(() => compileLocal(b, { ...request, inputs: { source_video: "../../private.mp4" } })).toThrow();
    expect(() => compileLocal(b, { ...request, inputs: {} })).toThrow();
    const muted = compileLocal(b, { ...request, audioPolicy: "mute" });
    expect(Object.values(muted).find(n => n.class_type === "CreateVideo")!.inputs).not.toHaveProperty("audio");
    expect(Object.values(graph).find(n => n.class_type === "CreateVideo")!.inputs).toHaveProperty("audio");
    expect(() => compileLocal(b, { ...request, audioPolicy: "replace" })).toThrow();
    expect(() => compileLocal(b, { ...request, audioPolicy: "mix" })).toThrow();
  });
  it("preserves each legacy resolution pair and rejects independent dimensions", () => {
    for (const p of providers.filter(candidate=>candidate.pipeline!=="motion")) {
      const b = fromLegacy(p.manifest, p.template, p.pipeline);
      const inputs = Object.fromEntries(b.manifest.inputs.map(port => [port.id, "comfyfield-fixture.png"]));
      const request: Invocation = { capabilityId: b.manifest.id, version: b.manifest.version, routeId: "local", inputs, controls: {}, audioPolicy: "mute" };
      for (const pair of Object.values(p.manifest.limits.resolutions)) expect(() => compileLocal(b, { ...request, controls: pair })).not.toThrow();
      expect(() => compileLocal(b, { ...request, controls: { width: 17, height: 17 } })).toThrow("resolution");
      expect(() => compileLocal(b, { ...request, controls: { width: 4096, height: 4096 } })).toThrow("resolution");
    }
  });
});
