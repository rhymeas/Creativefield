import {useEffect,useRef,useState} from "react";
import {Button,Dialog,Meta,Notice,TrimTimeline} from "../ds";
import {assetUrl,workspacePath,type Asset,type Call,type Project,type Workspace} from "./api";
import {planRequest,videoEditActive,type VideoEditJob,type VideoEditPlan} from "./video-edit/state";
import {constrainTrimRange} from "./trim-range";

/** Cuts a clip to its first `maxFrames` frames without asking: a clip that is too long is used, not refused.
 *  Returns the cut clip and its length in seconds. */
export async function trimToFirst(call:Call,workspaceId:string,projectId:string,assetId:string,maxFrames:number):Promise<{id:string;seconds:number}>{
  const ready=await call<Asset>(workspacePath(workspaceId,"video-sources/prepare"),"POST",{projectId,assetId});
  const plan=await call<VideoEditPlan>(workspacePath(workspaceId,"video-extension-plans"),"POST",planRequest(projectId,ready.id,0,1));
  const end=Math.min(plan.source.frameCount,maxFrames),fps=plan.source.frameRate.numerator/plan.source.frameRate.denominator;
  const legacyKey=`first-${ready.id}-${end}`;
  // Finish a previously submitted legacy cut rather than creating a duplicate
  // while its result is still uncertain. New cuts preserve the source frames.
  const previous=await call<VideoEditJob[]>(workspacePath(workspaceId,`video-extensions?projectId=${encodeURIComponent(projectId)}&requestKey=${encodeURIComponent(legacyKey)}`));
  let job=previous.find(item=>videoEditActive(item.state))??await call<VideoEditJob>(workspacePath(workspaceId,"video-extensions"),"POST",{...planRequest(projectId,ready.id,0,end,plan.source.hasAudio?"preserve":"mute"),preserveFrameRate:true,idempotencyKey:`first-fps-${ready.id}-${end}`,controls:{}});
  while(videoEditActive(job.state)){await new Promise(r=>setTimeout(r,1000));job=await call<VideoEditJob>(workspacePath(workspaceId,`video-extensions/${job.id}`));}
  if(job.state!=="succeeded"||!job.output_asset_id)throw new Error(job.error??"The clip could not be cut.");
  return {id:job.output_asset_id,seconds:end/fps};
}

/** A clip that is too long is cut to the part you want, not refused: the same frame-exact trim as the Trim screen,
 *  limited to `maxFrames`. When it is done the cut clip comes back as a project video. */
