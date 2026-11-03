import {useState} from "react";
import {createRoot} from "react-dom/client";
import {ASSET_DRAG, ASSET_TYPE_DRAG} from "../../src/ds";
import {ReferenceReplacePanel} from "../../src/team/ReferenceReplacePanel";
import type {Call, Project, Workspace} from "../../src/team/api";
import "../../src/ds/tokens.css";
import "../../src/ds/components.css";
const call=(async (path:string,method?:string,body?:unknown)=>{
 if(path.includes("video-sources/prepare"))return {id:(body as {assetId:string}).assetId};
 if(path.includes("replace-clip-check"))return {frames:24,seconds:1};
 if(path.includes("characters"))return [];
 if(path.includes("assets?"))return {items:[],nextCursor:null};
 throw new Error(`Unexpected request ${method??"GET"} ${path}`);
}) as Call;
function Fixture(){
 const [draft,setDraft]=useState<Record<string,string>>({});
 const source=(id:string,type:string)=> <div draggable onDragStart={e=>{e.dataTransfer.setData(ASSET_DRAG,id);e.dataTransfer.setData(ASSET_TYPE_DRAG,type);}} style={{padding:20,background:"#444",margin:8}}>{id}</div>;
 return <div style={{display:"flex",gap:20}}><div>{source("fixture-video","video/mp4")}{source("fixture-image","image/png")}</div><div style={{width:350}}><ReferenceReplacePanel workspace={{id:"fixture"} as Workspace} project={{id:"project"} as Project} workerId="worker" call={call} canEdit onChanged={()=>{}} onCloudDraft={d=>setDraft(old=>JSON.stringify(old)===JSON.stringify(d.inputs)?old:d.inputs)}/></div><output aria-label="Draft">{JSON.stringify(draft)}</output></div>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
