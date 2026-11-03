import {useState} from "react";
import {createRoot} from "react-dom/client";
import {buildCatalogue} from "../../src/capabilities/catalogue";
import type {CapabilityManifestV2} from "../../src/capabilities/types";
import {providers,enhancers} from "../../src/pipelines/registry";
import videoEdit from "../../native-workflows/wan21-vace-masked-edit/manifest.json";
import {TeamComposer} from "../../src/team/TeamComposer";
import type {Asset,Call} from "../../src/team/api";
import "../../src/ds/tokens.css";
import "../../src/ds/components.css";
import "../../src/team/team.css";

const catalogue=[...buildCatalogue([...providers,...enhancers]).map(item=>item.manifest),videoEdit as CapabilityManifestV2];
const manifest=catalogue.find(item=>item.id==="wan22-ti2v-5b-t2v")!;
const asset=(id:string,type:"image"|"video"):Asset=>({id,project_id:"p",name:`${id}.${type==="image"?"png":"mp4"}`,media_type:type,content_type:type==="image"?"image/png":"video/mp4",bytes:"1",created_at:"2026-01-01",parent_id:null});
let failMore=new URLSearchParams(location.search).has("fail-more");
const call:Call=async (url,method,body)=>{
  if(method==="POST"&&url.includes("assets?")){const file=(body as FormData).get("file") as File;return asset(`upload-${file.name}`,file.type.startsWith("video/")?"video":"image") as never;}
  if(url.includes("assets?")&&url.includes("cursor=")){if(failMore){failMore=false;throw new Error("fixture page failure");}return {items:[asset("older-image","image"),asset("older-video","video")],nextCursor:null} as never;}
  if(url.includes("assets?"))return {items:[asset("library-image","image"),asset("library-video","video")],nextCursor:"fixture-next"} as never;
  return [] as never;
};
function Fixture(){const [selected,setSelected]=useState("");return <><output aria-label="Selected model">{selected}</output><TeamComposer manifest={manifest} catalogue={catalogue} onCapability={setSelected} user={{id:"u",email:"u@example.test"}} workspace={{id:"w",name:"Studio",role:"admin"}} project={{id:"p",name:"Film"}} workers={[]} call={call} canQueue authorized onQueued={()=>{}}/></>;}
createRoot(document.getElementById("root")!).render(<Fixture/>);
