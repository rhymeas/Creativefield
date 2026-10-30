import {useState} from "react";
import {Button,EmptyState,Meta,Page} from "../../ds";
import type {CapabilityManifestV2} from "../../capabilities/types";
import type {Call,Project,User,Worker,Workspace} from "../api";
import {TeamComposer} from "../TeamComposer";
import {bestWorkerReadiness} from "../state";
export function textReferenceWorkflows(catalogue:CapabilityManifestV2[]){return catalogue.filter(m=>m.category==="image"&&m.outputs.some(p=>p.type==="image")&&!m.inputs.some(p=>p.required)&&m.routes.some(r=>r.execution==="local_comfy"&&r.implementation==="implemented"));}
export function TextTo3DPanel({catalogue,user,workspace,project,workers,call,canEdit,authorized,onQueued}:{catalogue:CapabilityManifestV2[];user:User;workspace:Workspace;project:Project;workers:Worker[];call:Call;canEdit:boolean;authorized:boolean;onQueued:()=>void}){
 const choices=textReferenceWorkflows(catalogue),[selected,setSelected]=useState("");const manifest=choices.find(m=>m.id===selected)??choices.find(m=>bestWorkerReadiness(m,workers).state==="ready")??choices[0];
 if(!manifest)return <Page narrow><EmptyState title="Text reference generation is unavailable" text="No local text-to-image contract is loaded. You can use an existing Library image to create a 3D model." action={<Button variant="secondary" onClick={()=>{location.hash="3d/image";}}>Use a Library image</Button>}/></Page>;
 return <Page fill><TeamComposer key={`${project.id}:${manifest.id}`} workflowInfo={<Meta>First create a reference image from your description. Use for 3D carries a completed image into the model panel. Each stage starts only when you press Generate; this is not direct text-to-mesh. For a clean model describe one object on a pure white background with no shadow; a grey or busy backdrop can become part of the model.</Meta>} top={<><Button variant="secondary" onClick={()=>{location.hash="3d/image";}}>Use a Library image instead</Button></>} manifest={manifest} catalogue={choices} workflowIds={choices.map(m=>m.id)} onCapability={setSelected} user={user} workspace={workspace} project={project} workers={workers} call={call} canQueue={canEdit} authorized={authorized} onQueued={onQueued} onUseImage={id=>{location.hash=`3d/image/auto/${id}`;}}/></Page>;
}
