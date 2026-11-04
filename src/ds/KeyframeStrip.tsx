import {useEffect,useRef,useState,type DragEvent as ReactDragEvent,type PointerEvent as ReactPointerEvent,type KeyboardEvent as ReactKeyboardEvent,type ReactNode} from 'react';
import {ChevronDown,ChevronLeft,Plus,VolumeX,X} from 'lucide-react';
import {ASSET_DRAG,IconButton,Slider,referenceTrayDrop} from './components';
import {EXAMPLE_DRAG} from './example-media';
import './keyframe-strip.css';

/** Drag payload of a keyframe card that is being rearranged; carries its index. */
export const KEYFRAME_DRAG='application/x-comfyfield-keyframe';
export type KeyframeMediaDrop=NonNullable<ReturnType<typeof referenceTrayDrop>>;

/* Geometry as fractions of the strip width: four cards fill it exactly, the timeline is inset so the
   first and last anchors sit under a card. Vertical values are pixels below the card row. */
const CARD=.2275,GAP=(1-4*CARD)/3,X0=.06,X1=.94,NOTCH=.035;
const NOTCH_H=6,ELBOW=17,TRACK=34;
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const nearest=(values:number[],target:number)=>values.reduce((best,v)=>Math.abs(v-target)<Math.abs(best-target)?v:best,values[0]);
const pct=(fraction:number)=>`${fraction*100}%`;
export const keyframeSeconds=(frame:number,fps:number)=>Number((frame/fps).toFixed(2));

/** Card centres: each card sits over its anchor while there is room; otherwise cards pack side by side. */
export function keyframeCardCentres(anchors:number[]):number[] {
 const step=CARD+GAP,centres=anchors.map(x=>clamp(x,CARD/2,1-CARD/2));
 for(let i=1;i<centres.length;i++)centres[i]=Math.max(centres[i],centres[i-1]+step);
 for(let i=centres.length-1;i>=0;i--)centres[i]=Math.min(centres[i],i===centres.length-1?1-CARD/2:centres[i+1]-step);
 return centres;
}

/** A stem from the card notch down to its anchor: straight when aligned, one rounded elbow when not. */
function stem(from:number,to:number){
 if(Math.abs(from-to)<1)return `M${from} ${NOTCH_H}V${TRACK}`;
 const r=Math.min(6,Math.abs(from-to)/2),d=Math.sign(to-from);
 return `M${from} ${NOTCH_H}V${ELBOW-r}Q${from} ${ELBOW} ${from+d*r} ${ELBOW}H${to-d*r}Q${to} ${ELBOW} ${to} ${ELBOW+r}V${TRACK}`;
}
const carriesMedia=(data:DataTransfer)=>!data.types.includes(KEYFRAME_DRAG)&&(data.types.includes('Files')||data.types.includes(ASSET_DRAG)||data.types.includes(EXAMPLE_DRAG));

/** Keyframe cards over a mini timeline. Drag an anchor to change its time (snapped to `positions`),
 * drag a card onto another to rearrange the pictures (times stay), hover or drop media on the timeline
 * to add a keyframe. The picture of each card is the caller's UploadSlot, so drop, paste and pick stay one component. */
