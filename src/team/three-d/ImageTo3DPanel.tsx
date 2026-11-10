import {Page} from "../../ds";
import type {CapabilityManifestV2} from "../../capabilities/types";
import type {Call,Project,User,Worker,Workspace} from "../api";
import {TeamComposer} from "../TeamComposer";
export function ImageTo3DPanel({user,workspace,project,manifest,workflows,workers,call,canEdit,authorized,onQueued,initialAssetId,onCapability}:{initialAssetId?:string;manifest:CapabilityManifestV2;workflows:CapabilityManifestV2[];user:User;workspace:Workspace;project:Project;workers:Worker[];call:Call;canEdit:boolean;authorized:boolean;onQueued:()=>void;onCapability:(id:string)=>void}){
  /* The same page as Create Video, so the panel, its header and the bar above it land in the same place. */
  const imagePort=manifest.inputs.find(port=>port.type==="image");
  return <Page fill><TeamComposer key={`${project.id}:${manifest.id}:${initialAssetId??""}`}
    initialInputs={initialAssetId&&imagePort?{[imagePort.id]:initialAssetId}:undefined}
    manifest={manifest} catalogue={workflows} workflowIds={workflows.map(m=>m.id)} onCapability={onCapability}
    user={user} workspace={workspace} project={project} workers={workers} call={call}
    canQueue={canEdit} authorized={authorized} onQueued={onQueued}/></Page>;
}
