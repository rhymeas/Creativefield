import {afterEach,describe,expect,it,vi} from "vitest";
import type {Pool} from "pg";
import {probeWorker} from "../server/workers";
import {hasRoomToStart,freeIdleWorkerForMemory,IdleUnloader} from "../server/memory-guard";
import {CLOUD_ONLY_REASON,capabilityReadiness} from "../src/capabilities/readiness";
import {CLOUD_PLAN_BLOCKED_REASON,cloudReadiness} from "../server/cloud-readiness";
import type {CapabilityBundle,CapabilityManifestV2,Requirement} from "../src/capabilities/types";

const fakeKey="fake-comfy-cloud-key-for-tests";
const cloudWorker={id:"w",workspace_id:"ws",origin:"https://cloud.comfy.org",api_prefix:"/api",kind:"cloud"};
const localWorker={id:"w",workspace_id:"ws",origin:"http://127.0.0.1:8188",api_prefix:"/api",kind:"local"};
const nodes:Requirement[]=[{id:"node:LoadImage",kind:"node",name:"LoadImage",instructions:"Install the ComfyUI node LoadImage."}];
const models:Requirement[]=[
  {id:"model:diffusion_models/flux.safetensors",kind:"model",name:"flux.safetensors",location:"diffusion_models",instructions:"Install the model in ComfyUI/models/diffusion_models/flux.safetensors."},
  {id:"model:vae/ae.safetensors",kind:"model",name:"ae.safetensors",location:"vae",instructions:"Install the model in ComfyUI/models/vae/ae.safetensors."},
];
function manifest(requirements:Requirement[]):CapabilityManifestV2{
  return {schemaVersion:2,id:"cloud-probe",version:"1.0.0",title:"Cloud probe",category:"test",description:"",inputs:[],outputs:[],controls:[],presets:[],
    routes:[{id:"local",execution:"local_comfy",provider:"comfy-local",upstreamProviders:[],implementation:"implemented",requirements,evidence:[]}],
    coverage:{local:"implemented",hosted:"planned"},licenses:{software:"test",weights:[]},sources:[],tickets:[],audioPolicies:["mute"]};
}
const bundle:CapabilityBundle={manifest:manifest([...nodes,...models])};
/** The smallest graph Cloud validates and then judges by plan, as read live on 2026-10-27. */
const PROBE_GRAPH={"1":{class_type:"PrimitiveString",inputs:{value:"ping"}},"2":{class_type:"PreviewAny",inputs:{source:["1",0]}}};
/** A Comfy Cloud that lists these nodes and takes the probe's submit, as a paid plan does. */
const cloudFetch=(objectInfo:Record<string,unknown>,prompt:()=>Response=()=>Response.json({prompt_id:"probe-prompt"}))=>vi.fn(async(input:string)=>input.endsWith("/object_info")
  ?Response.json(objectInfo)
  :prompt());

afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe("a Comfy Cloud worker tells the truth",()=>{
  it("probes object_info with the key and skips system stats and model folders",async()=>{
    vi.stubEnv("COMFY_CLOUD_API_KEY",fakeKey);
    const fetchMock=cloudFetch({LoadImage:{},KSampler:{}});
    vi.stubGlobal("fetch",fetchMock);
    const inventory=await probeWorker({query:vi.fn().mockResolvedValue({rows:[]})} as unknown as Pool,[bundle],cloudWorker);
    const [url,init]=fetchMock.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe("https://cloud.comfy.org/api/object_info");
    expect((init.headers as Record<string,string>).Authorization).toBe(`Bearer ${fakeKey}`);
    expect(inventory).toMatchObject({online:true,objectInfoChecked:true,nodes:["LoadImage","KSampler"],models:[],checkedModelFolders:[],modelInventory:"cloud",inventoryIssues:[],canSubmit:true});
    expect(inventory.hardware).toBeUndefined();
  });
  it("asks whether the key may submit with a graph Cloud validates, and reads a taken graph as yes",async()=>{
    // A key of its own, so one test's answer cannot be served from the once-an-hour cache.
    const key="probe-key-allowed";
    vi.stubEnv("COMFY_CLOUD_API_KEY",key);
    const fetchMock=cloudFetch({LoadImage:{}});
    vi.stubGlobal("fetch",fetchMock);
    const inventory=await probeWorker({query:vi.fn().mockResolvedValue({rows:[]})} as unknown as Pool,[bundle],cloudWorker);
    const [url,init]=fetchMock.mock.calls[1] as unknown as [string,RequestInit];
    expect(url).toBe("https://cloud.comfy.org/api/prompt");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string,string>).Authorization).toBe(`Bearer ${key}`);
    expect(JSON.parse(String(init.body))).toEqual({prompt:PROBE_GRAPH});
    expect(inventory).toMatchObject({canSubmit:true});
    expect(inventory.submitBlockedReason).toBeUndefined();
  });
  it("does not read a 400 about the graph as permission",async()=>{
    // The live service checks the graph before the plan, so its 400 says nothing about the plan.
    vi.stubEnv("COMFY_CLOUD_API_KEY","probe-key-graph-refused");
    vi.stubGlobal("fetch",cloudFetch({LoadImage:{}},()=>new Response(JSON.stringify({error:{message:"Prompt has no outputs",type:"VALIDATION_ERROR"}}),{status:400})));
    const inventory=await probeWorker({query:vi.fn().mockResolvedValue({rows:[]})} as unknown as Pool,[bundle],cloudWorker);
    expect(inventory.canSubmit).toBeUndefined();
    expect(inventory.submitBlockedReason).toBeUndefined();
  });
  it("keeps probing every endpoint on a local worker",async()=>{
    const fetchMock=vi.fn(async(input:string)=>{
      if(input.endsWith("/object_info"))return Response.json({LoadImage:{}});
      if(input.endsWith("/system_stats"))return Response.json({system:{ram_total:16*2**30,ram_free:8*2**30},devices:[]});
      return Response.json(["flux.safetensors"]);
    });
    vi.stubGlobal("fetch",fetchMock);
    const inventory=await probeWorker({query:vi.fn().mockResolvedValue({rows:[]})} as unknown as Pool,[bundle],localWorker);
    const urls=fetchMock.mock.calls.map(call=>call[0] as string);
    expect(urls).toEqual(["http://127.0.0.1:8188/api/object_info","http://127.0.0.1:8188/api/system_stats","http://127.0.0.1:8188/api/models/diffusion_models","http://127.0.0.1:8188/api/models/vae"]);
    expect(inventory.modelInventory).toBeUndefined();
    expect(inventory.checkedModelFolders).toEqual(["diffusion_models","vae"]);
    expect(inventory.hardware?.ramTotal).toBe(16*2**30);
  });
  it("is ready on verified nodes instead of calling Cloud model files incompatible",async()=>{
    vi.stubEnv("COMFY_CLOUD_API_KEY",fakeKey);
    vi.stubGlobal("fetch",cloudFetch({LoadImage:{}}));
    const inventory=await probeWorker({query:vi.fn().mockResolvedValue({rows:[]})} as unknown as Pool,[bundle],cloudWorker);
    expect(capabilityReadiness(bundle.manifest,"local",inventory).state).toBe("ready");
  });
  it("asks for a missing node in plain words and never says incompatible",async()=>{
    vi.stubEnv("COMFY_CLOUD_API_KEY",fakeKey);
    vi.stubGlobal("fetch",cloudFetch({KSampler:{}}));
    const inventory=await probeWorker({query:vi.fn().mockResolvedValue({rows:[]})} as unknown as Pool,[bundle],cloudWorker);
    const readiness=capabilityReadiness(bundle.manifest,"local",inventory);
    expect(readiness.state).toBe("install_required");
    expect(readiness.reasons).toEqual(["Comfy Cloud does not have LoadImage. Run this workflow on this computer instead."]);
    expect(readiness.missing.map(item=>item.id)).toEqual(["node:LoadImage"]);
  });
  it("never sends a Cloud worker /system_stats, /queue or /free",async()=>{
    const calls:string[]=[];
    const call=async(path:string)=>{calls.push(path);return Response.json({queue_running:[],queue_pending:[],system:{ram_total:100,ram_free:1}});};
    expect(await hasRoomToStart(call,undefined,"cloud")).toBe(true);
    expect(await freeIdleWorkerForMemory(call,"cloud")).toBe("unavailable");
    expect(await new IdleUnloader(0,()=>1_000_000).check("cloud-worker",call,false,"cloud")).toBe("idle");
    expect(calls).toEqual([]);
  });
  /* What POST /workers/:id/probe answers a cloud worker: the cloud route's own judgement, and the
     plan in one sentence when the key's account may not submit a run at all. */
  it("answers a cloud worker on its cloud route, and with the plan when the key may not submit",async()=>{
    const cloudOnly:CapabilityManifestV2={...manifest([...nodes,...models]),coverage:{local:"planned",hosted:"implemented"},
      routes:[{id:"cloud",execution:"comfy_cloud",provider:"comfy-cloud",upstreamProviders:[],implementation:"implemented",requirements:[...nodes,...models],evidence:[]}]};
    const inventory={online:true,objectInfoChecked:true,nodes:["LoadImage"],models:[],credentials:[],modelFiles:["flux.safetensors","ae.safetensors"],modelInventory:"cloud" as const,checkedModelFolders:[],inventoryIssues:[]};
    expect(capabilityReadiness(cloudOnly,"local",inventory)).toMatchObject({state:"unsupported",reasons:[CLOUD_ONLY_REASON]});
    expect(cloudReadiness(cloudOnly,"cloud",inventory)).toMatchObject({state:"ready",reasons:[]});
    expect(cloudReadiness(cloudOnly,"cloud",{...inventory,canSubmit:false})).toMatchObject({state:"unsupported",reasons:[CLOUD_PLAN_BLOCKED_REASON],missing:[]});
  });
});
