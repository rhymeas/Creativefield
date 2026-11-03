import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {compileLocal} from "../src/capabilities/compile";
import {assertLocalGraphPolicy} from "../src/capabilities/policy";
import {capabilityReadiness} from "../src/capabilities/readiness";
import {expectedGenerationFrames} from "../src/capabilities/timing";
import type {CapabilityBundle,CapabilityManifestV2} from "../src/capabilities/types";
import {validateCapability} from "../src/capabilities/validate";
import {nativeCameraGesture,nativeCameraMoves,nativeCameraPose} from "../src/team/camera-controls";
import {defaultDraft} from "../src/team/state";
import {loadServerCatalogue} from "../server/catalogue";

const manifest=JSON.parse(readFileSync("native-workflows/wan22-fun-camera/manifest.json","utf8")) as CapabilityManifestV2;
const template=JSON.parse(readFileSync("native-workflows/wan22-fun-camera/template.api.json","utf8"));
const bundle:CapabilityBundle={manifest,template};
const exactMoves=["Static","Pan Up","Pan Down","Pan Left","Pan Right","Zoom In","Zoom Out","Anti Clockwise (ACW)","ClockWise (CW)"];
const poseOptions=()=>manifest.controls.find(control=>control.id==="camera_pose")!.options!;
/** The composer's queue payload, compiled the way the server compiles it. */
function cameraGraph(controls:Record<string,unknown>={}){
  return compileLocal(bundle,{capabilityId:manifest.id,version:manifest.version,routeId:"local",inputs:{start_image:"comfyfield-frame.png"},controls:{...defaultDraft(manifest).controls,...controls},audioPolicy:"mute"});
}
function withPoses(options:Array<string|number>,extra:Partial<CapabilityManifestV2["controls"][number]>={}):CapabilityManifestV2{
  return {...manifest,controls:manifest.controls.map(control=>control.id==="camera_pose"?{...control,options,...extra}:control)};
}

