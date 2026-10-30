import {Button,Meta,Slider} from "./components";

export type SweepFrame={src:string;label?:string};

/** Scrub a camera sweep: one large view, a rail of every captured view, the original marked in the middle. */
export function AngleSweepViewer({frames,originalIndex,index,onIndex,onSave,saving=false,reliableSteps,label="Camera sweep"}:{
  frames:SweepFrame[];
  originalIndex:number;
  index:number;
  onIndex:(index:number)=>void;
  /** Saves the shown view as a still. Hidden when omitted. */
  onSave?:(index:number)=>void;
  saving?:boolean;
  /** Views further than this many steps from the original are dimmed and marked less reliable. */
  reliableSteps?:number;
  label?:string;
}){
  if(!frames.length)return null;
  const far=(i:number)=>reliableSteps!==undefined&&Math.abs(i-originalIndex)>reliableSteps;
  const last=frames.length-1,current=Math.min(Math.max(index,0),last),isOriginal=current===originalIndex;
  const step=(delta:number)=>onIndex(Math.min(Math.max(current+delta,0),last));
  return <div className="ds-sweep" role="group" aria-label={label} onKeyDown={e=>{if(e.key==="ArrowLeft"){e.preventDefault();step(-1);}else if(e.key==="ArrowRight"){e.preventDefault();step(1);}}}>
    <figure className="ds-sweep__stage"><img src={frames[current].src} alt={frames[current].label??`View ${current+1} of ${frames.length}`}/></figure>
    <Slider aria-label="View position" min={0} max={last} step={1} value={current} onChange={e=>onIndex(Number(e.target.value))}/>
    <div className="ds-sweep__rail" role="listbox" aria-label="Captured views">
      {frames.map((frame,i)=><button key={i} type="button" role="option" aria-selected={i===current} aria-label={frame.label??`View ${i+1}`} className="ds-sweep__thumb" data-original={i===originalIndex||undefined} data-far={far(i)||undefined} onClick={()=>onIndex(i)}><img src={frame.src} alt=""/></button>)}
    </div>
    <div className="ds-sweep__foot">
      <Meta parts={[isOriginal?"Original":frames[current].label??`View ${current+1}`,`${current+1} / ${frames.length}`,far(current)&&"Less reliable"]}/>
      {onSave&&<Button variant="secondary" disabled={saving||isOriginal} onClick={()=>onSave(current)}>{saving?"Saving":"Save view"}</Button>}
    </div>
  </div>;
}
