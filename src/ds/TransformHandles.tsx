import {useEffect,useRef,type CSSProperties,type PointerEventHandler} from "react";
import {RotateCw} from "lucide-react";
type Handle="move"|"rotate"|"nw"|"ne"|"se"|"sw";
/** Screen-sized targets follow the existing proportional layer geometry. */
export function TransformHandles({box,viewport,width,height,onStart,onMove,onEnd,onCancel,onNudge,onApply,onDiscard,autoFocus=true}:{
  box:{x:number;y:number;w:number;h:number;rotation:number};viewport:{x:number;y:number;w:number;h:number};width:number;height:number;
  onStart:(handle:Handle,event:React.PointerEvent<HTMLButtonElement>)=>void;onMove:PointerEventHandler<HTMLButtonElement>;onEnd:PointerEventHandler<HTMLButtonElement>;
  onCancel:()=>void;onNudge:(handle:Handle,dx:number,dy:number)=>void;onApply:()=>void;onDiscard:()=>void;autoFocus?:boolean;
}){
  const root=useRef<HTMLDivElement>(null);useEffect(()=>{if(autoFocus)root.current?.querySelector<HTMLButtonElement>("button")?.focus({preventScroll:true});},[autoFocus]);
  const button=(handle:Handle,label:string)=>({"aria-label":label,onPointerDown:(event:React.PointerEvent<HTMLButtonElement>)=>{event.preventDefault();event.stopPropagation();event.currentTarget.focus({preventScroll:true});onStart(handle,event);},onPointerMove:onMove,onPointerUp:onEnd,onPointerCancel:onCancel,onLostPointerCapture:onCancel,
    onKeyDown:(event:React.KeyboardEvent<HTMLButtonElement>)=>{
      if(event.key==="Escape"||((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="z")){event.preventDefault();event.stopPropagation();onDiscard();return;}
      if(event.key==="Enter"){event.preventDefault();event.stopPropagation();onApply();return;}
      if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key))return;
      event.preventDefault();event.stopPropagation();const d=event.shiftKey?10:1;onNudge(handle,event.key==="ArrowLeft"?-d:event.key==="ArrowRight"?d:0,event.key==="ArrowUp"?-d:event.key==="ArrowDown"?d:0);
    }});
  return <div className="ds-transformhandles" role="group" aria-label="Free transform handles" ref={root}>
    <div className="ds-transformbox" style={{left:viewport.x+box.x/width*viewport.w,top:viewport.y+box.y/height*viewport.h,width:box.w/width*viewport.w,height:box.h/height*viewport.h,transform:`translate(-50%, -50%) rotate(${box.rotation}deg)`} as CSSProperties}>
      <button type="button" className="ds-transformmove" {...button("move","Move transformed layer")}/>
      {(["nw","ne","se","sw"] as const).map(handle=><button key={handle} type="button" className="ds-transformhandle" data-handle={handle} {...button(handle,`Scale ${handle}`)}/>)}
      <button type="button" className="ds-transformrotate" {...button("rotate","Rotate transformed layer")}><RotateCw size={14}/></button>
    </div>
  </div>;
}
