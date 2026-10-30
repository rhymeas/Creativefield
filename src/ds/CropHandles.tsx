import type {PointerEventHandler} from "react";

/** Screen-sized crop targets sit clear of the image and never become clipped by its bitmap. */
export function CropHandles({box,viewport,width,height,onStart,onMove,onEnd,onCancel,onNudge}:{
  box:{x:number;y:number;w:number;h:number};viewport:{x:number;y:number;w:number;h:number};width:number;height:number;
  onStart:(handle:string,event:React.PointerEvent<HTMLElement>)=>void;
  onMove:PointerEventHandler<HTMLElement>;onEnd:PointerEventHandler<HTMLElement>;onCancel:()=>void;
  onNudge:(handle:string,dx:number,dy:number)=>void;
}){
  return <div className="ds-crophandles" role="group" aria-label="Crop handles">
    {(["nw","n","ne","e","se","s","sw","w"] as const).map(handle=>{
      const hx=handle.includes("w")?0:handle.includes("e")?1:.5,hy=handle.includes("n")?0:handle.includes("s")?1:.5;
      return <button type="button" key={handle} aria-label={`Crop ${handle}`} className="ds-crophandle" data-handle={handle}
        style={{left:viewport.x+(box.x+box.w*hx)/width*viewport.w,top:viewport.y+(box.y+box.h*hy)/height*viewport.h,"--crop-offset-x":`${(hx-.5)*2}rem`,"--crop-offset-y":`${(hy-.5)*2}rem`} as React.CSSProperties}
        onPointerDown={event=>{event.stopPropagation();onStart(handle,event);}} onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onCancel} onLostPointerCapture={onCancel}
        onKeyDown={event=>{const delta=event.shiftKey?10:1;if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key))return;event.preventDefault();onNudge(handle,event.key==="ArrowLeft"?-delta:event.key==="ArrowRight"?delta:0,event.key==="ArrowUp"?-delta:event.key==="ArrowDown"?delta:0);}}/>;
    })}
  </div>;
}
