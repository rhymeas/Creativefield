import {Lock,Maximize2,Minus,Plus,RotateCcw} from 'lucide-react';
import {useEffect,useRef,useState,type CSSProperties,type KeyboardEvent as ReactKeyboardEvent,type PointerEvent as ReactPointerEvent,type ReactNode,type SyntheticEvent} from 'react';
import {Button,Dialog,IconButton,Row} from './components';
import './camera-move-picker.css';

/** Where the camera ends, relative to where it starts: x and y in shares of the frame (right and down are
 * positive), zoom as a factor (above 1 pushes in). */
export type CameraPose={x:number;y:number;zoom:number};
export const STILL_POSE:CameraPose={x:0,y:0,zoom:1};
const SHARE=2/3; // the start frame's share of the stage, so there is room around it to aim the camera
const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
const isStill=(p:CameraPose)=>p.x===0&&p.y===0&&p.zoom===1;

/** Short words for a pose: "Pan left 30% · Zoom in 1.4×". */
export function describeCameraPose(pose:CameraPose|null,none='No camera move'){
 if(!pose)return none;
 if(isStill(pose))return 'Hold still';
 const parts:string[]=[];
 if(pose.x)parts.push(`Pan ${pose.x<0?'left':'right'} ${Math.round(Math.abs(pose.x)*100)}%`);
 if(pose.y)parts.push(`Tilt ${pose.y<0?'up':'down'} ${Math.round(Math.abs(pose.y)*100)}%`);
 if(pose.zoom!==1)parts.push(`Zoom ${pose.zoom>1?'in':'out'} ${Number(pose.zoom.toFixed(2))}×`);
 return parts.join(' · ');
}
/** Rounded to 5 % steps and 0.05× zoom, with a dead zone around "no move" so small wobbles stay still. */
function tidy(p:CameraPose):CameraPose{
 const step=(v:number)=>Math.round(v*20)/20;
 let x=step(clamp(p.x,-.5,.5)),y=step(clamp(p.y,-.5,.5)),zoom=step(clamp(p.zoom,.75,2.5));
 if(Math.abs(x)<.05)x=0;if(Math.abs(y)<.05)y=0;if(Math.abs(zoom-1)<.05)zoom=1;
 return {x:x||0,y:y||0,zoom};
}
const distance=(a:CameraPose,b:CameraPose)=>Math.hypot(a.x-b.x,a.y-b.y,Math.log(a.zoom/b.zoom)*.9);
const nearest=(p:CameraPose,presets:CameraPose[])=>presets.reduce((best,v)=>distance(v,p)<distance(best,p)?v:best,presets[0]);

/** The stand-in world when the shot has no picture yet. Drawn wider than the start frame (0 0 160 90),
 * so the camera can be aimed past its edges. */
