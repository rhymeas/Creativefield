import type {CapabilityManifestV2} from "../capabilities/types";
import {isImageWorkflow,isVideoWorkflow} from "../capabilities/surfaces";
import {isFlashVideoCreate,isSelectedVideoCreate} from "../capabilities/tasks";
/** Every runnable contract has a native panel; Nodes stays an explicit advanced action. */
export function nativeWorkflowHash(m:CapabilityManifestV2):string {
  if(m.imageInputContract)return "#imageedit";
  if(m.category==="3d"&&m.inputs.some(p=>p.type==="image")&&m.outputs.some(p=>p.type==="model3d"))return `#3d/image/${m.id}`;
  if(isImageWorkflow(m))return `#image/${m.id}`;
  if(m.id==="h3-object-swap")return `#workflow/${m.id}`;
  if(isSelectedVideoCreate(m.id)&&!isFlashVideoCreate(m.id))return `#workflow/${m.id}`;
  if(isVideoWorkflow(m))return `#video/${m.id}`;
  return `#workflow/${m.id}`;
}
