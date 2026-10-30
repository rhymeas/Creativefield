import {assetUrl,type Asset} from "./api";
import {useState} from "react";
import {Button,MediaViewer,Thumb,ThumbGrid} from "../ds";

/** A small strip of the latest project media under a field. Click to use one, or drag it onto another media field. */
export function AssetQuickPick({workspace,assets,selectedId,label,onSelect,onCrop,limit=8}:{workspace:string;assets:Asset[];selectedId?:string;label:string;onSelect:(id:string)=>void;onCrop?:(file:File)=>void;limit?:number}){
  const [viewing,setViewing]=useState<Asset|null>(null);
  const recent=[...assets].sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,limit);
  if(!recent.length)return null;
  return <><ThumbGrid compact label={label}>
    {recent.map(asset=><Thumb key={asset.id} src={assetUrl(workspace,asset.id)} video={asset.media_type==="video"} audio={asset.media_type==="audio"} label={`Preview ${asset.name}`} selected={asset.id===selectedId} onSelect={()=>onSelect(asset.id)} onPreview={asset.media_type==="audio"?undefined:()=>setViewing(asset)} dragData={{type:"application/x-comfyfield-asset",value:asset.id}}/>)}
  </ThumbGrid><MediaViewer open={!!viewing} src={viewing?assetUrl(workspace,viewing.id):""} name={viewing?.name??"Preview"} mediaType={viewing?.media_type==="video"?"video":"image"} onClose={()=>setViewing(null)} onCrop={onCrop?file=>{onCrop(file);setViewing(null);}:undefined} actions={<Button onClick={()=>{if(viewing)onSelect(viewing.id);setViewing(null);}}>Use this {viewing?.media_type==="video"?"video":"image"}</Button>}/></>;
}