function World({frame}:{frame?:boolean}){
 return <svg className="ds-campose__world" viewBox={frame?'0 0 160 90':'-40 -22.5 240 135'} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <rect className="w-sky" x="-60" y="-40" width="300" height="180"/>
  <g className="w-stars">{[[-30,-12],[-8,4],[12,-14],[30,8],[58,-6],[96,-16],[132,2],[150,-12],[176,6],[192,-8],[-20,16],[70,14],[184,22]].map(([x,y],i)=><circle key={i} cx={x} cy={y} r={i%3?0.7:1.1}/>)}</g>
  <circle className="w-moon" cx="128" cy="12" r="9"/><circle className="w-crater" cx="125" cy="10" r="2"/><circle className="w-crater" cx="131" cy="15" r="1.3"/>
  <g className="w-cloud"><ellipse cx="20" cy="6" rx="16" ry="4"/><ellipse cx="30" cy="3" rx="9" ry="4.5"/></g>
  <g className="w-cloud w-cloud--slow"><ellipse cx="150" cy="26" rx="14" ry="3.5"/><ellipse cx="158" cy="23.5" rx="7" ry="3.5"/></g>
  <path className="w-far" d="M-60 52 L-34 30 L-14 44 L8 22 L30 42 L52 26 L78 46 L104 20 L130 40 L152 28 L178 44 L204 24 L240 46 V140 H-60Z"/>
  <path className="w-snow" d="M8 22 L3 27 L8 26 L12 28Z M104 20 L99 25 L104 24 L109 26Z M204 24 L199 29 L204 28 L209 30Z"/>
  <path className="w-mid" d="M-60 60 Q-20 48 20 56 T100 54 T170 52 T240 56 V140 H-60Z"/>
  <g className="w-trees">{[-30,-18,4,14,118,128,140,186,198].map((x,i)=><path key={i} d={`M${x} ${55-(i%2)*2} l4 -10 l4 10Z`}/>)}</g>
  <g className="w-house"><rect x="150" y="45" width="14" height="9"/><path d="M148 46 L157 38 L166 46Z"/><rect className="w-window" x="153" y="48" width="3" height="3"/><rect className="w-window" x="159" y="48" width="3" height="3"/></g>
  <rect className="w-lake" x="-60" y="64" width="300" height="10"/>
  <g className="w-ripples"><path d="M-10 67 h14 M40 70 h20 M100 66 h12 M150 71 h18 M190 68 h10"/></g>
  <path className="w-moonpath" d="M122 65 h12 M124 68 h8 M126 71 h4"/>
  <path className="w-shore" d="M-60 74 Q0 70 60 76 T180 74 T240 76 V140 H-60Z"/>
  <path className="w-road" d="M60 112 Q70 92 78 80 T86 74"/>
  <g className="w-figure"><rect className="w-subject" x="76" y="62" width="8" height="14" rx="4"/><circle className="w-subject" cx="80" cy="58" r="3.6"/><path className="w-arm" d="M83.5 65 L90 59"/></g>
  <path className="w-lamp" d="M104 80 V64 M104 64 h4"/><circle className="w-light" cx="108" cy="65.5" r="1.8"/>
  <path className="w-near" d="M-60 94 Q-20 84 20 92 Q60 100 100 90 Q140 82 180 92 Q210 98 240 90 V140 H-60Z"/>
  <g className="w-rocks"><ellipse cx="-14" cy="92" rx="9" ry="4"/><ellipse cx="146" cy="94" rx="11" ry="4.5"/></g>
  <path className="w-grass" d="M6 92 l2 -8 l2 8 M16 94 l1.5 -6 l2 6 M126 89 l2 -9 l2 9 M134 90 l1.5 -6 l2 6 M176 93 l2 -7 l2 7"/>
 </svg>;
}

/** The view through the camera: plays the move once and stays at its end (never loops back). Click to replay. */
function Monitor({pose,src}:{pose:CameraPose;src?:string}){
 const [run,setRun]=useState(0);
 const end=`scale(${pose.zoom}) translate(${-pose.x*100}%, ${-pose.y*100}%)`;
 return <button type="button" className="ds-campose__monitor" aria-label="Replay the camera move" onClick={()=>setRun(v=>v+1)}>
  <span key={`${end}:${run}`} className="ds-campose__view" style={{['--end' as string]:end} as CSSProperties}>
   {src?<><img className="ds-campose__beyond" src={src} alt="" draggable={false}/><img className="ds-campose__picture" src={src} alt="" draggable={false}/></>:<World frame/>}
  </span>
  <span className="ds-campose__monitor-label">Camera view</span>
 </button>;
}

/** Aim the camera on the picture itself: click or drag to place where the shot ends, scroll or drag a corner to
 * zoom. The end frame stays where it is put. With `presets`, it snaps to the moves the model can follow. */
