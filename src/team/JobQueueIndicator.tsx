import {useEffect,useRef,useState} from "react";
import {JobQueueMenu} from "../ds";
import {type Call,type Workspace} from "./api";
import {runLabel} from "./state";
import {emptyJobQueue,monitorJobQueue,jobQueueTitle,type JobQueueSnapshot,type JobQueueRun} from "./job-queue";

/** "started 3 min ago", short and calm. */
function since(iso:string){
  const minutes=Math.max(0,Math.round((Date.now()-new Date(iso).getTime())/60000));
  return minutes<1?"just started":minutes<60?`${minutes} min`:minutes<1440?`${Math.round(minutes/60)} h`:`${Math.round(minutes/1440)} d`;
}
const preparationState=(state:string)=>state==="pending"||state==="preparing"?"Preparing":state==="cancel_requested"?"Cancelling":"Queued";
const preparationTitle=(state:string)=>state==="pending"||state==="preparing"?"Preparing pose preview":"Pose preview queued";

export function JobQueueIndicator({workspace,call,authorized,titles,onOpenRun,version=0}:{workspace:Workspace;call:Call;authorized:boolean;titles:Record<string,string>;onOpenRun:(run:JobQueueRun)=>void;version?:number}){
  const [snapshot,setSnapshot]=useState<{workspace:string;data:JobQueueSnapshot}>();
  const monitor=useRef<ReturnType<typeof monitorJobQueue>>();
  useEffect(()=>{
    if(!authorized)return;
    const next=monitorJobQueue(workspace.id,data=>setSnapshot({workspace:workspace.id,data}));
    monitor.current=next;
    const visibility=()=>next.setVisible(document.visibilityState!=="hidden");
    const focus=()=>{if(document.visibilityState!=="hidden")void next.refresh();};
    document.addEventListener("visibilitychange",visibility);window.addEventListener("focus",focus);
    visibility();
    return()=>{next.dispose();monitor.current=undefined;document.removeEventListener("visibilitychange",visibility);window.removeEventListener("focus",focus);};
  },[workspace.id,authorized,call]);
  useEffect(()=>{void monitor.current?.refresh();},[version]);
  const state=authorized&&snapshot?.workspace===workspace.id?snapshot.data:emptyJobQueue;
  const newest=[...state.runs].sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,8);
  const preparations=[...state.preparations].sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,4);
  const items=[
    ...newest.map(run=>({id:run.id,title:jobQueueTitle(run.capability_id,titles),status:[runLabel[run.state]??"Working",run.take?`Take ${run.take}`:null,since(run.created_at)].filter(Boolean).join(" · "),detail:run.subject?`“${run.subject}”`:undefined,progress:state.progress[run.id]})),
    ...preparations.map(preparation=>({id:`pose-${preparation.id}`,title:preparationTitle(preparation.state),status:`${preparationState(preparation.state)} · ${since(preparation.created_at)}`,detail:preparation.source_name?`from ${preparation.source_name}`:undefined,selectable:false})),
  ];
  return <JobQueueMenu total={state.total} items={items} loading={state.loading} error={state.error} onRefresh={()=>void monitor.current?.refresh()} onSelect={id=>{const run=state.runs.find(item=>item.id===id);if(run)onOpenRun(run);}} onAll={()=>{location.hash="library/runs";}}/>;
}
