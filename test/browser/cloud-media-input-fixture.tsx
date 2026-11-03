import {createRoot} from "react-dom/client";
import {CloudRenderStudio} from "../../src/team/CloudRenderStudio";
import {ReferenceReplacePanel} from "../../src/team/ReferenceReplacePanel";
import {ChatgptImageStudio} from "../../src/team/ChatgptImageStudio";
import {SwapThingPanel} from "../../src/team/SwapThingPanel";
import type {Asset,Call} from "../../src/team/api";
import "../../src/ds/tokens.css";
import "../../src/ds/components.css";
import "../../src/team/team.css";

const asset=(id:string,type:"image"|"video"):Asset=>({id,project_id:"p",name:`${id}.${type==="image"?"png":"mp4"}`,media_type:type,content_type:type==="image"?"image/png":"video/mp4",bytes:"1",created_at:"2026-01-01",parent_id:null});
const call:Call=async (url,method,body)=>{
  if(url.includes('assets?')&&method==='POST'&&body instanceof FormData){
    const file=body.get('file') as File;
    document.body.dataset.upload=`${file.name}|${file.type}`;
    return {...asset('uploaded-video','video'),name:file.name,content_type:file.type} as never;
  }
  if(url.includes("router-models"))return {connected:true} as never;
  if(url.includes("chatgpt-image/account"))return {connected:false} as never;
  if(url.includes("assets?")&&url.includes("cursor="))return {items:[asset("older-video","video"),asset("older-image","image")],nextCursor:null} as never;
  if(url.includes("assets?"))return {items:[asset("first-image","image"),...(location.search.includes('foreign')?[{...asset('foreign-image','image'),project_id:'other'}]:[])],nextCursor:"next-page"} as never;
  if(url.includes("/assets/older-video"))return asset("older-video","video") as never;
  if(url.includes("/assets/older-image"))return asset("older-image","image") as never;
  return [] as never;
};
const common={workspace:{id:"w",name:"Studio",role:"admin" as const},project:{id:"p",name:"Film"},user:{id:"u",email:"u@example.test"},call,version:0,canEdit:true,onQueued:()=>{}};
const query=new URLSearchParams(location.search);
createRoot(document.getElementById("root")!).render(query.has("replace")?<ReferenceReplacePanel {...common} workerId="worker" onChanged={()=>{}}/>:query.has("swap")?<SwapThingPanel {...common} workerId="worker" onChanged={()=>{}}/>:query.has("image")?<ChatgptImageStudio {...common} feature="image-edit"/>:<CloudRenderStudio {...common} feature="openjutsu" onSettings={()=>{}} onLocal={()=>{}}/>);