describe("native Wan 2.2 Fun Camera foundation",()=>{
  it("validates an independent local graph and exact backend bindings",()=>{
    expect(validateCapability(bundle)).toEqual([]);
    expect(()=>assertLocalGraphPolicy(template)).not.toThrow();
    const bindings=Object.fromEntries([...manifest.inputs,...manifest.controls].map(item=>[item.id,item.binding]));
    expect(bindings).toMatchObject({
      start_image:{node:"97",field:"image"},prompt:{node:"107",field:"text"},negative:{node:"99",field:"text"},
      camera_pose:{node:"108",field:"camera_pose"},speed:{node:"108",field:"speed"},width:{node:"108",field:"width"},
      height:{node:"108",field:"height"},length:{node:"108",field:"length",transform:"seconds_to_wan_frames"},seed:{node:"102",field:"noise_seed"}
    });
    expect(template["106"].class_type).toBe("SaveVideo");
    expect(template["105"].inputs.fps).toBe(16);
  });

  it("exposes only the native preset geometry and bounded speed",()=>{
    const move=manifest.controls.find(control=>control.id==="camera_pose")!;
    const speed=manifest.controls.find(control=>control.id==="speed")!;
    expect(move.options).toEqual(exactMoves);
    expect(speed).toMatchObject({min:0,max:10,step:0.1});
    expect(template["108"].inputs).toMatchObject({width:640,height:640,fx:0.5,fy:0.5,cx:0.5,cy:0.5});
    expect(JSON.stringify(manifest.controls).toLowerCase()).not.toMatch(/subject lock|lens|focus|drone|crane|arbitrary path/);
  });

  it("maps the qualified duration range to 4n+1 Wan frames",()=>{
    expect(expectedGenerationFrames(manifest,1)).toBe(17);
    expect(expectedGenerationFrames(manifest,5)).toBe(81);
  });

  it("pins both camera weights and enables the qualified local route only with complete inventory",()=>{
    const route=manifest.routes[0];
    const high=route.requirements.find(r=>r.id==="model:camera-high")!;
    const low=route.requirements.find(r=>r.id==="model:camera-low")!;
    expect(high.name).toBe("wan2.2_fun_camera_high_noise_14B_fp8_scaled.safetensors");
    expect(high.version).toBe("sha256:89a99cb5ab29e388f2e24fddac48eab4d88ca339d236c7a8d96aabacd0f525ae");
    expect(high.instructions).toContain("15,301,408,048-byte");
    expect(low.name).toBe("wan2.2_fun_camera_low_noise_14B_fp8_scaled.safetensors");
    expect(low.version).toBe("sha256:a2b7b361e3fad907958aa6ad662a3673bad5ffdce14706cffde4baabb98f9020");
    expect(low.instructions).toContain("15,301,408,048-byte");
    expect(manifest.routes.map(candidate=>candidate.id)).toEqual(["local","cloud"]);
    expect(route.execution).toBe("local_comfy");
    const nodes=route.requirements.filter(r=>r.kind==="node").map(r=>r.name);
    const models=route.requirements.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`);
    expect(capabilityReadiness(manifest,"local",{online:true,nodes:[],models:[],credentials:[]}).state).toBe("install_required");
    expect(capabilityReadiness(manifest,"local",{online:true,nodes,models,credentials:[]}).state).toBe("ready");
    expect(manifest.controls.find(c=>c.id==="length")?.default).toBe(1);
    expect(JSON.stringify(manifest).toLowerCase()).not.toMatch(/higgsfield|genjutsu|pryx/);
  });

  it("replaces the planned camera placeholder without duplicating catalogue entries",async()=>{
    const catalogue=await loadServerCatalogue();
    expect(new Set(catalogue.map(item=>item.manifest.id)).size).toBe(catalogue.length);
    expect(catalogue.filter(item=>item.manifest.id==="camera")).toHaveLength(1);
    const camera=catalogue.find(item=>item.manifest.id==="camera")!;
    expect(camera.template).toBeDefined();
    expect(camera.manifest.coverage.local).toBe("implemented");
  });
});

describe("native camera control contract",()=>{
  it("offers exactly the six straight gestures and no other move",()=>{
    expect(nativeCameraMoves(manifest).map(move=>[move.id,move.pose])).toEqual([
      ["pan-left","Pan Left"],["pan-right","Pan Right"],["pan-up","Pan Up"],["pan-down","Pan Down"],["zoom-in","Zoom In"],["zoom-out","Zoom Out"],
    ]);
    for(const move of nativeCameraMoves(manifest)){
      expect(poseOptions()).toContain(move.pose);
      expect(nativeCameraGesture(manifest,move.pose)).toBe(move.id);
    }
  });

  it("keeps the two rotating moves on the row and off the gesture stage",()=>{
    const rotating=["Anti Clockwise (ACW)","ClockWise (CW)"];
    expect(poseOptions()).toEqual(expect.arrayContaining(rotating));
    for(const pose of rotating){
      expect(nativeCameraMoves(manifest).map(move=>move.pose)).not.toContain(pose);
      expect(nativeCameraGesture(manifest,pose)).toBe("");
      expect(cameraGraph({camera_pose:pose})["108"].inputs.camera_pose).toBe(pose);
    }
    expect(nativeCameraGesture(manifest,"Static")).toBe("");
  });

  it("returns Static when a gesture is cleared, and never invents a pose",()=>{
    expect(nativeCameraPose(manifest,"")).toBe("Static");
    expect(nativeCameraPose(manifest,"pan-left")).toBe("Pan Left");
    expect(nativeCameraPose(manifest,"orbit")).toBeUndefined();
    expect(nativeCameraPose(withPoses(poseOptions().filter(pose=>pose!=="Static")),"")).toBeUndefined();
    expect(nativeCameraPose(withPoses(["Pan Left"]),"pan-left")).toBe("Pan Left");
  });

  it("follows the manifest options instead of a fixed gesture list",()=>{
    expect(nativeCameraMoves(withPoses([...poseOptions(),"Orbit"]))).toHaveLength(6);
    const withoutZoomOut=withPoses(poseOptions().filter(pose=>pose!=="Zoom Out"));
    expect(nativeCameraMoves(withoutZoomOut).map(move=>move.id)).toEqual(["pan-left","pan-right","pan-up","pan-down","zoom-in"]);
    expect(nativeCameraPose(withoutZoomOut,"zoom-out")).toBeUndefined();
    expect(nativeCameraMoves(withPoses(poseOptions(),{disabledReason:"Not available here"}))).toEqual([]);
    expect(nativeCameraMoves(withPoses(poseOptions(),{binding:undefined}))).toEqual([]);
    expect(nativeCameraPose(withPoses(poseOptions(),{binding:undefined}),"")).toBeUndefined();
    expect(nativeCameraMoves({...manifest,id:"wan22-i2v-14b"})).toEqual([]);
  });

  it("compiles the chosen pose and speed into the camera embedding node",()=>{
    const graph=cameraGraph({prompt:"Keep the red coat",camera_pose:"Pan Right",speed:4.5});
    expect(graph["108"].class_type).toBe("WanCameraEmbedding");
    expect(graph["108"].inputs).toMatchObject({camera_pose:"Pan Right",speed:4.5,width:640,height:640});
    expect(graph["108"].inputs.length).toBe(17);
    expect(graph["107"].inputs.text).toBe("Keep the red coat");
    expect(cameraGraph({camera_pose:nativeCameraPose(manifest,"")!})["108"].inputs.camera_pose).toBe("Static");
    expect(cameraGraph({camera_pose:"Zoom In",speed:0})["108"].inputs).toMatchObject({camera_pose:"Zoom In",speed:0});
  });

  it("rejects a pose the graph does not list, an empty pose and an out-of-range speed",()=>{
    expect(()=>cameraGraph({camera_pose:"Orbit"})).toThrow(/camera_pose/);
    expect(()=>cameraGraph({camera_pose:""})).toThrow(/camera_pose/);
    expect(()=>cameraGraph({speed:10.5})).toThrow(/speed/);
    expect(()=>cameraGraph({speed:-1})).toThrow(/speed/);
  });
});
