import {useEffect,useState} from "react";
import {Button,Dialog,Meta,Notice,TrimTimeline} from "../ds";
import {assetUrl,workspacePath,type Asset,type Call,type Project,type Workspace} from "./api";
import {planRequest,videoEditActive,type VideoEditJob,type VideoEditPlan} from "./video-edit/state";

/** Cuts a clip to its first `maxFrames` frames without asking: a clip that is too long is used, not refused.
 *  Returns the cut clip and its length in seconds. */
export async function trimToFirst(call:Call,workspaceId:string,projectId:string,assetId:string,maxFrames:number):Promise<{id:string;seconds:number}>{
  const ready=await call<Asset>(workspacePath(workspaceId,"video-sources/prepare"),"POST",{projectId,assetId});
  const plan=await call<VideoEditPlan>(workspacePath(workspaceId,"video-extension-plans"),"POST",planRequest(projectId,ready.id,0,1));
  const end=Math.min(plan.source.frameCount,maxFrames),fps=plan.source.frameRate.numerator/plan.source.frameRate.denominator;
  let job=await call<VideoEditJob>(workspacePath(workspaceId,"video-extensions"),"POST",{...planRequest(projectId,ready.id,0,end,plan.source.hasAudio?"preserve":"mute"),idempotencyKey:`first-${ready.id}-${end}`,controls:{}});
  while(videoEditActive(job.state)){await new Promise(r=>setTimeout(r,1000));job=await call<VideoEditJob>(workspacePath(workspaceId,`video-extensions/${job.id}`));}
  if(job.state!=="succeeded"||!job.output_asset_id)throw new Error(job.error??"The clip could not be cut.");
  return {id:job.output_asset_id,seconds:end/fps};
}

/** A clip that is too long is cut to the part you want, not refused: the same frame-exact trim as the Trim screen,
 *  limited to `maxFrames`. When it is done the cut clip comes back as a project video. */
export function TrimToFit({workspace,project,call,assetId,maxFrames,open,onClose,onTrimmed}:{workspace:Workspace;project:Project;call:Call;assetId:string;maxFrames:number;open:boolean;onClose:()=>void;onTrimmed:(assetId:string)=>void}){
  const [plan,setPlan]=useState<VideoEditPlan|null>(null),[range,setRange]=useState<[number,number]>([0,0]),[busy,setBusy]=useState(false),[error,setError]=useState(""),[source,setSource]=useState(assetId);
  useEffect(()=>{
    if(!open)return;let live=true;setPlan(null);setError("");
    // Phone and screen recordings have an uneven frame rate: the server first makes the clip ready, then it is measured.
    void (async()=>{
      const ready=await call<Asset>(workspacePath(workspace.id,"video-sources/prepare"),"POST",{projectId:project.id,assetId});
      const next=await call<VideoEditPlan>(workspacePath(workspace.id,"video-extension-plans"),"POST",planRequest(project.id,ready.id,0,1));
      if(live){setSource(ready.id);setPlan(next);setRange([0,Math.min(next.source.frameCount,maxFrames)]);}
    })().catch(e=>{if(live)setError((e as Error).message);});
    return()=>{live=false;};
  },[open,call,workspace.id,project.id,assetId,maxFrames]);
  // Moving one handle never lets the part grow past what the tool takes: the other handle follows.
  const move=(start:number,end:number)=>{const total=plan?.source.frameCount??end;
    if(end-start>maxFrames)(start!==range[0])?end=start+maxFrames:start=end-maxFrames;
    setRange([Math.max(0,start),Math.min(total,end)]);};
  async function cut(){
    if(!plan||busy)return;setBusy(true);setError("");
    try{
      let job=await call<VideoEditJob>(workspacePath(workspace.id,"video-extensions"),"POST",{...planRequest(project.id,source,range[0],range[1],plan.source.hasAudio?"preserve":"mute"),idempotencyKey:crypto.randomUUID(),controls:{}});
      while(videoEditActive(job.state)){await new Promise(r=>setTimeout(r,1000));job=await call<VideoEditJob>(workspacePath(workspace.id,`video-extensions/${job.id}`));}
      if(job.state!=="succeeded"||!job.output_asset_id)throw new Error(job.error??"The clip could not be cut.");
      onTrimmed(job.output_asset_id);onClose();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const frames=range[1]-range[0],fps=plan?plan.source.frameRate.numerator/plan.source.frameRate.denominator:16,seconds=(frames/fps).toFixed(1);
  return <Dialog open={open} title="Trim your clip" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!plan||busy||frames<1} onClick={()=>void cut()}>{busy?"Cutting…":"Use this part"}</Button></>}>
    <div className="cf-form">
      {plan&&<TrimTimeline src={assetUrl(workspace.id,source)} frames={plan.source.frameCount} start={range[0]} end={range[1]} onChange={move}/>}
      {plan&&<Meta parts={[`${seconds} s`,`up to ${(maxFrames/fps).toFixed(1)} s`]}/>}
      {/* The cut button in the dialog footer is this problem's action, so it is not repeated here. */}
      {error&&<Notice inline title="The clip wasn't trimmed" details={error}>Nothing was changed and the picked range is still here, so Use this part can be tried again.</Notice>}
    </div>
  </Dialog>;
}
