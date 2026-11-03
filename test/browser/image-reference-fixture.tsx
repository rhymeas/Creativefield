import {useState} from "react";import {createRoot} from "react-dom/client";
import raw from "../../native-workflows/fibo2-edit/manifest.json";
import type {CapabilityManifestV2} from "../../src/capabilities/types";
import {ImageStudio} from "../../src/image/ImageStudio";import {defaultImageDraft,imageRunBody,type ImageDraft} from "../../src/image/image-state";
import type {Asset} from "../../src/team/api";
import "../../src/ds/tokens.css";import "../../src/ds/components.css";import "../../src/ds/advanced-settings.css";import "../../src/team/team.css";
const manifest=raw as unknown as CapabilityManifestV2;
const asset=(id:string):Asset=>({id,project_id:"p",name:`${id}.png`,media_type:"image",content_type:"image/png",bytes:"1",created_at:"2026-01-01",parent_id:null});
function App(){const [draft,setDraft]=useState<ImageDraft>(()=>({...defaultImageDraft(manifest),inputs:{source_image:"scene",reference_image:"reference"}})),[sent,setSent]=useState("");return <><output>{sent||"No submission"}</output><ImageStudio workspace={{id:"w",name:"Studio",role:"creator"}} project={{id:"p",name:"Test"}} manifest={manifest} readiness={{state:"ready",reasons:[],missing:[]}} assets={[asset("scene"),asset("reference")]} runs={[]} draft={draft} onDraftChange={setDraft} onGenerate={value=>setSent(JSON.stringify(imageRunBody({projectId:"p",workerId:"worker",idempotencyKey:"test-key",routeId:"local"},manifest,value)))}/></>;}
createRoot(document.getElementById("root")!).render(<App/>);
