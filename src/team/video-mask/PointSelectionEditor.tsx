import {useCallback,useEffect,useRef,useState} from "react";
import {Button,InfoButton,Notice,SegmentedTabs,Toolbar} from "../../ds";
import {assetUrl,type Asset} from "../api";
import {MAX_VIDEO_TRACKING_POINTS,pointAtFrame,type VideoTrackingPoint} from "./point-selection";
import "./tracked-mask-review.css";

/** Pixels and points always refer to the paused first decoded source frame. */
export function PointSelectionEditor({workspace,source,value,onChange,disabled}:{workspace:string;source:Asset;value:VideoTrackingPoint[];onChange:(points:VideoTrackingPoint[])=>void;disabled:boolean}){
  const video=useRef<HTMLVideoElement>(null),canvas=useRef<HTMLCanvasElement>(null),cursor=useRef({x:0,y:0}),[ready,setReady]=useState(false),[kind,setKind]=useState<VideoTrackingPoint["kind"]>("include"),[error,setError]=useState("");
  const paint=useCallback(()=>{
    const input=video.current,out=canvas.current;if(!input||!out||input.readyState<2||!input.videoWidth||Math.abs(input.currentTime)>.002)return;
    const fresh=out.width!==input.videoWidth||out.height!==input.videoHeight;out.width=input.videoWidth;out.height=input.videoHeight;if(fresh)cursor.current={x:Math.floor(out.width/2),y:Math.floor(out.height/2)};
    const ctx=out.getContext("2d")!;ctx.drawImage(input,0,0);const style=getComputedStyle(out),size=Math.max(4,out.height/80);
    for(const point of value){ctx.beginPath();ctx.arc(point.x,point.y,size,0,Math.PI*2);ctx.fillStyle=style.getPropertyValue(point.kind==="include"?"--accent":"--status-danger").trim();ctx.fill();ctx.strokeStyle=style.getPropertyValue("--text-primary").trim();ctx.lineWidth=1;ctx.stroke();ctx.beginPath();ctx.moveTo(point.x-size/2,point.y);ctx.lineTo(point.x+size/2,point.y);if(point.kind==="include"){ctx.moveTo(point.x,point.y-size/2);ctx.lineTo(point.x,point.y+size/2);}ctx.stroke();}
    if(document.activeElement===out){const p=cursor.current;ctx.strokeStyle=style.getPropertyValue("--text-primary").trim();ctx.strokeRect(p.x-size,p.y-size,size*2,size*2);}
    setReady(true);
  },[value]);
  useEffect(()=>{paint();},[paint]);
  function add(point:VideoTrackingPoint|null){if(disabled||!ready||!point)return;if(value.length>=MAX_VIDEO_TRACKING_POINTS){setError("Remove a point before adding another.");return;}setError("");onChange([...value,point]);}
  return <div className="cf-form">
    <video hidden ref={video} muted playsInline preload="auto" src={assetUrl(workspace,source.id)} onLoadedMetadata={()=>{setReady(false);cursor.current={x:0,y:0};if(video.current)video.current.currentTime=0;}} onLoadedData={paint} onSeeked={paint} onError={()=>setError("The first source frame could not be decoded.")}/>
    <div className="cf-tracked-review__stage"><canvas ref={canvas} width={1} height={1} tabIndex={disabled?-1:0} role="button" aria-disabled={disabled||!ready} aria-label={`First frame point selection, ${value.length} points. Arrow keys move; Enter adds; Shift Enter excludes.`}
      onFocus={paint} onBlur={paint} onPointerDown={event=>{if(disabled)return;event.currentTarget.focus();add(pointAtFrame(event.clientX,event.clientY,event.currentTarget.getBoundingClientRect(),event.currentTarget.width,event.currentTarget.height,kind));}}
      onKeyDown={event=>{if(disabled||!ready)return;const out=event.currentTarget,p=cursor.current,step=event.altKey?1:Math.max(1,Math.round(out.width/100));if(event.key.startsWith("Arrow")){event.preventDefault();if(event.key==="ArrowLeft")p.x=Math.max(0,p.x-step);if(event.key==="ArrowRight")p.x=Math.min(out.width-1,p.x+step);if(event.key==="ArrowUp")p.y=Math.max(0,p.y-step);if(event.key==="ArrowDown")p.y=Math.min(out.height-1,p.y+step);paint();}if(event.key==="Enter"||event.key===" "){event.preventDefault();add({...p,kind:event.shiftKey?"exclude":kind});}}}/></div>
    <Toolbar><SegmentedTabs quiet label="Point kind" value={kind} onChange={value=>setKind(value as VideoTrackingPoint["kind"])} items={[{id:"include",label:"Include",disabled},{id:"exclude",label:"Exclude",disabled}]}/><Button variant="ghost" disabled={disabled} aria-disabled={!value.length} onClick={()=>onChange(value.slice(0,-1))}>Undo point</Button><Button variant="ghost" disabled={disabled} aria-disabled={!value.length} onClick={()=>onChange([])}>Clear points</Button><InfoButton title="Point selection">Click the object to include it, then exclude unwanted areas. Points use the first frame and one tracked object. Arrow keys move a cursor; Enter adds a point, Shift+Enter excludes, Alt+arrows move one pixel. Tracking starts only when you choose Track this object.</InfoButton></Toolbar>
    {error&&<Notice inline title="This point wasn't added">{error}</Notice>}
  </div>;
}
