import type {ReactNode} from 'react';
import {Check,ChevronLeft,ChevronRight,ImageIcon,RotateCcw,Settings2,Sparkles,X} from 'lucide-react';
import {Button,IconButton} from './components';
import './shot-frame.css';

export type ShotFrameState='empty'|'running'|'candidate'|'approved'|'rejected';

/** The picture a text-only shot starts from, drawn from its prompt. Only the picture is always there;
 * drawing, choosing and new takes appear on hover or focus, and only those that apply now. */
export function ShotFrame({state,src,running,take,disabled=false,drawDisabledReason,onDraw,onUse,onReject,onRetake,onCancel,onPrev,onNext,onSettings}:{
 state:ShotFrameState;src?:string;
 /** Live progress of a frame being drawn. */
 running?:ReactNode;
 /** Which take is shown ("Take 2 of 3"), when there is more than one. */
 take?:string;disabled?:boolean;drawDisabledReason?:string;
 onDraw?:()=>void;onUse?:()=>void;onReject?:()=>void;onRetake?:()=>void;onCancel?:()=>void;onPrev?:()=>void;onNext?:()=>void;onSettings?:()=>void;
}){
 const picture=state==='running'?running:src?<img src={src} alt="Shot frame" draggable={false}/>:<span className="ds-shotframe__empty" aria-hidden="true"><ImageIcon size={18}/></span>;
 return <div className="ds-shotframe" data-state={state} tabIndex={-1}>
  {picture}
  {state==='approved'&&<span className="ds-shotframe__badge"><Check size={12}/>Start frame</span>}
  {state==='rejected'&&<span className="ds-shotframe__badge">Rejected</span>}
  {onSettings&&<span className="ds-shotframe__corner"><IconButton label="Frame settings" disabled={disabled} onClick={onSettings}><Settings2 size={14}/></IconButton></span>}
  <span className="ds-shotframe__actions">
   {state==='empty'&&onDraw&&<Button variant="secondary" disabled={disabled||!!drawDisabledReason} disabledReason={drawDisabledReason} onClick={onDraw}><Sparkles size={14}/> Draw frame</Button>}
   {state==='running'&&onCancel&&<Button variant="secondary" disabled={disabled} onClick={onCancel}>Cancel</Button>}
   {state==='candidate'&&<>{onUse&&<IconButton label="Use as start frame" disabled={disabled} onClick={onUse}><Check size={16}/></IconButton>}{onReject&&<IconButton label="Reject frame" disabled={disabled} onClick={onReject}><X size={16}/></IconButton>}</>}
   {state!=='empty'&&state!=='running'&&onRetake&&<IconButton label="New take" disabled={disabled||!!drawDisabledReason} onClick={onRetake}><RotateCcw size={15}/></IconButton>}
  </span>
  {take&&(onPrev||onNext)&&<span className="ds-shotframe__takes"><IconButton label="Previous take" disabled={!onPrev} onClick={onPrev}><ChevronLeft size={14}/></IconButton><span>{take}</span><IconButton label="Next take" disabled={!onNext} onClick={onNext}><ChevronRight size={14}/></IconButton></span>}
 </div>;
}