export function CameraPoseStage({value,src,presets,disabled=false,onChange}:{value:CameraPose|null;
 /** The shot's own picture; without one, a drawn world stands in. */
 src?:string;presets?:CameraPose[];disabled?:boolean;onChange:(pose:CameraPose)=>void}){
 const stage=useRef<HTMLDivElement>(null),drag=useRef<null|'move'|'size'>(null);
 /* The stage takes the picture's own shape, so the start frame shows the whole picture and every frame on it is that shape. */
 const [pictureShape,setPictureShape]=useState<number>();
 const measure=(e:SyntheticEvent<HTMLImageElement>)=>{const {naturalWidth:width,naturalHeight:height}=e.currentTarget;if(width&&height)setPictureShape(width/height);};
 const pose=value??STILL_POSE,latest=useRef({pose,onChange,presets,disabled});
 latest.current={pose,onChange,presets,disabled};
 const set=(next:CameraPose)=>{const {presets:p,onChange:change}=latest.current,clean=tidy(next);change(p?.length?nearest(clean,p):clean);};
 const zoomBy=(factor:number)=>{const {pose:p,presets:list}=latest.current;set({...p,zoom:list?.length?(factor>1?Math.max(...list.map(v=>v.zoom)):Math.min(...list.map(v=>v.zoom))):p.zoom*factor});};
 useEffect(()=>{const el=stage.current;if(!el)return;const wheel=(e:WheelEvent)=>{if(latest.current.disabled)return;e.preventDefault();zoomBy(Math.exp(-e.deltaY*.0015));};el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);},[]);
 const point=(e:ReactPointerEvent)=>{const r=stage.current!.getBoundingClientRect();return {x:((e.clientX-r.left)/r.width-.5)/SHARE,y:((e.clientY-r.top)/r.height-.5)/SHARE};};
 function down(e:ReactPointerEvent<HTMLDivElement>){
  if(disabled||e.button!==0||(e.target as Element).closest('.ds-campose__monitor'))return;
  drag.current=(e.target as Element).closest('[data-handle]')?'size':'move';e.currentTarget.setPointerCapture(e.pointerId);
  if(drag.current==='move'){const p=point(e);set({...latest.current.pose,x:p.x,y:p.y});}
 }
 function move(e:ReactPointerEvent<HTMLDivElement>){
  if(!drag.current)return;const p=point(e),current=latest.current.pose;
  if(drag.current==='move')set({...current,x:p.x,y:p.y});
  else set({...current,zoom:.5/Math.max(.08,Math.abs(p.x-current.x),Math.abs(p.y-current.y))});
 }
 function key(e:ReactKeyboardEvent){
  const step=.05,p=latest.current.pose,map:Record<string,()=>void>={ArrowLeft:()=>set({...p,x:p.x-(presets?.3:step)}),ArrowRight:()=>set({...p,x:p.x+(presets?.3:step)}),ArrowUp:()=>set({...p,y:p.y-(presets?.3:step)}),ArrowDown:()=>set({...p,y:p.y+(presets?.3:step)}),'+':()=>zoomBy(1.1),'=':()=>zoomBy(1.1),'-':()=>zoomBy(1/1.1),'0':()=>set(STILL_POSE)};
  if(disabled||!map[e.key])return;e.preventDefault();map[e.key]();
 }
 const cx=50+pose.x*SHARE*100,cy=50+pose.y*SHARE*100,size=SHARE*100/pose.zoom,moving=!!value&&!isStill(pose);
 const corners:ReactNode=['nw','ne','sw','se'].map(c=><i key={c} data-handle={c}/>);
 return <div className="ds-campose" data-disabled={disabled||undefined} style={src&&pictureShape?{['--campose-shape' as string]:pictureShape} as CSSProperties:undefined}>
  <div className="ds-campose__stage" ref={stage} tabIndex={disabled?-1:0} role="application" aria-label={`Camera: ${describeCameraPose(value)}. Click or drag on the picture to aim the end of the shot, scroll to zoom; arrow keys, plus and minus also work.`} onPointerDown={down} onPointerMove={move} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onKeyDown={key}>
   {src?<><img className="ds-campose__beyond" src={src} alt="" draggable={false}/><img className="ds-campose__picture ds-campose__picture--start" src={src} alt="" draggable={false} onLoad={measure}/></>:<World/>}
   <span className="ds-campose__start"><b>Start</b></span>
   {moving&&<svg className="ds-campose__path" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line x1="50" y1="50" x2={cx} y2={cy}/></svg>}
   {value&&<span className="ds-campose__end" data-still={!moving||undefined} style={{left:`${cx-size/2}%`,top:`${cy-size/2}%`,width:`${size}%`,height:`${size}%`}}><b>{moving?'End':'Locked'}</b>{corners}</span>}
   {value&&<Monitor pose={pose} src={src}/>}
  </div>
 </div>;
}