export function TrimToFit({workspace,project,call,assetId,maxFrames,maxSeconds,minSeconds,open,onClose,onTrimmed}:{workspace:Workspace;project:Project;call:Call;assetId:string;maxFrames?:number;maxSeconds?:number;minSeconds?:number;open:boolean;onClose:()=>void;onTrimmed:(assetId:string)=>void}){
  const [plan,setPlan]=useState<VideoEditPlan|null>(null),[range,setRange]=useState<[number,number]>([0,0]),[busy,setBusy]=useState(false),[error,setError]=useState(""),[source,setSource]=useState(assetId);
  const session=useRef(0);
  useEffect(()=>{
    if(!open)return;let live=true;session.current++;setPlan(null);setError("");setBusy(false);
    // Phone and screen recordings have an uneven frame rate: the server first makes the clip ready, then it is measured.
    void (async()=>{
      const ready=await call<Asset>(workspacePath(workspace.id,"video-sources/prepare"),"POST",{projectId:project.id,assetId});
      const next=await call<VideoEditPlan>(workspacePath(workspace.id,"video-extension-plans"),"POST",planRequest(project.id,ready.id,0,1));
      const limit=maxSeconds?Math.floor(maxSeconds*next.source.frameRate.numerator/next.source.frameRate.denominator):maxFrames??next.source.frameCount;
      if(live){setSource(ready.id);setPlan(next);setRange([0,Math.min(next.source.frameCount,limit)]);}
    })().catch(e=>{if(live)setError((e as Error).message);});
    return()=>{live=false;session.current++;};
  },[open,call,workspace.id,project.id,assetId,maxFrames,maxSeconds]);
  // Moving one handle never lets the part grow past what the tool takes: the other handle follows.
  const limit=plan?(maxSeconds?Math.floor(maxSeconds*plan.source.frameRate.numerator/plan.source.frameRate.denominator):maxFrames??plan.source.frameCount):maxFrames??0;
  const minimum=plan&&minSeconds?Math.ceil(minSeconds*plan.source.frameRate.numerator/plan.source.frameRate.denominator):1;
  const move=(start:number,end:number)=>setRange(constrainTrimRange(start,end,range[0],plan?.source.frameCount??end,minimum,limit));
  async function cut(){
    if(!plan||busy)return;const current=session.current;setBusy(true);setError("");
    try{
      const legacy=planRequest(project.id,source,range[0],range[1],plan.source.hasAudio?"preserve":"mute");
      const legacyStorageKey=`quick-trim:${JSON.stringify({workspace:workspace.id,request:legacy})}`;
      // A previous version may have submitted this cut before losing the reply.
      // Retry that exact request rather than making a second, different job.
      let request:typeof legacy&{preserveFrameRate?:boolean};
      try{request=sessionStorage.getItem(legacyStorageKey)?legacy:{...legacy,preserveFrameRate:true};}
      catch{throw new Error("Request tracking is unavailable; no cut was submitted.");}
      const storageKey=`quick-trim:${JSON.stringify({workspace:workspace.id,request})}`;
      let key:string;
      try{key=sessionStorage.getItem(storageKey)??crypto.randomUUID();sessionStorage.setItem(storageKey,key);}
      catch{throw new Error("Request tracking is unavailable; no cut was submitted.");}
      let job=await call<VideoEditJob>(workspacePath(workspace.id,"video-extensions"),"POST",{...request,idempotencyKey:key,controls:{}});
      while(session.current===current&&videoEditActive(job.state)){await new Promise(r=>setTimeout(r,1000));if(session.current!==current)return;job=await call<VideoEditJob>(workspacePath(workspace.id,`video-extensions/${job.id}`));}
      if(session.current!==current)return;
      if(job.state!=="succeeded"||!job.output_asset_id){try{sessionStorage.removeItem(storageKey);}catch{}throw new Error(job.error??"The clip could not be cut.");}
      try{sessionStorage.removeItem(storageKey);}catch{}
      onTrimmed(job.output_asset_id);onClose();
    }catch(e){if(session.current===current)setError((e as Error).message);}finally{if(session.current===current)setBusy(false);}
  }
  const frames=range[1]-range[0],fps=plan?plan.source.frameRate.numerator/plan.source.frameRate.denominator:16,seconds=(frames/fps).toFixed(1);
  return <Dialog wide open={open} title="Trim video" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!plan||busy||frames<minimum} onClick={()=>void cut()}>{busy?"Cutting…":"Use this part"}</Button></>}>
    <div className="cf-form">
      {plan&&<TrimTimeline src={assetUrl(workspace.id,source)} frames={plan.source.frameCount} start={range[0]} end={range[1]} onChange={move}/>}
      {plan&&<Meta parts={[`Included ${(range[0]/fps).toFixed(1)}–${(range[1]/fps).toFixed(1)} s`,`Length ${seconds} s`,`up to ${(limit/fps).toFixed(1)} s`]}/>}
      {plan&&frames<minimum&&<Meta>{`Choose a clip at least ${minSeconds} seconds long.`}</Meta>}
      {/* The cut button in the dialog footer is this problem's action, so it is not repeated here. */}
      {error&&<Notice inline title="The clip wasn't trimmed" details={error}>The picked range is still here. Try again to check the same cut request.</Notice>}
    </div>
  </Dialog>;
}
