import {useEffect,useRef,useState,type PointerEvent as ReactPointerEvent} from "react";
import {Button,CropHandles,Dialog,Meta,Notice,Row,Stage} from "../../ds";
import {dragCrop,fullCrop,type CropHandle,type CropRect} from "../../image/editor/crop";
import {assetUrl,workspacePath,type Asset,type Call,type Project,type Workspace} from "../api";
import "./video-crop.css";

export const VIDEO_CROP_FORMATS=["16:9","9:16","1:1","4:3","3:4"];

/** Cropping makes a new project asset; the original stays in the library. */
export function VideoCropDialog({workspace,project,asset,width,height,call,onClose,onCropped,showFormats=false}:{workspace:Workspace;project:Project;asset:Asset;width:number;height:number;call:Call;onClose:()=>void;onCropped:(asset:Asset)=>void;showFormats?:boolean}){
  const bounds={w:width,h:height},[box,setBox]=useState<CropRect>(()=>fullCrop(bounds));
  const [view,setView]=useState({w:0,h:0}),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [format,setFormat]=useState("source");
  const video=useRef<HTMLVideoElement>(null),drag=useRef<{handle:CropHandle;box:CropRect;x:number;y:number}|null>(null);
  useEffect(()=>{const el=video.current;if(!el)return;const measure=()=>{const r=el.getBoundingClientRect();setView({w:r.width,h:r.height});};measure();const observer=new ResizeObserver(measure);observer.observe(el);return()=>observer.disconnect();},[]);
  const even=(value:number)=>Math.floor(value/2)*2;
  const x=even(box.x),y=even(box.y),right=Math.min(even(width),even(box.x+box.w)),bottom=Math.min(even(height),even(box.y+box.h));
  const canCrop=right-x>=2&&bottom-y>=2&&(!showFormats||x>0||y>0||right<even(width)||bottom<even(height));
  function chooseFormat(value:string){
    setFormat(value);
    if(value==="source"){setBox(fullCrop(bounds));return;}
    if(value==="custom")return;
    const [horizontal,vertical]=value.split(":").map(Number);
    const scale=even(Math.min(width/horizontal,height/vertical));
    const w=horizontal*scale,h=vertical*scale;
    setBox({x:even((width-w)/2),y:even((height-h)/2),w,h});
  }
  async function apply(){
    if(busy||!canCrop)return;
    setBusy(true);setError("");
    try{const result=await call<Asset>(workspacePath(workspace.id,"video-sources/prepare"),"POST",{projectId:project.id,assetId:asset.id,crop:{x,y,width:right-x,height:bottom-y}},{timeoutMs:310000});onCropped(result);onClose();}
    catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  }
  const move=(event:ReactPointerEvent<HTMLElement>)=>{const d=drag.current;if(!d||!view.w||!view.h||busy)return;setFormat("custom");setBox(dragCrop(d.box,d.handle,{x:0,y:0},{x:(event.clientX-d.x)*width/view.w,y:(event.clientY-d.y)*height/view.h},bounds));};
  return <Dialog wide open title={showFormats?"Change aspect ratio":"Crop video"} onClose={()=>{if(!busy)onClose();}} footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy||!canCrop} onClick={()=>void apply()}>{busy?"Cropping…":"Use crop"}</Button></>}>
    {showFormats&&<Row label="Crop to" value={format} display={format==="source"?"Source":format==="custom"?"Custom":format} disabled={busy} options={[{value:"source",label:"Source"},...VIDEO_CROP_FORMATS.map(ratio=>({value:ratio,label:ratio})),{value:"custom",label:"Custom"}]} onChange={chooseFormat}/>}
    <Stage><div className="cf-video-crop"><video ref={video} src={assetUrl(workspace.id,asset.id)} muted playsInline controls aria-label="Video crop preview"/>{view.w>0&&<CropHandles box={box} viewport={{x:0,y:0,w:view.w,h:view.h}} width={width} height={height}
      onStart={(handle,event)=>{drag.current={handle:handle as CropHandle,box,x:event.clientX,y:event.clientY};event.currentTarget.setPointerCapture(event.pointerId);}}
      onMove={move} onEnd={()=>{drag.current=null;}} onCancel={()=>{drag.current=null;}}
      onNudge={(handle,dx,dy)=>{if(!busy){setFormat("custom");setBox(old=>dragCrop(old,handle as CropHandle,{x:0,y:0},{x:dx,y:dy},bounds));}}}/>}</div></Stage>
    <Meta>{`${right-x} × ${bottom-y} px · ${showFormats?"Cropping removes the area outside the frame. ":""}The original video stays in your library.`}</Meta>
    {error&&<Notice inline title="The video was not cropped" details={error}>Check the crop and try again.</Notice>}
  </Dialog>;
}
