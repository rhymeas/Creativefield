import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import type {CapabilityBundle,WorkerInventory} from "../src/capabilities/types";
import {validateCapability} from "../src/capabilities/validate";
import {assertLocalGraphPolicy} from "../src/capabilities/policy";
import {compileLocal} from "../src/capabilities/compile";
import {capabilityReadiness} from "../src/capabilities/readiness";
import {isImageWorkflow,isCreateVideoWorkflow} from "../src/capabilities/surfaces";
import {loadServerCatalogue} from "../server/catalogue";
import {modelDownloadUrl,modelDownloadSize} from "../src/capabilities/model-download";
const pack:CapabilityBundle={manifest:JSON.parse(readFileSync("native-workflows/z-image-turbo-t2i/manifest.json","utf8")),template:JSON.parse(readFileSync("native-workflows/z-image-turbo-t2i/template.api.json","utf8"))};
const models=pack.manifest.routes[0].requirements.filter(r=>r.kind==="model");
const inventory:WorkerInventory={online:true,nodes:pack.manifest.routes[0].requirements.filter(r=>r.kind==="node").map(r=>r.name),models:models.map(r=>r.location+"/"+r.name),credentials:[]};
describe("Z-Image Turbo local creation",()=>{
  it("loads from the server catalogue as a creation-only image workflow",async()=>{
    const actual=(await loadServerCatalogue()).find(b=>b.manifest.id===pack.manifest.id)!;
    expect(actual).toBeDefined();expect(validateCapability(actual)).toEqual([]);expect(isImageWorkflow(actual.manifest)).toBe(true);
    expect(actual.manifest.inputs).toEqual([]);expect(actual.manifest.imageInputContract).toBeUndefined();
    expect(actual.manifest.routes.map(r=>r.execution)).toEqual(["local_comfy"]);
    expect(actual.manifest.description).toContain("not Z-Image-Edit");
    assertLocalGraphPolicy(actual.template!);
    expect(()=>assertLocalGraphPolicy({x:{class_type:"UnreviewedImageEdit",inputs:{}}})).toThrow();
  });
  it("compiles real controls with the pinned official sampler defaults without mutating its template",()=>{
    const compiled=compileLocal(pack,{capabilityId:pack.manifest.id,version:pack.manifest.version,routeId:"local",inputs:{},controls:{prompt:"A ceramic cup",seed:7,width:768,height:1024},audioPolicy:"mute"});
    expect(compiled["27"].inputs.text).toBe("A ceramic cup");expect(compiled["13"].inputs).toMatchObject({width:768,height:1024});
    expect(compiled["3"].inputs).toMatchObject({seed:7,steps:8,cfg:1,sampler_name:"res_multistep",scheduler:"simple",denoise:1});
    expect(compiled["30"].inputs.type).toBe("lumina2");expect(compiled["11"].inputs.shift).toBe(3);
    expect(pack.template!["27"].inputs.text).toBe("");
  });
  it("requires the diffusion model and VAE while reusing an installed encoder",()=>{
    const worker={...inventory,models:["text_encoders/qwen_3_4b.safetensors"]};
    const result=capabilityReadiness(pack.manifest,"local",worker);
    expect(result.state).toBe("download_required");expect(result.missing.map(r=>r.name)).toEqual(expect.arrayContaining(["z_image_turbo_bf16.safetensors","ae.safetensors"]));
    expect(result.missing.some(r=>r.name==="qwen_3_4b.safetensors")).toBe(false);
    expect(capabilityReadiness(pack.manifest,"local",inventory).state).toBe("ready");
    expect(capabilityReadiness(pack.manifest,"local",{...inventory,nodes:inventory.nodes.filter(n=>n!=="EmptySD3LatentImage")}).state).toBe("install_required");
  });
  it("keeps source-video edits out of Create Video without removing real generation",async()=>{
    const all=await loadServerCatalogue();
    for(const id of ["video-edit","scail2-character-replace","vace-reference-restyle"]){const manifest=all.find(b=>b.manifest.id===id)?.manifest;if(manifest)expect(isCreateVideoWorkflow(manifest),id).toBe(false);}
    expect(all.some(b=>b.manifest.category==="t2v"&&isCreateVideoWorkflow(b.manifest))).toBe(true);
  });
  it("pins every model's official revision, download size and SHA-256",()=>{
    expect(models).toHaveLength(3);
    for(const model of models){expect(model.version).toMatch(/^sha256:[a-f0-9]{64}$/);expect(model.sourceRevision).toMatch(/^[a-f0-9]{40}$/);expect(model.bytes).toBeGreaterThan(1);expect(modelDownloadUrl(model)).toContain("/resolve/"+model.sourceRevision+"/split_files/");}
    expect(models.reduce((sum,m)=>sum+m.bytes!,0)).toBe(20690152836);
    expect(readFileSync("native-workflows/z-image-turbo-t2i/UPSTREAM-LICENSE","utf8")).toContain("Copyright (c) 2023-present Comfy Org");
  });
});
describe("explicit official model downloads",()=>{
  const model={id:"model:test",kind:"model" as const,name:"model.safetensors",source:"https://huggingface.co/Comfy-Org/example/blob/main/models/model.safetensors",instructions:"Install separately"};
  it("uses a direct download and pins a declared revision",()=>{
    const revision="a".repeat(40);expect(modelDownloadUrl({...model,sourceRevision:revision})).toBe("https://huggingface.co/Comfy-Org/example/resolve/"+revision+"/models/model.safetensors?download=true");
  });
  it.each(["http://huggingface.co/Comfy-Org/example/resolve/main/model.safetensors","https://huggingface.co.evil.test/Comfy-Org/example/resolve/main/model.safetensors","https://user:password@huggingface.co/Comfy-Org/example/resolve/main/model.safetensors","https://huggingface.co/Comfy-Org/example/resolve/main/model.safetensors?token=private","https://huggingface.co/Comfy-Org/example/resolve/main/model.safetensors#private","javascript:alert(1)","https://huggingface.co/Comfy-Org/example/resolve/main/install.exe"])("refuses untrusted or credential-bearing download URL %#",source=>{expect(modelDownloadUrl({...model,source})).toBeUndefined();});
  it("does not make a download for software, invalid revision or mismatched file",()=>{
    expect(modelDownloadUrl({...model,kind:"software"})).toBeUndefined();expect(modelDownloadUrl({...model,sourceRevision:"main"})).toBeUndefined();expect(modelDownloadUrl({...model,name:"other.safetensors"})).toBeUndefined();
  });
  it("formats published file sizes without claiming measured memory usage",()=>{
    expect(modelDownloadSize(12309866400)).toBe("11.46 GiB");expect(modelDownloadSize(335304388)).toBe("319.8 MiB");expect(modelDownloadSize(undefined)).toBeUndefined();expect(modelDownloadSize(-1)).toBeUndefined();
  });
});
