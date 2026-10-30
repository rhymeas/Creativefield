import type {CapabilityManifestV2} from "../capabilities/types";
import {nativeCameraPose} from "./camera-controls";

/** The model whose camera moves are only a sentence in the prompt, and the one that moves the camera for real. */
export const CAMERA_ROUTE_PAIRS:Readonly<Record<string,string>>={"wan22-i2v-14b":"camera"};

export function cameraPair(manifest:CapabilityManifestV2,catalogue:CapabilityManifestV2[]){
  const id=CAMERA_ROUTE_PAIRS[manifest.id];
  return id?catalogue.find(m=>m.id===id&&m.coverage.local==="implemented"&&nativeCameraPose(m,"pan-left")!==undefined):undefined;
}

/**
 * A chosen camera move runs on the model with a fixed camera path: a prompt sentence is a wish the
 * model may ignore (measured: 1 % zoom in one second), a path is followed. Only controls that model
 * has are sent; its duration stops at its own maximum.
 */
export function cameraRoute(camera:CapabilityManifestV2,move:string,inputs:Record<string,string>,controls:Record<string,string|number|boolean>){
  const pose=nativeCameraPose(camera,move);
  if(pose===undefined||!inputs.start_image)return undefined;
  const wanted:Record<string,string|number|boolean>={...controls,camera_pose:pose};
  const sent:Record<string,string|number|boolean>={};
  for(const control of camera.controls){
    let value=wanted[control.id];
    if(value===undefined||value==="")continue;
    if(control.id==="width"||control.id==="height")continue;
    if(typeof value==="number"&&control.max!==undefined)value=Math.min(value,control.max);
    sent[control.id]=value;
  }
  return {capabilityId:camera.id,version:camera.version,inputs:{start_image:inputs.start_image},controls:sent};
}