export function KeyframeStrip({frames,fps,maxFrame,disabled=false,activeSegment=-1,media,positions,insertPositions,onMove,onReorder,onInsert,onRemove,mention,onMention,end}:{
 /** One quiet control at the end of the duration line (for example the tool's info button). */
 end?:ReactNode;
 frames:{frame:number;filled:boolean}[];fps:number;
 /** The timeline's full length in frames (the model limit). */
 maxFrame:number;disabled?:boolean;activeSegment?:number;
 media:(index:number)=>ReactNode;
 /** Positions this keyframe may take, ascending; empty when it is fixed. */
 positions:(index:number)=>number[];
 /** Positions where one more keyframe fits. */
 insertPositions:number[];
 onMove:(index:number,frame:number)=>void;
 onReorder:(from:number,to:number)=>void;
 onInsert:(frame:number,drop:KeyframeMediaDrop|null)=>void;
 /** Remove an empty card (filled cards remove through their picture's own button). */
 onRemove?:(index:number)=>void;
 mention?:(index:number)=>string|null;onMention?:(index:number)=>void;
}){
 const rail=useRef<HTMLDivElement>(null);
 const [width,setWidth]=useState(0),[dragging,setDragging]=useState<number|null>(null),[hot,setHot]=useState<number|null>(null);
 const [ghost,setGhost]=useState<{frame:number;drop:boolean}|null>(null),[moving,setMoving]=useState<number|null>(null),[target,setTarget]=useState<number|null>(null);
 useEffect(()=>{const el=rail.current;if(!el||typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(([entry])=>setWidth(entry.contentRect.width));observer.observe(el);return()=>observer.disconnect();},[]);
 const at=(frame:number)=>X0+(maxFrame?clamp(frame/maxFrame,0,1):0)*(X1-X0);
 const railX=(clientX:number)=>{const r=rail.current?.getBoundingClientRect();return r?.width?{x:(clientX-r.left)/r.width,w:r.width}:null;};
 const frameAt=(x:number)=>(x-X0)/(X1-X0)*maxFrame;
 const anchors=frames.map(f=>at(f.frame)),centres=keyframeCardCentres(anchors);
 const notches=anchors.map((x,i)=>clamp(x,centres[i]-CARD/2+NOTCH,centres[i]+CARD/2-NOTCH));
 const last=frames.length-1,durations=positions(last),lit=dragging??hot;
 const fallbackInsert=insertPositions.find(p=>p>frames[last].frame)??insertPositions[Math.floor(insertPositions.length/2)];
 const insertAt=ghost?.frame??fallbackInsert;
 const ticks=Math.max(1,Math.round(maxFrame/fps*2));

 function hover(e:ReactPointerEvent<HTMLDivElement>){
  const p=railX(e.clientX);
  if(disabled||dragging!==null||!insertPositions.length||!p||anchors.some(a=>Math.abs(a-p.x)*p.w<14)){setGhost(null);return;}
  const frame=nearest(insertPositions,frameAt(p.x));
  setGhost(Math.abs(at(frame)-p.x)*p.w<=40?{frame,drop:false}:null);
 }
 function drag(index:number,e:ReactPointerEvent<HTMLButtonElement>){
  if(!e.currentTarget.hasPointerCapture(e.pointerId))return;
  const options=positions(index),p=railX(e.clientX);if(!options.length||!p)return;
  const next=nearest(options,frameAt(p.x));if(next!==frames[index].frame)onMove(index,next);
 }
 function key(index:number,e:ReactKeyboardEvent<HTMLButtonElement>){
  const options=positions(index),now=frames[index].frame;if(!options.length)return;
  const next=e.key==='ArrowLeft'||e.key==='ArrowDown'?options.filter(v=>v<now).at(-1):e.key==='ArrowRight'||e.key==='ArrowUp'?options.find(v=>v>now):e.key==='Home'?options[0]:e.key==='End'?options.at(-1):null;
  if(next===null)return;e.preventDefault();if(next!==undefined&&next!==now)onMove(index,next);
 }
 function mediaOver(e:ReactDragEvent<HTMLDivElement>){
  const p=railX(e.clientX);if(disabled||!insertPositions.length||!p||!carriesMedia(e.dataTransfer))return;
  e.preventDefault();e.dataTransfer.dropEffect='copy';setGhost({frame:nearest(insertPositions,frameAt(p.x)),drop:true});
 }
 function mediaDrop(e:ReactDragEvent<HTMLDivElement>){
  const p=railX(e.clientX);if(disabled||!insertPositions.length||!p||!carriesMedia(e.dataTransfer))return;
  e.preventDefault();const drop=referenceTrayDrop(e.dataTransfer);setGhost(null);onInsert(nearest(insertPositions,frameAt(p.x)),drop);
 }
 function cardOver(index:number,e:ReactDragEvent<HTMLDivElement>){
  if(disabled||!e.dataTransfer.types.includes(KEYFRAME_DRAG))return;
  e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='move';setTarget(index);
 }
 function cardDrop(index:number,e:ReactDragEvent<HTMLDivElement>){
  if(!e.dataTransfer.types.includes(KEYFRAME_DRAG))return;
  e.preventDefault();e.stopPropagation();const from=Number(e.dataTransfer.getData(KEYFRAME_DRAG));setMoving(null);setTarget(null);
  if(!disabled&&Number.isInteger(from)&&from!==index)onReorder(from,index);
 }
 const bubble=dragging!==null?{x:anchors[dragging],frame:frames[dragging].frame}:ghost?{x:at(ghost.frame),frame:ghost.frame}:null;

 return <div className="ds-kstrip" data-dragging={dragging!==null||undefined}>
  <div className="ds-kstrip__cards">{frames.map((f,i)=>{const label=mention?.(i);return <div key={i} className="ds-kstrip__card" style={{left:pct(centres[i]-CARD/2),width:pct(CARD)}} data-filled={f.filled} data-lit={lit===i} data-moving={moving===i} data-target={target===i&&moving!==i} draggable={f.filled&&!disabled} onPointerEnter={()=>setHot(i)} onPointerLeave={()=>setHot(h=>h===i?null:h)} onDragStart={e=>{e.dataTransfer.setData(KEYFRAME_DRAG,String(i));e.dataTransfer.effectAllowed='move';setMoving(i);}} onDragEnd={()=>{setMoving(null);setTarget(null);}} onDragOverCapture={e=>cardOver(i,e)} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))setTarget(t=>t===i?null:t);}} onDropCapture={e=>cardDrop(i,e)}>
   <span className="ds-kstrip__time">{keyframeSeconds(f.frame,fps)}s</span>
   {media(i)}
   {!f.filled&&onRemove&&<IconButton className="ds-kstrip__remove ds-corner-x" label={`Remove frame ${i+1}`} disabled={disabled} onClick={()=>onRemove(i)}><X size={12}/></IconButton>}
   {label&&<button type="button" className="ds-kstrip__mention" disabled={disabled} aria-label={`Insert ${label} into the segment prompt`} onClick={()=>onMention?.(i)}>{label}</button>}
  </div>;})}</div>
  <div className="ds-kstrip__rail" ref={rail} style={{['--kstrip-track' as string]:`${TRACK}px`}} onPointerMove={hover} onPointerLeave={()=>setGhost(g=>g?.drop?g:null)} onDragOver={mediaOver} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))setGhost(null);}} onDrop={mediaDrop}>
   {width>0&&<svg className="ds-kstrip__stems" width={width} height={TRACK} aria-hidden="true">{frames.map((_,i)=>{const n=notches[i]*width,m=anchors[i]*width;return <g key={i} data-lit={lit===i}><path className="ds-kstrip__notch" d={`M${n-5} 0H${n+5}L${n} ${NOTCH_H}Z`}/><path className="ds-kstrip__stem" d={stem(n,m)}/></g>;})}</svg>}
   <div className="ds-kstrip__track" style={{left:pct(X0),width:pct(X1-X0)}}><div className="ds-kstrip__used" style={{width:pct(maxFrame?clamp(frames[last].frame/maxFrame,0,1):0)}}/></div>
   {activeSegment>=0&&activeSegment<last&&<div className="ds-kstrip__band" style={{left:pct(anchors[activeSegment]),width:pct(anchors[activeSegment+1]-anchors[activeSegment])}}/>}
   <div className="ds-kstrip__ticks" aria-hidden="true" style={{left:pct(X0),width:pct(X1-X0)}}>{Array.from({length:ticks+1},(_,k)=><i key={k} data-major={k%2===0} style={{left:pct(k/ticks)}}/>)}</div>
   {frames.map((f,i)=>{const options=positions(i),seconds=keyframeSeconds(f.frame,fps);return <button key={i} type="button" role="slider" className="ds-kstrip__anchor" style={{left:pct(anchors[i])}} data-lit={lit===i} data-fixed={!options.length} aria-label={`Frame ${i+1} time`} aria-valuemin={keyframeSeconds(options[0]??f.frame,fps)} aria-valuemax={keyframeSeconds(options.at(-1)??f.frame,fps)} aria-valuenow={seconds} aria-valuetext={`${seconds} seconds`} disabled={disabled||!options.length} onPointerEnter={()=>setHot(i)} onPointerLeave={()=>setHot(h=>h===i?null:h)} onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);setDragging(i);setGhost(null);}} onPointerMove={e=>drag(i,e)} onPointerUp={()=>setDragging(null)} onPointerCancel={()=>setDragging(null)} onKeyDown={e=>key(i,e)}/>;})}
   {insertAt!==undefined&&!disabled&&<button type="button" className="ds-kstrip__insert" style={{left:pct(at(insertAt))}} data-show={!!ghost} aria-label={`Add a keyframe at ${keyframeSeconds(insertAt,fps)} seconds`} onClick={()=>{setGhost(null);onInsert(insertAt,null);}}><Plus size={13} strokeWidth={2.5}/></button>}
   {bubble&&<span className="ds-kstrip__bubble" style={{left:pct(bubble.x)}}>{keyframeSeconds(bubble.frame,fps)}s</span>}
  </div>
  <label className="ds-kstrip__duration"><span>Duration</span><Slider aria-label="Duration" min={durations[0]??frames[last].frame} max={durations.at(-1)??frames[last].frame} step={1} value={frames[last].frame} disabled={disabled||durations.length<2} onChange={e=>{const next=nearest(durations,Number(e.target.value));if(next!==undefined&&next!==frames[last].frame)onMove(last,next);}}/><span className="ds-kstrip__seconds">{keyframeSeconds(frames[last].frame,fps)} sec</span>{end}</label>
 </div>;
}