/** The camera move as one row that names it, opening the stage in a dialog; or, `inline`, the stage itself in the
 * panel with a slim line of tools under it (the dialog stays one click away for precise aiming). Changes apply as you aim. */
export function CameraPoseField({label='Camera direction',value,src,presets,none='No camera move',disabled=false,inline=false,onChange}:{label?:string;value:CameraPose|null;src?:string;presets?:CameraPose[];none?:string;disabled?:boolean;inline?:boolean;onChange:(pose:CameraPose|null)=>void}){
 const [open,setOpen]=useState(false);
 const zoom=(more:boolean)=>onChange({...(value??STILL_POSE),zoom:presets?.length?(more?Math.max(...presets.map(p=>p.zoom)):Math.min(...presets.map(p=>p.zoom))):Math.min(2.5,Math.max(.75,(value??STILL_POSE).zoom+(more?.1:-.1)))});
 return <>
  {inline?<div className="ds-campose-inline" aria-label={label} role="group">
   <CameraPoseStage value={value} src={src} presets={presets} disabled={disabled} onChange={onChange}/>
   <div className="ds-campose-inline__bar">
    <span className="ds-campose-inline__readout" title={describeCameraPose(value,none)}>{describeCameraPose(value,`${none} · drag on the picture`)}</span>
    <IconButton label="Zoom out" disabled={disabled} onClick={()=>zoom(false)}><Minus size={14}/></IconButton>
    <IconButton label="Zoom in" disabled={disabled} onClick={()=>zoom(true)}><Plus size={14}/></IconButton>
    <IconButton label="Hold still" disabled={disabled} onClick={()=>onChange(STILL_POSE)}><Lock size={13}/></IconButton>
    {value&&<IconButton label={none} disabled={disabled} onClick={()=>onChange(null)}><RotateCcw size={13}/></IconButton>}
    <IconButton label="Open larger" disabled={disabled} onClick={()=>setOpen(true)}><Maximize2 size={13}/></IconButton>
   </div>
  </div>:<Row label={label} display={describeCameraPose(value,none)} disabled={disabled} onClick={()=>setOpen(true)}/>}
  <Dialog wide open={open&&!disabled} title={label} onClose={()=>setOpen(false)} footer={<>
   <span className="ds-campose__readout">{describeCameraPose(value,none)}</span>
   <IconButton label="Zoom out" disabled={disabled} onClick={()=>onChange({...(value??STILL_POSE),zoom:presets?.length?Math.min(...presets.map(p=>p.zoom)):Math.max(.75,(value??STILL_POSE).zoom-.1)})}><Minus size={16}/></IconButton>
   <IconButton label="Zoom in" disabled={disabled} onClick={()=>onChange({...(value??STILL_POSE),zoom:presets?.length?Math.max(...presets.map(p=>p.zoom)):Math.min(2.5,(value??STILL_POSE).zoom+.1)})}><Plus size={16}/></IconButton>
   <Button variant="ghost" disabled={disabled} onClick={()=>onChange(STILL_POSE)}>Hold still</Button>
   <Button variant="ghost" disabled={disabled||!value} onClick={()=>onChange(null)}><RotateCcw size={14}/> {none}</Button>
   <Button variant="primary" onClick={()=>setOpen(false)}>Done</Button>
  </>}><CameraPoseStage value={value} src={src} presets={presets} disabled={disabled} onChange={onChange}/></Dialog>
 </>;
}
