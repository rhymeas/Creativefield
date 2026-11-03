import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {loadServerCatalogue} from "../server/catalogue";
import {compileLocal} from "../src/capabilities/compile";
import {capabilityReadiness} from "../src/capabilities/readiness";
import type {CapabilityBundle,CapabilityManifestV2} from "../src/capabilities/types";
import {validateCapability} from "../src/capabilities/validate";

const manifest=JSON.parse(readFileSync("native-workflows/instantid-sdxl-character/manifest.json","utf8")) as CapabilityManifestV2;
const template=JSON.parse(readFileSync("native-workflows/instantid-sdxl-character/template.api.json","utf8"));
const bundle:CapabilityBundle={manifest,template};
const local=manifest.routes.find(route=>route.id==="local")!;

describe("experimental InstantID character-reference foundation",()=>{
  it("validates the source-mapped manifest while naming missing nodes and models",()=>{
    expect(validateCapability(bundle)).toEqual([]);
    const readiness=capabilityReadiness(manifest,"local",{online:true,nodes:[],models:[],credentials:[],objectInfoChecked:true,checkedModelFolders:["instantid","controlnet","insightface","checkpoints"],inventoryIssues:[]});
    expect(readiness.state).toBe("install_required");
    expect(readiness.missing.map(requirement=>requirement.name)).toEqual(expect.arrayContaining([
      "InstantIDModelLoader","InstantIDFaceAnalysis","ApplyInstantID","ip-adapter.bin",
      "instantid/diffusion_pytorch_model.safetensors","models/antelopev2","sdxl/AlbedoBaseXL.safetensors"
    ]));
    expect(readiness.reasons.join(" ")).toContain("cubiq/ComfyUI_InstantID");
  });

  it("remains unsupported with a complete reported inventory and refuses compilation",()=>{
    const nodes=local.requirements.filter(requirement=>requirement.kind==="node").map(requirement=>requirement.name);
    const models=local.requirements.filter(requirement=>requirement.kind==="model").map(requirement=>`${requirement.location}/${requirement.name}`);
    expect(capabilityReadiness(manifest,"local",{online:true,nodes,models,credentials:[],objectInfoChecked:true,checkedModelFolders:["instantid","controlnet","insightface","checkpoints"],inventoryIssues:[]})).toEqual({
      state:"unsupported",reasons:["Experimental workflow has not passed qualification."],missing:[]
    });
    expect(()=>compileLocal(bundle,{capabilityId:"elements",version:"0.1.0",routeId:"local",inputs:{reference_image:"comfyfield-reference.png"},controls:{},audioPolicy:"mute"})).toThrow("Selected route is unavailable");
  });

  it("keeps hosted execution explicitly planned and unavailable",()=>{
    const readiness=capabilityReadiness(manifest,"hosted",{online:true,nodes:[],models:[],credentials:[]});
    expect(manifest.coverage).toEqual({local:"experimental",hosted:"planned"});
    expect(readiness).toEqual({state:"unsupported",reasons:["This execution route has not been implemented and qualified."],missing:[]});
  });

  it("replaces the planned elements placeholder without duplicating catalogue ids",async()=>{
    const catalogue=await loadServerCatalogue();
    expect(new Set(catalogue.map(item=>item.manifest.id)).size).toBe(catalogue.length);
    expect(catalogue.filter(item=>item.manifest.id==="elements")).toHaveLength(1);
    const elements=catalogue.find(item=>item.manifest.id==="elements")!;
    expect(elements.template).toBeDefined();
    expect(elements.manifest.category).toBe("identity");
    expect(elements.manifest.coverage).toEqual({local:"experimental",hosted:"planned"});
  });
});
