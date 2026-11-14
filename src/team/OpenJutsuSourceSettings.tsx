import {useEffect,useState} from "react";
import {Clock,RectangleHorizontal} from "lucide-react";
import {Dialog,Notice,ParamButton,ShimmerText} from "../ds";
import {assetUrl,workspacePath,type Asset,type Call,type Project,type Workspace} from "./api";
import {TrimToFit} from "./TrimToFit";
import {VideoCropDialog,VIDEO_CROP_FORMATS} from "./video-edit/VideoCropDialog";
import {planRequest,type VideoEditPlan} from "./video-edit/state";
import {nearestFormat} from "./picture-format";
import {runShape} from "./run-shape";

type ClipDetails={seconds:number;width:number;height:number};
type CropSource={asset:Asset;width:number;height:number};

function clipRatio(width:number,height:number){
  let divisor=width,remainder=height;
  while(remainder)[divisor,remainder]=[remainder,divisor%remainder];
  return `${width/divisor}:${height/divisor}`;
}

export function OpenJutsuSourceSettings({asset,workspace,project,call,disabled,onChanged}:{asset:Asset;workspace:Workspace;project:Project;call:Call;disabled:boolean;onChanged:(id:string,asset?:Asset)=>void}){
  const [details,setDetails]=useState<ClipDetails>();
  const [open,setOpen]=useState<"duration"|"format"|null>(null);
  const [cropSource,setCropSource]=useState<CropSource>();
  const [error,setError]=useState("");
  const close=()=>setOpen(null);
  const openFormat=()=>{setCropSource(undefined);setError("");setOpen("format");};

  useEffect(()=>{
    const video=document.createElement("video");
    video.preload="metadata";
    video.onloadedmetadata=()=>setDetails({seconds:video.duration,width:video.videoWidth,height:video.videoHeight});
    video.src=assetUrl(workspace.id,asset.id);
    return()=>{video.onloadedmetadata=null;video.removeAttribute("src");video.load();};
  },[workspace.id,asset.id]);

  useEffect(()=>{
    if(open!=="format")return;
    const controller=new AbortController(),{signal}=controller;
    void (async()=>{
      const ready=await call<Asset>(workspacePath(workspace.id,"video-sources/prepare"),"POST",{projectId:project.id,assetId:asset.id},{signal:AbortSignal.any([signal,AbortSignal.timeout(310000)])});
      const plan=await call<VideoEditPlan>(workspacePath(workspace.id,"video-extension-plans"),"POST",planRequest(project.id,ready.id,0,1),{signal});
      if(!signal.aborted)setCropSource({asset:ready,width:plan.source.width,height:plan.source.height});
    })().catch(cause=>{if(!signal.aborted)setError((cause as Error).message);});
    return()=>controller.abort();
  },[open,call,workspace.id,project.id,asset.id]);

  const shape=details&&details.width/details.height;
  const nearest=shape?nearestFormat(shape,VIDEO_CROP_FORMATS):undefined;
  const nearestShape=runShape({aspect_ratio:nearest});
  const match=shape&&nearestShape&&Math.abs(shape/nearestShape-1)<0.005;
  const aspect=match&&nearest?nearest:details?.width&&details.height?clipRatio(details.width,details.height):"Source";
  const seconds=details&&Number.isFinite(details.seconds)?details.seconds:undefined;
  const duration=seconds===undefined?"Full clip":`${seconds.toFixed(2)} s`;
  const durationLabel=seconds===undefined?"Full":`${Number(seconds.toFixed(1))}s`;
  return <>
    <ParamButton title="Aspect ratio" icon={<RectangleHorizontal size={16}/>} label={aspect.length<=5?aspect:"Source"} value="source" disabled={disabled}
      options={[{value:"source",label:`Current · ${aspect}`},{value:"crop",label:"Crop source…"}]} onChange={choice=>{if(choice==="crop")openFormat();}}/>
    <ParamButton title="Duration" icon={<Clock size={16}/>} label={durationLabel} value="source" disabled={disabled}
      options={[{value:"source",label:`Current · ${duration}`},{value:"trim",label:"Trim source…"}]} onChange={choice=>{if(choice==="trim")setOpen("duration");}}/>
    {open==="duration"&&<TrimToFit workspace={workspace} project={project} call={call} assetId={asset.id} open onClose={close} onTrimmed={onChanged}/>}
    {open==="format"&&(cropSource?<VideoCropDialog workspace={workspace} project={project} call={call} {...cropSource} showFormats onClose={close} onCropped={video=>onChanged(video.id,video)}/>:<Dialog open title="Change aspect ratio" onClose={close}>{error?<Notice inline title="The clip could not be prepared" details={error}>Close the dialog and try again.</Notice>:<ShimmerText>Preparing the source clip…</ShimmerText>}</Dialog>)}
  </>;
}
