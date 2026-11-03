import {useState} from "react";
import {createRoot} from "react-dom/client";
import raw from "../../native-workflows/h3-t2v/manifest.json";
import imageRaw from "../../native-workflows/h3-i2v/manifest.json";
import type {CapabilityManifestV2} from "../../src/capabilities/types";
import {TeamComposer} from "../../src/team/TeamComposer";
import type {Call} from "../../src/team/api";
import "../../src/ds/tokens.css";import "../../src/ds/components.css";import "../../src/team/team.css";
const original=raw as unknown as CapabilityManifestV2;
const imageOriginal=imageRaw as unknown as CapabilityManifestV2;
const catalogue=[original,imageOriginal].map(item=>({...item,routes:item.routes.map(route=>({...route,requirements:[]}))}));
const call:Call=async (url,method,body)=>{if(method==="POST"&&url.endsWith("/runs")){document.getElementById("submitted")!.textContent=JSON.stringify(body);return {id:"simulated-run"} as never;}return url.includes("assets?")?{items:[],nextCursor:null} as never:[] as never;};
const worker={id:"worker",name:"Fixture",origin:"http://localhost:8188",enabled:true,checked_at:new Date().toISOString(),inventory:{online:true,nodes:[],models:[],credentials:[]}};
function Fixture(){const [id,setId]=useState(original.id);const manifest=catalogue.find(item=>item.id===id)!;return <TeamComposer key={id} manifest={manifest} catalogue={catalogue} onCapability={setId} user={{id:"u",email:"u@example.test"}} workspace={{id:"w",name:"Studio",role:"admin"}} project={{id:"p",name:"Test"}} workers={[worker]} call={call} canQueue authorized onQueued={()=>{}}/>;}
createRoot(document.getElementById("root")!).render(<Fixture/>);
