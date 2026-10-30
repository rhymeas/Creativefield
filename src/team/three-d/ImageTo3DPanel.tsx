import {useState} from "react";
import {Button,EmptyState,Page} from "../../ds";
import type {CapabilityManifestV2} from "../../capabilities/types";
import type {Call,Project,User,Worker,Workspace} from "../api";
import {TeamComposer} from "../TeamComposer";
import {bestWorkerReadiness} from "../state";

export function imageTo3DWorkflows(catalogue:CapabilityManifestV2[]){
  return catalogue.filter(m=>m.category==="3d"&&m.inputs.some(p=>p.type==="image")&&m.outputs.some(p=>p.type==="model3d")&&m.routes.some(r=>r.execution==="local_comfy"&&r.implementation==="implemented"));
}
export function ImageTo3DPanel({user,workspace,project,catalogue,workers,call,canEdit,authorized,onQueued,initialWorkflow,initialAssetId,onOpenModels}:{initialAssetId?:string;initialWorkflow?:string;user:User;workspace:Workspace;project:Project;catalogue:CapabilityManifestV2[];workers:Worker[];call:Call;canEdit:boolean;authorized:boolean;onQueued:()=>void;onOpenModels?:()=>void}){
  const workflows=imageTo3DWorkflows(catalogue);
  const [selected,setSelected]=useState(initialWorkflow??"");
  const manifest=workflows.find(m=>m.id===selected)??workflows.find(m=>bestWorkerReadiness(m,workers).state==="ready")??workflows[0];
  if(initialWorkflow&&catalogue.length&&!workflows.some(m=>m.id===initialWorkflow))return <Page narrow><EmptyState title="This 3D workflow is unavailable" text="Choose an available workflow from the 3D workspace." action={<Button variant="secondary" onClick={()=>{location.hash="3d/image";}}>Image to 3D</Button>}/></Page>;
  if(!manifest)return <Page narrow><EmptyState title="No image-to-3D workflow loaded" text="Check Models for available workflows and their requirements." action={<Button variant="secondary" onClick={()=>{if(onOpenModels)onOpenModels();else location.hash="catalogue";}}>Models</Button>}/></Page>;
  /* The same page as Create Video, so the panel, its header and the bar above it land in the same place. */
  return <Page fill><TeamComposer key={`${project.id}:${manifest.id}:${initialAssetId??""}`} initialInputs={initialAssetId?{[manifest.inputs.find(p=>p.type==="image")!.id]:initialAssetId}:undefined} manifest={manifest} catalogue={workflows} workflowIds={workflows.map(m=>m.id)} onCapability={id=>{setSelected(id);location.hash=`3d/image/${id}`;}} user={user} workspace={workspace} project={project} workers={workers} call={call} canQueue={canEdit} authorized={authorized} onQueued={onQueued}/></Page>;
}
