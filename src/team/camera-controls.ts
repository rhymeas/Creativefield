import type {CapabilityManifestV2} from "../capabilities/types";

const GESTURE_POSES = [
  {id:"pan-left",label:"Pan left",pose:"Pan Left"},
  {id:"pan-right",label:"Pan right",pose:"Pan Right"},
  {id:"pan-up",label:"Pan up",pose:"Pan Up"},
  {id:"pan-down",label:"Pan down",pose:"Pan Down"},
  {id:"zoom-in",label:"Zoom in",pose:"Zoom In"},
  {id:"zoom-out",label:"Zoom out",pose:"Zoom Out"},
] as const;

/** Only offer gestures that the selected native graph can actually bind. */
export function nativeCameraMoves(manifest:CapabilityManifestV2){
  if(manifest.id!=="camera")return [];
  const control=manifest.controls.find(item=>item.id==="camera_pose"&&!item.disabledReason&&item.binding);
  return GESTURE_POSES.filter(move=>control?.options?.includes(move.pose));
}

export function nativeCameraGesture(manifest:CapabilityManifestV2,pose:unknown):string{
  return nativeCameraMoves(manifest).find(move=>move.pose===pose)?.id??"";
}

/** Clearing a gesture restores the graph's neutral trajectory when supported. */
export function nativeCameraPose(manifest:CapabilityManifestV2,gesture:string):string|undefined{
  if(gesture)return nativeCameraMoves(manifest).find(move=>move.id===gesture)?.pose;
  const control=manifest.id==="camera"?manifest.controls.find(item=>item.id==="camera_pose"&&!item.disabledReason&&item.binding):undefined;
  return control?.options?.includes("Static")?"Static":undefined;
}
