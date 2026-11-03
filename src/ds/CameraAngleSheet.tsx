import {Check,Camera,ArrowDown,ArrowDownLeft,ArrowDownRight,ArrowLeft,ArrowRight,ArrowUp,ArrowUpLeft,ArrowUpRight} from "lucide-react";
import {useId,type ReactNode} from "react";

export type CameraAngleItem={id:string;label:string;src?:string;status?:string};
export const CAMERA_ANGLE_PREVIEW_SIZE=250;

const SLOT_DIRECTIONS=["high-left","high","high-right","left-45","right-45","low-left","low","low-right"] as const;

/* Where the camera goes, drawn as an arrow, so a slot with no result still says something. */
const DIRECTION:Record<string,ReactNode>={
  "high-left":<ArrowUpLeft size={22}/>,high:<ArrowUp size={22}/>,"high-right":<ArrowUpRight size={22}/>,
  "left-45":<ArrowLeft size={22}/>,"right-45":<ArrowRight size={22}/>,
  "low-left":<ArrowDownLeft size={22}/>,low:<ArrowDown size={22}/>,"low-right":<ArrowDownRight size={22}/>,
};

/** Angle selection as a compact 3 x 3 board around the original. Only model outputs appear as angle thumbnails. */
export function CameraAngleSheet({items,source,selected,onChange,disabled=false,label="Camera angles",multiple=true,compact=false}:{
  items:CameraAngleItem[];
  source?:{src?:string;label?:string};
  selected:string[];
  onChange?:(ids:string[])=>void;
  disabled?:boolean;
  label?:string;
  multiple?:boolean;
  compact?:boolean;
}){
  const slots=items.slice(0,8),descriptionId=useId();
  const pick=(id:string)=>{
    if(disabled||!onChange)return;
    const next=selected.includes(id)?selected.filter(value=>value!==id):multiple?[...selected,id]:[id];
    onChange(slots.filter(item=>next.includes(item.id)).map(item=>item.id));
  };
  const tiles=slots.map((item,index)=>{
    const on=selected.includes(item.id),direction=DIRECTION[item.id]?item.id:SLOT_DIRECTIONS[index];
    const state=item.src?(item.status??"Generated result"):(item.status??"Not generated");
    const stateId=`${descriptionId}-${index}`;
    return <button key={item.id} type="button" className="ds-angle-sheet__tile" aria-label={item.label} aria-describedby={stateId} aria-pressed={on} title={`${item.label} · ${state}`} disabled={disabled||!onChange} onClick={()=>pick(item.id)}>
      <span className="ds-angle-sheet__frame" data-result={item.src?true:undefined}>
        {item.src&&<img src={item.src} alt={`${item.label} result`} width={CAMERA_ANGLE_PREVIEW_SIZE} height={CAMERA_ANGLE_PREVIEW_SIZE} decoding="async"/>}
        <span className="ds-angle-sheet__arrow" aria-hidden>{DIRECTION[direction]??<Camera size={22}/>}</span>
        {on&&<span className="ds-angle-sheet__check" aria-hidden><Check size={14}/></span>}
      </span>
      <span className="ds-angle-sheet__label">{item.label}</span>
      <span id={stateId} className="ds-sr-only">{state}</span>
    </button>;
  });
  tiles.splice(4,0,<div key="original" className="ds-angle-sheet__original" aria-label="Original source">
    <span className="ds-angle-sheet__frame">{source?.src?<img src={source.src} alt={source.label??"Original source"} width={CAMERA_ANGLE_PREVIEW_SIZE} height={CAMERA_ANGLE_PREVIEW_SIZE} decoding="async"/>:<span className="ds-angle-sheet__empty">Choose a source image</span>}</span>
    <span className="ds-angle-sheet__label">Original</span>
  </div>);
  return <div className="ds-angle-sheet" data-compact={compact||undefined} role="group" aria-label={label}>{tiles}</div>;
}
