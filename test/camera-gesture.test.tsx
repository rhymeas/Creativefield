import {readFileSync} from "node:fs";
import {describe,expect,it,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import type {CapabilityBundle,CapabilityManifestV2} from "../src/capabilities/types";
import {compileLocal} from "../src/capabilities/compile";
import {buildCatalogue} from "../src/capabilities/catalogue";
import {providers,enhancers} from "../src/pipelines/registry";
import {defaultDraft} from "../src/team/state";
import {CAMERA_SPEEDS,TeamComposer,resolutionLabel} from "../src/team/TeamComposer";
import {nativeCameraGesture,nativeCameraMoves,nativeCameraPose} from "../src/team/camera-controls";

vi.mock("../src/team/TeamLibrary",()=>({TeamRuns:()=>null}));

const manifest:CapabilityManifestV2=JSON.parse(readFileSync("native-workflows/wan22-fun-camera/manifest.json","utf8"));
const bundle:CapabilityBundle={manifest,template:JSON.parse(readFileSync("native-workflows/wan22-fun-camera/template.api.json","utf8"))};
const renderComposer=(m:CapabilityManifestV2)=>renderToStaticMarkup(<TeamComposer manifest={m} catalogue={[m]} onCapability={()=>{}} user={{id:"u",email:"u@example.test"}} workspace={{id:"w",name:"Studio",role:"admin"}} project={{id:"p",name:"Film"}} workers={[]} call={async()=>{throw new Error("SSR must not call the API");}} canQueue authorized onQueued={()=>{}}/>);

describe("native camera gestures",()=>{
  it("binds each admitted gesture to native geometry without rewriting the prompt",()=>{
    for(const move of nativeCameraMoves(manifest)){
      const pose=nativeCameraPose(manifest,move.id)!;
      expect(nativeCameraGesture(manifest,pose)).toBe(move.id);
      const graph=compileLocal(bundle,{capabilityId:manifest.id,version:manifest.version,routeId:"local",inputs:{start_image:"comfyfield-frame.png"},controls:{...defaultDraft(manifest).controls,prompt:"Keep the red coat",camera_pose:pose,speed:1.5},audioPolicy:"mute"});
      expect(graph["108"].inputs).toMatchObject({camera_pose:move.pose,speed:1.5});
      expect(graph["107"].inputs.text).toBe("Keep the red coat");
    }
    expect(nativeCameraMoves(manifest)).toHaveLength(6);
    expect(nativeCameraPose(manifest,"")).toBe("Static");
    expect(nativeCameraPose(manifest,"arbitrary-curve")).toBeUndefined();
  });

  it("omits absent, disabled and unrelated graph controls",()=>{
    const restricted={...manifest,controls:manifest.controls.map(control=>control.id==="camera_pose"?{...control,options:["Static","Pan Left"]}:control)};
    expect(nativeCameraMoves(restricted).map(move=>move.id)).toEqual(["pan-left"]);
    expect(nativeCameraPose(restricted,"zoom-in")).toBeUndefined();
    expect(nativeCameraMoves({...manifest,id:"other"})).toEqual([]);
    expect(nativeCameraMoves({...manifest,controls:manifest.controls.map(control=>({...control,disabledReason:"Unavailable"}))})).toEqual([]);
  });

  it("renders the native gesture and trajectory in the main panel",()=>{
    const html=renderComposer(manifest);
    expect(html).toContain("Camera gesture");
    expect(html).toContain("Camera move");
    expect(html).toContain("straight pan or zoom");
    // Speed is a quick setting beside Duration now, not a bare number field under the stage.
    expect(html).not.toContain("Camera speed");
  });

  it("says the frame size the camera really makes",()=>{
    expect(resolutionLabel(640,640)).toBe("640 × 640");
    expect(resolutionLabel(832,480)).toBe("832 × 480");
    const html=renderComposer(manifest);
    expect(html).toContain("640 × 640");
    expect(html).not.toContain("Square");
    expect(html).not.toContain("640p");
  });

  it("offers the whole camera speed range in half steps",()=>{
    const speed=manifest.controls.find(control=>control.id==="speed")!;
    expect(CAMERA_SPEEDS[0]).toBe(speed.min);
    expect(CAMERA_SPEEDS.at(-1)).toBe(speed.max);
    expect(CAMERA_SPEEDS).toContain(speed.default);
  });

  it("tells the truth when an image-to-video move is added to the prompt",()=>{
    const i2v=buildCatalogue([...providers,...enhancers]).find(entry=>entry.manifest.id==="wan22-i2v-14b")!.manifest;
    const html=renderComposer(i2v);
    expect(html).toContain("Camera move");
    expect(html).toContain("added to the start of your prompt");
    expect(html).not.toContain("stays yours");
  });
});
