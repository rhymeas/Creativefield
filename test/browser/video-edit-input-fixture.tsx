import {createRoot} from "react-dom/client";
import {VideoEditStudio} from "../../src/team/video-edit/VideoEditStudio";
import type {Asset,Call} from "../../src/team/api";
import "../../src/ds/tokens.css";
import "../../src/ds/components.css";
import "../../src/team/team.css";

const asset=(id:string,project="p"):Asset=>({id,project_id:project,name:`${id}.mp4`,media_type:"video",content_type:"video/mp4",bytes:"1",created_at:"2026-01-01",parent_id:null});
const call:Call=async(url,method,body)=>{
  if(url.includes("assets?")&&url.includes("cursor="))return {items:[asset("older-video")],nextCursor:null} as never;
  if(url.includes("assets?"))return {items:[asset("first-video")],nextCursor:"next-page"} as never;
  if(url.endsWith("/assets/older-video"))return asset("older-video") as never;
  if(url.endsWith("/assets/dropped-video"))return asset("dropped-video") as never;
  if(url.includes("/assets/"))return asset("first-video") as never;
  if(url.endsWith("video-extension-plans")&&method==="POST"){const request=body as {sourceAssetId:string};return {source:{sourceAssetId:request.sourceAssetId,projectId:"p",sha256:"a".repeat(64),bytes:1,width:512,height:512,frameRate:{numerator:16,denominator:1},frameCount:32,hasAudio:false,container:"mp4",videoCodec:"h264"},operation:"trim"} as never;}
  return [] as never;
};
createRoot(document.getElementById("root")!).render(<VideoEditStudio workspace={{id:"w",name:"Studio",role:"creator"}} project={{id:"p",name:"Film"}} call={call} requirements={{contractVersion:1,trim:{state:"ready",missing:[],instructions:"",versions:{ffmpeg:"fixture"}},forwardExtension:{workflow:{state:"unsupported",reasons:["Unavailable"],missing:[]},tools:{}},audioPolicies:["mute","preserve"]}} onChanged={()=>{}}/>);
