import {useState} from "react";import {createRoot} from "react-dom/client";
import raw from "../../native-workflows/fibo2-edit/manifest.json";import type {CapabilityManifestV2} from "../../src/capabilities/types";
import {ImageStudio} from "../../src/image/ImageStudio";import {defaultImageDraft,imageDraftWithReferences,type ImageDraft} from "../../src/image/image-state";import type {Asset,Call} from "../../src/team/api";
import "../../src/ds/tokens.css";import "../../src/ds/components.css";import "../../src/team/team.css";
const edit=raw as unknown as CapabilityManifestV2,create:CapabilityManifestV2={...edit,id:"fixture-create",title:"Create",inputs:[]};
const asset=(id:string):Asset=>({id,project_id:"p",name:`${id}.png`,media_type:"image",content_type:"image/png",bytes:"1",created_at:"2026-01-01",parent_id:null});
const call:Call=async()=>[] as never;
function App(){const [model,setModel]=useState(create),[draft,setDraft]=useState<ImageDraft>(()=>defaultImageDraft(create));return <ImageStudio workspace={{id:"w",name:"Studio",role:"creator"}} project={{id:"p",name:"Test"}} manifest={model} readiness={{state:"ready",reasons:[],missing:[]}} assets={[asset("scene"),asset("reference")]} runs={[]} draft={draft} onDraftChange={setDraft} onGenerate={()=>{}} onModel={(_id,inputs)=>{setDraft(imageDraftWithReferences(edit,draft,inputs??{}));setModel(edit);}} modelOptions={[{value:"fibo2-edit",label:"Fibo"}]} batchContext={{userId:"u",workerId:"worker",call,onChanged:()=>{}}}/>;}
createRoot(document.getElementById("root")!).render(<App/>);
