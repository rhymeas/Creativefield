import {useEffect,useId,useLayoutEffect,useRef,useState} from "react";
import {ArrowUpRight,Check,RefreshCw} from "lucide-react";
import {Button,Notice,SparkleLoader} from "./components";

export type JobQueueItem={id:string;title:string;status:string;progress?:number;/** What the job makes, for example the start of its prompt. */detail?:string;/** Preparation rows have no run to open yet. */selectable?:boolean};

function ProgressRing({progress}:{progress?:number}){
  if(progress==null||!Number.isFinite(progress))return <SparkleLoader size="sm"/>;
  const value=Math.max(0,Math.min(1,progress));
  return <svg className="ds-job-queue__progress" viewBox="0 0 36 36" aria-hidden="true">
    <circle className="ds-job-queue__progress-track" cx="18" cy="18" r="15.5" pathLength="100"/>
    <circle className="ds-job-queue__progress-value" cx="18" cy="18" r="15.5" pathLength="100" strokeDasharray={`${value*100} 100`}/>
  </svg>;
}

/** Shared header job surface. Data fetching belongs to the application. */
export function JobQueueMenu({items,total=items.length,loading=false,error=false,onRefresh,onSelect,onAll}:{items:JobQueueItem[];total?:number;loading?:boolean;error?:boolean;onRefresh:()=>void;onSelect:(id:string)=>void;onAll:()=>void}){
  const [open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLElement>(null);
  const id=useId();
  const [offset,setOffset]=useState(0);
  const close=(restore=false)=>{setOpen(false);if(restore)trigger.current?.focus();};
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>setOffset(Math.max(0,(panel.current?.offsetWidth??0)-(root.current?.getBoundingClientRect().right??0)));
    place();window.addEventListener("resize",place);
    return()=>window.removeEventListener("resize",place);
  },[open]);
  useEffect(()=>{
    if(!open)return;
    panel.current?.focus();
    const away=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();close(true);}};
    document.addEventListener("pointerdown",away);
    document.addEventListener("keydown",key);
    return()=>{document.removeEventListener("pointerdown",away);document.removeEventListener("keydown",key);};
  },[open]);
  const latestProgress=items.find(item=>item.progress!=null&&Number.isFinite(item.progress))?.progress;
  return <div className="ds-job-queue" ref={root} onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node))setOpen(false);}}>
    <button ref={trigger} className="ds-job-queue__trigger" type="button" aria-label={total?`${total} active jobs`:"Jobs"} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" onClick={()=>{if(open)close();else{setOpen(true);onRefresh();}}}>
      <span className={`ds-job-queue__ring${total?" is-active":""}`} aria-hidden="true">{total?<><span>{total>99?"99+":total}</span><ProgressRing progress={latestProgress??0}/></>:<Check size={14}/>}</span><span>Jobs</span>
    </button>
    {open&&<section ref={panel} tabIndex={-1} className="ds-job-queue__panel" style={{transform:`translateX(${offset}px)`}} id={id} role="dialog" aria-label="Jobs" aria-busy={loading}>
      <header className="ds-job-queue__head"><div><strong>Jobs</strong><span>{loading?"Checking…":total?`${total} active`:"All caught up"}</span></div><button type="button" aria-label="Refresh jobs" title="Refresh" disabled={loading} onClick={onRefresh}>{loading?<SparkleLoader size="sm"/>:<RefreshCw size={15}/>}</button></header>
      {error?<Notice tone="danger" inline title="Could not update jobs" actions={<Button variant="secondary" onClick={onRefresh}>Try again</Button>}>Try again to check their status.</Notice>:items.length?<div className="ds-job-queue__list">{items.map(item=>{
        const content=<><span className="ds-job-queue__item-ring" aria-hidden="true"><ProgressRing progress={item.progress}/></span><span className="ds-job-queue__item-copy"><strong title={item.title}>{item.title}</strong><small>{item.status}{item.progress!=null&&Number.isFinite(item.progress)?` · ${Math.round(Math.max(0,Math.min(1,item.progress))*100)}%`:""}</small>{item.detail&&<small className="ds-job-queue__detail" title={item.detail}>{item.detail}</small>}</span>{item.selectable===false?null:<ArrowUpRight size={15} aria-hidden="true"/>}</>;
        return item.selectable===false?<div role="status" className="ds-job-queue__item" key={item.id}>{content}</div>:<button type="button" className="ds-job-queue__item" key={item.id} onClick={()=>{close();onSelect(item.id);}}>{content}</button>;
      })}</div>:<div className="ds-job-queue__empty">{loading?"Checking your jobs…":"No active jobs"}</div>}
      <button type="button" className="ds-job-queue__all" onClick={()=>{close();onAll();}}>Open all runs <ArrowUpRight size={14}/></button>
    </section>}
  </div>;
}
