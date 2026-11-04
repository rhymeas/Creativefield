import {useEffect,useRef,useState,type PointerEvent as ReactPointerEvent} from "react";
import {Button,CropHandles,Dialog,Meta,Notice,Stage} from "../../ds";
import {dragCrop,fullCrop,type CropHandle,type CropRect} from "../../image/editor/crop";
import {assetUrl,workspacePath,type Asset,type Call,type Project,type Workspace} from "../api";
import "./video-crop.css";

/** Cropping makes a new project asset; the original stays in the library. */
export function VideoCropDialog({workspace,project,asset,width,height,call,onClose,onCropped}:{workspace:Workspace;project:Project;asset:Asset;width:number;height:number;call:Call;onClose:()=>void;onCropped:(asset:Asset)=>void}){
  const bounds={w:width,h:height},[box,setBox]=useState<CropRect>(()=>fullCrop(bounds));
  const [view,setView]=useState({w:0,h:0}),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const video=useRef<HTMLVideoElement>(null),drag=useRef<{handle:CropHandle;box:CropRect;x:number;y:number}|null>(null);
  useEffect(()=>{const el=video.current;if(!el)return;const measure=()=>{const r=el.getBoundingClientRect();setView({w:r.width,h:r.height});};measure();const observer=new ResizeObserver(measure);observer.observe(el);return()=>observer.disconnect();},[]);
  const even=(value:number)=>Math.floor(value/2)*2;
  const x=even(box.x),y=even(box.y),right=Math.min(even(width),even(box.x+box.w)),bottom=Math.min(even(height),even(box.y+box.h));
  async function apply(){
    if(busy||right-x<2||bottom-y<2)return;
    setBusy(true);setError("");
    try{const result=await call<Asset>(workspacePath(workspace.id,"video-sources/prepare"),"POST",{projectId:project.id,assetId:asset.id,crop:{x,y,width:right-x,height:bottom-y}});onCropped(result);onClose();}
    catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  }
  const move=(event:ReactPointerEvent<HTMLElement>)=>{const d=drag.current;if(!d||!view.w||!view.h)return;setBox(dragCrop(d.box,d.handle,{x:0,y:0},{x:(event.clientX-d.x)*width/view.w,y:(event.clientY-d.y)*height/view.h},bounds));};
  return <Dialog wide open title="Crop video" onClose={()=>{if(!busy)onClose();}} footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy||right-x<2||bottom-y<2} onClick={()=>void apply()}>{busy?"Cropping…":"Use crop"}</Button></>}>
    <Stage><div className="cf-video-crop"><video ref={video} src={assetUrl(workspace.id,asset.id)} muted playsInline controls aria-label="Video crop preview"/>{view.w>0&&<CropHandles box={box} viewport={{x:0,y:0,w:view.w,h:view.h}} width={width} height={height}
      onStart={(handle,event)=>{drag.current={handle:handle as CropHandle,box,x:event.clientX,y:event.clientY};event.currentTarget.setPointerCapture(event.pointerId);}}
      onMove={move} onEnd={()=>{drag.current=null;}} onCancel={()=>{drag.current=null;}}
      onNudge={(handle,dx,dy)=>setBox(old=>dragCrop(old,handle as CropHandle,{x:0,y:0},{x:dx,y:dy},bounds))}/>}</div></Stage>
    <Meta>{`${right-x} × ${bottom-y} px · The original video stays in your library.`}</Meta>
    {error&&<Notice inline title="The video was not cropped" details={error}>Check the crop and try again.</Notice>}
  </Dialog>;
}
