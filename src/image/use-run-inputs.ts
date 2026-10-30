import {useEffect,useState} from "react";
import {request,workspacePath,type Run} from "../team/api";

export type RunInvocation={inputs?:Record<string,string>;presetId?:string};

/** The runs list leaves out what each run was given; fetch it for the few recent runs a view compares, once per run. */
export function useRunInputs(workspaceId:string,runs:Run[],limit=8):Record<string,RunInvocation>{
  const [known,setKnown]=useState<Record<string,RunInvocation>>({});
  const wanted=runs.filter(run=>run.state==="succeeded").slice(0,limit),key=wanted.map(run=>run.id).join();
  useEffect(()=>{
    const missing=wanted.filter(run=>!(run.id in known));
    if(!missing.length)return;
    let live=true;
    void Promise.all(missing.map(run=>request<{invocation?:RunInvocation}>(workspacePath(workspaceId,`runs/${encodeURIComponent(run.id)}`))
      .then(full=>[run.id,full.invocation??{}] as const)
      .catch(()=>[run.id,{}] as const)))
      .then(entries=>{if(live)setKnown(old=>({...old,...Object.fromEntries(entries)}));});
    return()=>{live=false;};
  },[workspaceId,key]);
  return known;
}
