import {describe,expect,it} from "vitest";
import {readdir,readFile} from "node:fs/promises";
import {capability,capabilityHasControl} from "../src/capabilities/lookup";
import {REPLACE_CAPABILITY,PREPARE_CAPABILITY,DRESS_CAPABILITY,buildReplaceSteps,withIndexes} from "../src/team/reference-replace";
import {MESH_CAPABILITIES,PAINT_CAPABILITY,freezeTrueAngles,meshRunRequest,paintRunRequest} from "../src/image/true-angles";
import {MASK_CAPABILITY,EDIT_CAPABILITY,EDIT_REFERENCE_CAPABILITY,buildSwapSteps} from "../src/team/swap-thing";
import type {ReferencePlan} from "../src/workflow/reference-prompt";

const nativeRoot=new URL("../native-workflows/",import.meta.url);
it("does not offer a first-frame flag that Replace cannot admit",()=>{
  expect(capabilityHasControl("scail2-character-replace","preview")).toBe(false);
  expect(capabilityHasControl("scail2-character-replace","two_people")).toBe(true);
});
type NativeManifest={id:string;version:string};

/** Every native pack's manifest, read from disk: the same files the server loads into the catalogue. */
async function nativeManifests():Promise<NativeManifest[]>{
  const folders=(await readdir(nativeRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name);
  const found:NativeManifest[]=[];
  for(const folder of folders){
    const raw=await readFile(new URL(`${folder}/manifest.json`,nativeRoot),"utf8").catch(()=>undefined);
    if(raw)found.push(JSON.parse(raw) as NativeManifest);
  }
  return found;
}
async function manifest(folder:string):Promise<NativeManifest>{
  return JSON.parse(await readFile(new URL(`${folder}/manifest.json`,nativeRoot),"utf8")) as NativeManifest;
}

const scope={workspaceId:"w",projectId:"p",userId:"u",workerId:"k"};
const plan:ReferencePlan={video:"@Video 1",people:[{target:"person on the left",face:"@Image 1"}]};
const media={"@Video 1":"vid","@Image 1":"face1"};

describe("one source for a workflow id and version",()=>{
  it("answers with the id and version each native manifest declares, whatever its folder is called",async()=>{
    const all=await nativeManifests();
    expect(all.length).toBeGreaterThan(30);
    for(const {id,version} of all)expect(capability(id)).toEqual({id,version});
    // Folders whose name is not the id still answer by id.
    expect(capability("camera")).toEqual({id:"camera",version:(await manifest("wan22-fun-camera")).version});
    expect(capability("lip-sync")).toEqual({id:"lip-sync",version:(await manifest("wan21-infinitetalk")).version});
    expect(capability("elements")).toEqual({id:"elements",version:(await manifest("instantid-sdxl-character")).version});
  });

  it("refuses a name no manifest has, so a rename shows up at the screen",()=>{
    expect(()=>capability("scail2-character-replace-old")).toThrow("No workflow manifest has the id scail2-character-replace-old.");
  });

  it("sends the manifest version from the replace chain, the swap chain and the angle screens",async()=>{
    expect(REPLACE_CAPABILITY).toEqual({id:"scail2-character-replace",version:(await manifest("scail2-character-replace")).version});
    expect(PREPARE_CAPABILITY).toEqual({id:"flux2-klein-edit",version:(await manifest("flux2-klein-edit")).version});
    expect(DRESS_CAPABILITY).toEqual({id:"fibo2-edit",version:(await manifest("fibo2-edit")).version});
    expect(MASK_CAPABILITY).toEqual({id:"sam31-video-mask",version:(await manifest("sam31-video-mask")).version});
    expect(EDIT_CAPABILITY).toEqual({id:"wan21-vace-masked-edit",version:(await manifest("wan21-vace-masked-edit")).version});
    expect(EDIT_REFERENCE_CAPABILITY).toEqual({id:"wan21-vace-masked-edit-reference",version:(await manifest("wan21-vace-masked-edit-reference")).version});
    expect(MESH_CAPABILITIES.map(mesh=>[mesh.id,mesh.version])).toEqual([
      ["trellis2-image-to-3d",(await manifest("trellis2-image-to-3d")).version],
      ["hunyuan3d-21",(await manifest("hunyuan3d-21")).version],
    ]);
    expect(PAINT_CAPABILITY).toEqual({id:"fibo2-edit",version:(await manifest("fibo2-edit")).version});

    const {steps}=buildReplaceSteps(plan,withIndexes(plan),media);
    expect(steps.find(step=>step.id==="replace-0")?.version).toBe(REPLACE_CAPABILITY.version);
    expect(buildSwapSteps({video:"v",target:"car",prompt:"a bike"}).map(step=>[step.capabilityId,step.version])).toEqual([
      [MASK_CAPABILITY.id,MASK_CAPABILITY.version],[EDIT_CAPABILITY.id,EDIT_CAPABILITY.version],
    ]);

    const state=freezeTrueAngles("asset",scope,"00000000-0000-4000-8000-000000000001");
    expect(meshRunRequest(state).version).toBe(MESH_CAPABILITIES[0].version);
    expect(paintRunRequest({...state,renders:{"left-45":"render"}},"left-45").version).toBe(PAINT_CAPABILITY.version);
  });

  it("leaves no typed-in workflow version in the screens that queue one",async()=>{
    for(const file of ["src/team/reference-replace.ts","src/image/true-angles.ts","src/team/audio/SystemVoicePanel.tsx","src/team/swap-thing.ts"]){
      const source=await readFile(new URL(`../${file}`,import.meta.url),"utf8");
      expect(source,file).not.toMatch(/version\s*:\s*"\d/);
    }
  });
});
