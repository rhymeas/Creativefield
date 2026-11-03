import {useState} from "react";
import {createRoot} from "react-dom/client";
import {ASSET_TYPE_DRAG,HistoryItem,MediaCard,ResultTile,UploadSlot} from "../../src/ds";
import {TeamMediaInput} from "../../src/team/TeamMediaInput";
import {ExampleTiles} from "../../src/team/ExampleTiles";
import {AssetQuickPick} from "../../src/team/AssetQuickPick";
import {TeamChoice} from "../../src/team/TeamChoice";
import type {Asset} from "../../src/team/api";

const image:Asset={id:"fixture-image",project_id:"fixture",name:"Fixture image",media_type:"image",content_type:"image/png",bytes:"1",created_at:"2026-01-01",parent_id:null};
const video:Asset={...image,id:"fixture-video",name:"Fixture video",media_type:"video",content_type:"video/mp4"};
let releaseExample: (()=>void)|undefined;
const realFetch=window.fetch.bind(window);
if(new URLSearchParams(location.search).has("delay-example")) window.fetch=(input,init)=>{
  if(typeof input==="string"&&input.startsWith("/reels/")) return new Promise<Response>(resolve=>{releaseExample=()=>resolve(new Response(new Blob(["fixture"],{type:"video/mp4"}),{status:200}));});
  return realFetch(input,init);
};
function Fixture(){
  const params=new URLSearchParams(location.search),realWorkspace=params.get('workspace'),realProject=params.get('project');
  const [selected,setSelected]=useState("");
  const [example,setExample]=useState("");
  const [uploaded,setUploaded]=useState("");
  async function uploadExample(file:File|null){
    setExample(file?.name??'');
    if(!file||!realWorkspace||!realProject)return;
    try{const form=new FormData();form.append('file',file);const r=await fetch(`/api/v1/workspaces/${encodeURIComponent(realWorkspace)}/assets?projectId=${encodeURIComponent(realProject)}`,{method:'POST',body:form});if(!r.ok)throw new Error(`HTTP ${r.status}`);const asset=await r.json();setUploaded(asset.id);}catch(error){setUploaded(`error: ${(error as Error).message}`);}
  }
  const [quickSelection,setQuickSelection]=useState("");
  const [directSelection,setDirectSelection]=useState("");
  const [moreAudio,setMoreAudio]=useState(false);
  return <main><button onClick={()=>releaseExample?.()}>Release delayed example</button><div aria-label="Image result"><ResultTile dragAsset={{id:image.id,url:"/fixture-image.png",contentType:image.content_type}}><img draggable={false} src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" alt="Fixture image"/></ResultTile></div>
    <div aria-label="Video result"><ResultTile dragAsset={{id:video.id,url:"/fixture-video.mp4",contentType:video.content_type}}><span>Fixture video</span></ResultTile></div>
    <div aria-label="Image input"><TeamMediaInput label="Reference" type="image" file={null} selected={selected===image.id?image:undefined} options={[image,...(params.has('foreign')?[{...image,id:'foreign-image',project_id:'other'}]:[])]} disabled={false} canUpload workspace="fixture" projectId="fixture" onFile={()=>{}} onSelect={setSelected} onUpload={()=>{}}/></div>
    <div aria-label="Video input"><TeamMediaInput label="Source video" type="video" accept={params.has('strict-video')?'video/mp4':undefined} file={null} selected={undefined} options={params.has('omit-video')?[]:[video]} disabled={false} canUpload workspace={realWorkspace??"fixture"} onFile={file=>void uploadExample(file)} onSelect={setQuickSelection} onUpload={()=>{}}/></div>
    <div aria-label="Read-only video input"><TeamMediaInput label="Source video" type="video" file={null} selected={undefined} options={[video]} disabled={false} canUpload={false} workspace="fixture" onFile={file=>setExample(file?.name??"")} onSelect={setQuickSelection} onUpload={()=>{}}/></div>
    <div aria-label="Mixed input"><TeamMediaInput label="Video or portrait" type="image" accept="image/png,video/mp4" file={null} selected={undefined} options={[]} disabled={false} canUpload workspace="fixture" onFile={file=>setExample(file?.name??"")} onSelect={setQuickSelection} onUpload={()=>{}}/></div>
    <div aria-label="Audio choices"><TeamChoice label="Audio library" display="Choose audio" value="" options={[{value:"first",label:"First audio"},...(moreAudio?[{value:"older",label:"Older audio"}]:[])]} onChange={setQuickSelection} onLoadMore={moreAudio?undefined:()=>setMoreAudio(true)}/></div>
    <div aria-label="Examples"><ExampleTiles kind="video" count={1}/></div>
    <div aria-label="Quick media"><AssetQuickPick workspace="fixture" assets={[video]} label="Quick media" onSelect={()=>{}}/></div>
    <div aria-label="Library image"><MediaCard dragAsset={{id:image.id,url:"/fixture-image.png",contentType:image.content_type}} media={<img draggable={false} src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" alt="Library fixture"/>}/></div>
    <div aria-label="Run result" onDragStart={event=>event.dataTransfer.setData(ASSET_TYPE_DRAG,"video/webm")}><HistoryItem media={<video draggable={false} src="/api/v1/workspaces/fixture/assets/fixture-video/content"/>} model="Fixture" prompt="" meta="Complete" date=""/></div>
    <div aria-label="Strict image input"><UploadSlot label="Strict image" hint="Drop an image" accept="image/png,image/jpeg" onFile={()=>{}} onAsset={setQuickSelection}/></div>
    <div aria-label="Strict video input"><UploadSlot label="Strict video" hint="MP4 only" accept="video/mp4" onFile={file=>setDirectSelection(file?.name??'')} onAsset={setQuickSelection}/></div>
    <output aria-label="Direct selection">{directSelection||"none"}</output>
    <output aria-label="Selected asset">{selected||"none"}</output><output aria-label="Selected example">{example||"none"}</output><output aria-label="Uploaded asset">{uploaded||"none"}</output><output aria-label="Quick selection">{quickSelection||"none"}</output></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