/** One transition between two keyframes: time range, title, the prompt's first words while closed. */
export function KeyframeSegment({time,title,summary,open,onToggle,children}:{time:string;title:string;summary?:string;open:boolean;onToggle:()=>void;children?:ReactNode}){
 return <div className="ds-kseg" data-open={open}><button type="button" className="ds-kseg__head" aria-expanded={open} onClick={onToggle}><span className="ds-kseg__time">{time}</span><span className="ds-kseg__title">{title}</span>{!open&&summary&&<span className="ds-kseg__summary">{summary}</span>}<ChevronDown size={16} aria-hidden="true"/></button>{open&&<div className="ds-kseg__body">{children}</div>}</div>;
}

/** The compact output options under keyframe segments: equal tiles, plus a silent-output fact. */
export function KeyframeOptions({children,silent}:{children:ReactNode;silent?:boolean}){
 return <div className="ds-kopts">{children}{silent&&<span className="ds-kopts__silent" title="Keyframe animations are silent"><VolumeX size={17} aria-hidden="true"/><span className="ds-kopts__sr">Silent output</span></span>}</div>;
}

/** Panel breadcrumb: back link, parent tool, current mode, one trailing action. */
export function PanelCrumb({back,parent,title,end}:{back:{href:string;label:string};parent:string;title:string;end?:ReactNode}){
 return <div className="ds-crumb"><a href={back.href} aria-label={back.label} className="ds-crumb__back"><ChevronLeft size={18}/></a><span>{parent}</span><span aria-hidden="true">/</span><strong>{title}</strong>{end&&<span className="ds-crumb__end">{end}</span>}</div>;
}
