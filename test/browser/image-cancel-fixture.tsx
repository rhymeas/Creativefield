import {useState} from "react";
import {createRoot} from "react-dom/client";
import {ImageStudio} from "../../src/image/ImageStudio";
import {defaultImageDraft} from "../../src/image/image-state";
import type {CapabilityManifestV2} from "../../src/capabilities/types";
import "../../src/ds/tokens.css";
import "../../src/ds/components.css";
import "../../src/team/team.css";
const manifest:CapabilityManifestV2={schemaVersion:2,id:"image.fixture",version:"1",title:"Fixture",category:"t2i",description:"",inputs:[],outputs:[{id:"image",label:"Image",type:"image",required:true}],controls:[],presets:[],routes:[{id:"local",execution:"local_comfy",provider:"ComfyUI",upstreamProviders:[],implementation:"implemented",workflowId:"fixture",requirements:[],evidence:[]}],coverage:{local:"implemented",hosted:"planned"},licenses:{software:"MIT",weights:[]},sources:[],tickets:[],audioPolicies:["mute"]};
const run=(id:string)=>({id,project_id:"p",created_by:"u",capability_id:manifest.id,capability_version:"1",state:"running",error:null,output_ids:[],created_at:new Date().toISOString(),updated_at:new Date().toISOString()});
function App(){const [draft,setDraft]=useState(()=>defaultImageDraft(manifest)),[cancelled,setCancelled]=useState("");return <><output>{cancelled||"No cancellation"}</output><ImageStudio workspace={{id:"w",name:"Studio",role:"creator"}} project={{id:"p",name:"Test"}} manifest={manifest} readiness={{state:"ready",reasons:[],missing:[]}} assets={[]} runs={[run("first"),run("second")]} draft={draft} onDraftChange={setDraft} onGenerate={()=>{}} onCancel={async r=>setCancelled(r.id)} canCancelRun={()=>true}/></>;}
createRoot(document.getElementById("root")!).render(<App/>);
