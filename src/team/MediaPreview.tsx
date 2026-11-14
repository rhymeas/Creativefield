import {useState} from "react";
import {Meta} from "../ds";

/** A failed preview never removes the stored asset or its actions. Remount to retry. */
export function MediaPreview({src,kind,alt="",lazy=false,controls=false,onUnavailable}:{src:string;kind:"image"|"video";alt?:string;lazy?:boolean;controls?:boolean;onUnavailable?:()=>void}){
  const [failed,setFailed]=useState(false);
  const fail=()=>{setFailed(true);onUnavailable?.();};
  if(failed)return <Meta>Preview unavailable</Meta>;
  return kind==="image"
    ? <img draggable={false} src={src} alt={alt} loading={lazy?"lazy":undefined} onError={fail}/>
    : <video draggable={false} muted={!controls} controls={controls} playsInline preload="metadata" src={src} aria-label={alt||undefined} onError={fail}/>;
}
