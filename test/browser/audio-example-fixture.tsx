import {createRoot} from "react-dom/client";
import {AudioStudio} from "../../src/team/audio/AudioStudio";
import type {Asset,Call} from "../../src/team/api";

const uploads:Asset[]=[];
const call:Call=async (url,method,body)=>{
  if(url.endsWith("/assets/older-video"))return {id:"older-video",project_id:"fixture-project",name:"Older video",media_type:"video",content_type:"video/mp4",bytes:"1",created_at:"2025-01-01",parent_id:null} as never;
  if(url.endsWith("/assets/older-voice"))return {id:"older-voice",project_id:"fixture-project",name:"Older voice",media_type:"audio",content_type:"audio/wav",bytes:"1",created_at:"2025-01-01",parent_id:null} as never;
  if(url.endsWith("/assets/other-video"))return {id:"other-video",project_id:"other-project",name:"Other video",media_type:"video",content_type:"video/mp4",bytes:"1",created_at:"2025-01-01",parent_id:null} as never;
  if(method==="POST"&&url.includes("assets?")){
    const file=(body as FormData).get("file") as File;
    const asset:Asset={id:"uploaded-example",project_id:"fixture-project",name:file.name,media_type:"video",content_type:file.type,bytes:String(file.size),created_at:"2026-01-01",parent_id:null};
    uploads.push(asset);
    return asset as never;
  }
  if(url.includes("assets?")&&url.includes("cursor="))return {items:[{id:"older-voice",project_id:"fixture-project",name:"Older voice",media_type:"audio",content_type:"audio/wav",bytes:"1",created_at:"2025-01-01",parent_id:null},{id:"older-video",project_id:"fixture-project",name:"Older video",media_type:"video",content_type:"video/mp4",bytes:"1",created_at:"2025-01-01",parent_id:null}],nextCursor:null} as never;
  if(url.includes("assets?"))return {items:[...uploads,{id:"first-voice",project_id:"fixture-project",name:"First voice",media_type:"audio",content_type:"audio/wav",bytes:"1",created_at:"2026-01-01",parent_id:null}],nextCursor:"next-page"} as never;
  return [] as never;
};
createRoot(document.getElementById("root")!).render(<AudioStudio userId="fixture-user" workspace={{id:"fixture",name:"Fixture",role:"creator"}} project={{id:"fixture-project",name:"Fixture"}} call={call} requirements={{state:"ready",missing:[],versions:{ffmpeg:"fixture",ffprobe:"fixture"},instructions:""}} onChanged={()=>{}}/>);
