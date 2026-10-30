import {useEffect,useRef,useState,type ReactNode} from "react";
import {Meta,SliderField,Toolbar} from "./components";

/** A grayscale mask is tinted with the current DS accent, never baked into media. */
export function MaskOverlay({src,label="Effective edit mask",contour=true,onError}:{src:string;label?:string;contour?:boolean;onError?:()=>void}){
  const ref=useRef<HTMLCanvasElement>(null);
  const failure=useRef(onError);failure.current=onError;
  useEffect(()=>{
    let canceled=false;const image=new Image();
    image.onload=()=>{
      const canvas=ref.current;if(canceled||!canvas)return;
      if(image.naturalWidth*image.naturalHeight>4194304){failure.current?.();return;}
      canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      const ctx=canvas.getContext("2d",{willReadFrequently:true});if(!ctx)return;
      ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,canvas.width,canvas.height);
      const mask=new Uint8Array(canvas.width*canvas.height);
      for(let i=0;i<mask.length;i++)mask[i]=data.data[i*4];
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle=getComputedStyle(canvas).getPropertyValue("--accent").trim();ctx.fillRect(0,0,1,1);
      const accent=ctx.getImageData(0,0,1,1).data;
      for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
        const i=y*canvas.width+x,p=i*4,value=mask[i];
        const edge=contour&&value>127&&(x===0||y===0||x===canvas.width-1||y===canvas.height-1||mask[i-1]<=127||mask[i+1]<=127||mask[i-canvas.width]<=127||mask[i+canvas.width]<=127);
        data.data[p]=accent[0];data.data[p+1]=accent[1];data.data[p+2]=accent[2];
        data.data[p+3]=edge&&((x+y)%12)<6?255:Math.round(value*(contour ? .35 : .65));
      }
      ctx.putImageData(data,0,0);
    };
    image.onerror=()=>{if(!canceled)failure.current?.();};
    image.src=src;
    return()=>{canceled=true;image.onload=null;image.onerror=null;};
  },[src,contour]);
  return <canvas ref={ref} className="ds-pixelmask" role="img" aria-label={label}/>;
}

/** Only the already measured changed/protected pixels are supplied as white. */
export function DriftOverlay({src,onError}:{src:string;onError?:()=>void}){
  return <MaskOverlay src={src} label="Changed pixels outside the effective mask" contour={false} onError={onError}/>;
}

export function CompareWipe({before,after,beforeLabel="Original",afterLabel="Preserved",overlay}:{before:string;after:string;beforeLabel?:string;afterLabel?:string;overlay?:ReactNode}){
  const [position,setPosition]=useState(50);
  const [aspect,setAspect]=useState(1);
  return <div className="ds-comparewipe">
    <div className="ds-comparewipe__stage" style={{["--compare-aspect" as string]:aspect}}>
      <img src={before} alt={beforeLabel} onLoad={event=>setAspect(event.currentTarget.naturalWidth/event.currentTarget.naturalHeight||1)}/>
      <img className="ds-comparewipe__after" src={after} alt={afterLabel} style={{clipPath:`inset(0 0 0 ${position}%)`}}/>
      <span className="ds-comparewipe__divider" aria-hidden style={{left:`${position}%`}}/>
      {overlay}
    </div>
    <Toolbar><Meta>{beforeLabel}</Meta><Meta>{afterLabel}</Meta></Toolbar>
    <SliderField label="Compare" min={0} max={100} value={position} unit="%" onChange={setPosition}/>
  </div>;
}
