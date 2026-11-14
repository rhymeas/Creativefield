import {isOpenJutsuAdvanced} from "../capabilities/openjutsu-advanced";
import type {CapabilityManifestV2} from "../capabilities/types";
import {capabilitySurface,isCreateVideoWorkflow,isImageWorkflow,isVideoWorkflow} from "../capabilities/surfaces";
import {isEffectClips,isFlashVideoCreate,isSelectedVideoCreate} from "../capabilities/tasks";
import {VIDEO_REFRAME_HASH,VIDEO_REFRAME_ID} from "../capabilities/video-reframe";
import {isMaskedEdit} from "./masked-state";
import type {videoModeFromHash} from "./video-edit/state";

export type VideoWorkspaceMode=NonNullable<ReturnType<typeof videoModeFromHash>>|"workflow";

export function videoWorkflowMode(manifest:CapabilityManifestV2):VideoWorkspaceMode{
  if(manifest.id===VIDEO_REFRAME_ID)return "transform";
  if(manifest.id==="video-edit")return "trim";
  if(isMaskedEdit(manifest))return "edit";
  const surface=capabilitySurface(manifest);
  if(isEffectClips(manifest.id)||surface==="video-effect")return "effects";
  return isCreateVideoWorkflow(manifest)||surface==="video-enhance"?"create":"workflow";
}

/** Every runnable contract has a native panel; Nodes stays an explicit advanced action. */
export function nativeWorkflowHash(m:CapabilityManifestV2):string {
  if(isOpenJutsuAdvanced(m.id))return `#openjutsu/${m.id}`;
  if(m.id===VIDEO_REFRAME_ID)return VIDEO_REFRAME_HASH;
  if(m.imageInputContract)return "#imageedit";
  if(m.category==="3d"&&m.inputs.some(p=>p.type==="image")&&m.outputs.some(p=>p.type==="model3d"))return `#3d/image/${m.id}`;
  if(isImageWorkflow(m))return `#image/${m.id}`;
  if(m.id==="h3-object-swap")return `#workflow/${m.id}`;
  if(isSelectedVideoCreate(m.id)&&!isFlashVideoCreate(m.id))return `#workflow/${m.id}`;
  if(isVideoWorkflow(m))return `#video/${m.id}`;
  return `#workflow/${m.id}`;
}
