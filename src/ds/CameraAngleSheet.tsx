import {Check,Camera,ArrowDown,ArrowDownLeft,ArrowDownRight,ArrowLeft,ArrowRight,ArrowUp,ArrowUpLeft,ArrowUpRight} from "lucide-react";
import type {ReactNode} from "react";

export type CameraAngleItem={id:string;label:string;src?:string;status?:string};

/* Where the camera goes, drawn as an arrow, so a slot with no result still says something. */
const DIRECTION:Record<string,ReactNode>={
  "high-left":<ArrowUpLeft size={22}/>,high:<ArrowUp size={22}/>,"high-right":<ArrowUpRight size={22}/>,
  "left-45":<ArrowLeft size={22}/>,"right-45":<ArrowRight size={22}/>,
  "low-left":<ArrowDownLeft size={22}/>,low:<ArrowDown size={22}/>,"low-right":<ArrowDownRight size={22}/>,
};

/** Angle selection as a compact 3 x 3 board around the original. A slot with no result shows the source softly under its arrow; nothing is simulated. */
export function CameraAngleSheet({items,source,selected,onChange,disabled=false,label="Camera angles",multiple=true}:{
  items:CameraAngleItem[];
  source?:{src?:string;label?:string};
  selected:string[];
  onChange?:(ids:string[])=>void;
  disabled?:boolean;
  label?:string;
  multiple?:boolean;
}){
  const slots=items.slice(0,8);
  const pick=(id:string)=>{
    if(disabled||!onChange)return;
    const next=selected.includes(id)?selected.filter(value=>value!==id):multiple?[...selected,id]:[id];
    onChange(slots.filter(item=>next.includes(item.id)).map(item=>item.id));
  };
  const tiles=slots.map(item=>{
    const on=selected.includes(item.id),ghost=item.src??source?.src;
    return <button key={item.id} type="button" className="ds-angle-sheet__tile" aria-label={item.label} aria-pressed={on} disabled={disabled||!onChange} onClick={()=>pick(item.id)}>
      <span className="ds-angle-sheet__frame" data-ghost={item.src?undefined:""}>
        {ghost&&<img src={ghost} alt={item.src?`${item.label} result`:""}/>}
        <span className="ds-angle-sheet__arrow" aria-hidden>{DIRECTION[item.id]??<Camera size={22}/>}</span>
        {on&&<span className="ds-angle-sheet__check" aria-hidden><Check size={14}/></span>}
      </span>
      <span className="ds-angle-sheet__label">{item.label}</span>
    </button>;
  });
  tiles.splice(4,0,<div key="original" className="ds-angle-sheet__original" aria-label="Original source">
    <span className="ds-angle-sheet__frame">{source?.src?<img src={source.src} alt={source.label??"Original source"}/>:<span className="ds-angle-sheet__empty">Choose a source image</span>}</span>
    <span className="ds-angle-sheet__label">Original</span>
  </div>);
  return <div className="ds-angle-sheet" role="group" aria-label={label}>{tiles}</div>;
}
