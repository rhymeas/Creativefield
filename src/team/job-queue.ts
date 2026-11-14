import {z} from "zod";
import type {Run} from "./api";
import {activeRun} from "./state";

export type JobQueueRun=Pick<Run,"id"|"project_id"|"capability_id"|"state"|"created_at"|"updated_at">&{take?:number|null;subject?:string|null};
export type JobQueuePreparation={id:string;project_id:string;state:string;created_at:string;updated_at:string;source_name?:string|null};
export type JobQueueSnapshot={runs:JobQueueRun[];preparations:JobQueuePreparation[];total:number;progress:Record<string,number>;loading:boolean;error:boolean};
export const emptyJobQueue:JobQueueSnapshot={runs:[],preparations:[],total:0,progress:{},loading:false,error:false};
export function jobQueueTitle(capabilityId:string,titles:Record<string,string>){return titles[capabilityId]??(capabilityId==="chatgpt-image-edit"?"ChatGPT image edit":undefined)??(/^sdpose-preview-[1-6]$/.test(capabilityId)?"Detect driving pose":"Creative job");}
/** Where a run really went, in plain words, for run details. */
export function runLocation(transport:string|undefined|null,cloud:boolean){return transport==="chatgpt"?"ChatGPT":cloud?"Comfy Cloud":transport==="sdk"?"SDK proxy":"Local ComfyUI";}
const snapshotSchema=z.object({
  runs:z.array(z.object({id:z.uuid(),project_id:z.uuid(),capability_id:z.string(),state:z.string().refine(activeRun),created_at:z.string(),updated_at:z.string(),take:z.number().int().nullable().optional(),subject:z.string().max(120).nullable().optional()}).strict()).max(8),
  preparations:z.array(z.object({id:z.uuid(),project_id:z.uuid(),state:z.string(),created_at:z.string(),updated_at:z.string(),source_name:z.string().max(120).nullable().optional()}).strict()).max(8).default([]),
  total:z.number().int().nonnegative(),progress:z.record(z.string(),z.number().finite().min(0).max(1)),
}).strict().refine(value=>value.total>=value.runs.length+value.preparations.length);
export type JobFeedSource=Pick<EventTarget,"addEventListener">&{close:()=>void};

/** One authenticated same-origin SSE connection; browser-native retry is disabled. */
export function monitorJobQueue(workspaceId:string,publish:(next:JobQueueSnapshot)=>void,createSource:(url:string)=>JobFeedSource=url=>new EventSource(url)){
  let state=emptyJobQueue,visible=true,disposed=false,source:JobFeedSource|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined,retries=0;
  const clearTimer=()=>{if(timer)clearTimeout(timer);timer=undefined;};
  const send=(patch:Partial<JobQueueSnapshot>)=>{if(!disposed){state={...state,...patch};publish(state);}};
  const disconnect=()=>{clearTimer();const previous=source;source=undefined;previous?.close();};
  const connect=()=>{
    if(disposed||!visible||source)return;
    let current:JobFeedSource;
    try{current=createSource(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/jobs/stream`);}
    catch{send({loading:false,error:true});return;}
    const startedAt=Date.now();
    source=current;send({loading:!state.runs.length,error:false});
    const valid=()=>!disposed&&visible&&source===current;
    const failed=()=>{
      if(!valid())return;
      source=undefined;current.close();
      if(Date.now()-startedAt>=10000)retries=0;
      if(retries<2){const delay=retries++===0?1000:5000;timer=setTimeout(()=>{timer=undefined;connect();},delay);}
      else send({loading:false,error:true});
    };
    current.addEventListener("jobs",event=>{
      if(!valid())return;
      try{
        const next=snapshotSchema.parse(JSON.parse((event as MessageEvent).data));
        if(Object.keys(next.progress).some(id=>!next.runs.some(run=>run.id===id)))throw new Error("Unknown progress record");
        send({...next,loading:false,error:false});
      }catch{failed();}
    });
    current.addEventListener("access-denied",()=>{if(valid()){disconnect();send({...emptyJobQueue,error:true});}});
    current.addEventListener("unavailable",failed);
    current.addEventListener("error",failed);
  };
  return {
    refresh(){if(!source){clearTimer();retries=0;connect();}},
    setVisible(next:boolean){visible=next;if(next){if(!source)retries=0;connect();}else{disconnect();send({loading:false});}},
    dispose(){disposed=true;disconnect();},
  };
}
/** Workflow names for the run lists and the job queue, by workflow id: the title without its bracketed detail. */
export const catalogueTitles=(catalogue:ReadonlyArray<{id:string;title:string}>):Record<string,string>=>Object.fromEntries(catalogue.map(m=>[m.id,m.title.split(" (")[0]]));
