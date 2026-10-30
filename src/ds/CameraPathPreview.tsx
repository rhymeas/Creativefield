import type {CSSProperties} from "react";
import {Meta} from "./components";

/** How each native camera pose moves the frame. Distances are a share of the frame at speed 1. */
const MOVES:Record<string,{x?:number;y?:number;scale?:number;rotate?:number}>={
  "Pan Left":{x:0.12},"Pan Right":{x:-0.12},"Pan Up":{y:0.12},"Pan Down":{y:-0.12},
  "Zoom In":{scale:0.22},"Zoom Out":{scale:-0.18},
  "Anti Clockwise (ACW)":{rotate:-8},"ClockWise (CW)":{rotate:8},
};

/** Instant, free preview of where the camera goes. It moves the start frame only; it is not the generated result. */
export function CameraPathPreview({src,alt="",pose,speed=1,seconds=1}:{src?:string;alt?:string;pose:string;speed?:number;seconds?:number}){
  const move=MOVES[pose];
  if(!src||!move)return null;
  const k=Math.max(0.1,Math.min(speed,3));
  // scale(s) translate(t) shifts by s*t, so covering the frame needs s >= 1/(1-2t); a zoom-out must also end at or above that.
  const shift=Math.min(0.4,Math.max(Math.abs(move.x??0),Math.abs(move.y??0))*k);
  const base=1.03/(1-2*shift)+Math.max(0,-(move.scale??0)*k);
  const style={
    "--cam-base":String(base),
    "--cam-x":`${Math.sign(move.x??0)*(move.x?shift:0)*100}%`,"--cam-y":`${Math.sign(move.y??0)*(move.y?shift:0)*100}%`,
    "--cam-scale":String(base+(move.scale??0)*k),"--cam-rotate":`${(move.rotate??0)*k}deg`,
    "--cam-duration":`${Math.max(1,Math.min(seconds,5))*1.2}s`,
  } as CSSProperties;
  const endScale=base+(move.scale??0)*k,endX=Math.sign(move.x??0)*(move.x?shift:0)*100,endY=Math.sign(move.y??0)*(move.y?shift:0)*100,endRotate=(move.rotate??0)*k;
  const rail=[0,.5,1].map(progress=>({progress,transform:`scale(${base+(endScale-base)*progress}) translate(${endX*progress}%, ${endY*progress}%) rotate(${endRotate*progress}deg)`}));
  return <figure className="ds-campath" aria-label={`Path preview: ${pose}`}>
    <div className="ds-campath__frame"><img src={src} alt={alt} style={style}/></div>
    <div className="ds-campath__rail" aria-hidden="true">
      {rail.map(frame=><span key={frame.progress} title={frame.progress===0?"Start":frame.progress===1?"End":"Mid"}><img src={src} alt="" style={{transform:frame.transform}}/></span>)}
    </div>
    <figcaption title="Moves the start frame only; the generated video will differ"><Meta parts={["Path preview only",pose,`×${k.toFixed(1)}`]}/></figcaption>
  </figure>;
}
