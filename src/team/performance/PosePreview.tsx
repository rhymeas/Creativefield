import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {Button,Checkbox,Dialog,InfoButton,Notice,PoseOverlay,PoseStrip,ShimmerText,StatusText,Toolbar} from "../../ds";
import {poseFrameAt,type PosePreviewFrame} from "../../capabilities/pose-preview";
import {assetUrl,workspacePath,type Call} from "../api";
import {PosePreviewClient,poseRequestKey,poseTerminal,type PoseBinding,type PoseStatus} from "./pose-preview";

const labels:Record<string,string>={pending:"Preparing clip",preparing:"Preparing clip",prepared:"Preparing clip",queued:"Detecting poses",cancel_requested:"Canceling preview",succeeded:"Ready",canceled:"Canceled"};
export function PosePreview({binding,call,disabled=false}:{binding:PoseBinding;call:Call;disabled?:boolean}){
  const key=poseRequestKey(binding),[open,setOpen]=useState(false),[availability,setAvailability]=useState<{key:string;ready:boolean;available:boolean}>();
  const [preview,setPreview]=useState<{key:string;status:PoseStatus|null}>(),[seekTo,setSeekTo]=useState(0);
  const client=useMemo(()=>new PosePreviewClient(binding,call,localStorage),[key,call]);
  const onStatus=useCallback((status:PoseStatus|null)=>setPreview({key,status}),[key]);
  let saved=false;try{saved=!!localStorage.getItem(key);}catch{/* A deliberate start will explain storage failures. */}
  useEffect(()=>{
    const controller=new AbortController();
    void call<{state:string}>(workspacePath(binding.workspaceId,`pose-preview-requirements?workerId=${binding.workerId}`),"GET",undefined,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setAvailability({key,ready:value.state==="ready",available:true});}).catch(()=>{if(!controller.signal.aborted)setAvailability({key,ready:false,available:false});});
    return()=>controller.abort();
  },[key,call]);
  const available=availability?.key===key&&availability.available,ready=!!(availability?.key===key&&availability.ready);
  useEffect(()=>{
    if(open||!available||!saved)return;const controller=new AbortController();
    // A closed panel may read an existing result once, but never replays a POST
    // or polls in the background. Unknown intents recover only when opened.
    void client.refresh(controller.signal).then(onStatus).catch(()=>{if(!controller.signal.aborted)onStatus(null);});return()=>controller.abort();
  },[open,available,saved,client,onStatus]);
  // Missing models/backend are requirements, not dead buttons. Existing saved
  // requests can still be viewed or canceled when their worker goes offline.
  if(!available||!ready&&!saved)return null;
  const frames=preview?.key===key?preview.status?.frames??[]:[];
  return <><Button variant="secondary" disabled={disabled} onClick={()=>setOpen(true)}>Preview motion</Button>{!open&&frames.length>0&&<PoseStrip frames={frames} selected={frames[poseFrameAt(frames,seekTo)]?.frameIndex??0} onSelect={frame=>{setSeekTo(frame.seconds);setOpen(true);}}/>}{open&&<PosePreviewDialog key={key} client={client} ready={ready} disabled={disabled} initialSeconds={seekTo} onStatus={onStatus} onClose={()=>setOpen(false)}/>}</>;
}

function PosePreviewDialog({client,ready,disabled,initialSeconds,onStatus,onClose}:{client:PosePreviewClient;ready:boolean;disabled:boolean;initialSeconds:number;onStatus:(status:PoseStatus|null)=>void;onClose:()=>void}){
  const [status,setStatus]=useState<PoseStatus|null>(null),[busy,setBusy]=useState(false),[problem,setProblem]=useState(""),[seconds,setSeconds]=useState(0),[visible,setVisible]=useState(()=>document.visibilityState!=="hidden"),[overlay,setOverlay]=useState(false);
  const video=useRef<HTMLVideoElement>(null),pendingSeek=useRef<number|null>(initialSeconds),epoch=useRef(0),active=useRef<AbortController>();
  const perform=useCallback(async(task:(signal:AbortSignal)=>Promise<PoseStatus|null>)=>{
    const current=++epoch.current;active.current?.abort();const controller=new AbortController();active.current=controller;setBusy(true);setProblem("");
    try{const next=await task(controller.signal);if(epoch.current===current&&!controller.signal.aborted){setStatus(next);onStatus(next);}}
    catch(error){if(epoch.current===current&&!controller.signal.aborted){setStatus(null);onStatus(null);setProblem((error as Error).message||"The preview could not be loaded.");}}
    finally{if(epoch.current===current){setBusy(false);active.current=undefined;}}
  },[onStatus]);
  useEffect(()=>{void perform(signal=>client.recover(signal));return()=>{epoch.current++;active.current?.abort();};},[client,perform]);
  useEffect(()=>{
    const node=video.current;if(!node)return;const src=assetUrl(client.binding.workspaceId,client.binding.sourceAssetId);if(node.getAttribute("src")!==src)node.src=src;
    return()=>{node.pause();node.removeAttribute("src");node.load();};
  },[client]);
  useEffect(()=>{const change=()=>setVisible(document.visibilityState!=="hidden");document.addEventListener("visibilitychange",change);return()=>document.removeEventListener("visibilitychange",change);},[]);
  useEffect(()=>{
    if(!visible||busy||problem||!status||poseTerminal(status.state))return;
    const timer=setTimeout(()=>void perform(signal=>client.refresh(signal)),2000);return()=>clearTimeout(timer);
  },[visible,busy,problem,status,client,perform]);
  const frames=status?.frames??[],selected=frames[poseFrameAt(frames,seconds)]?.frameIndex??0;
  function seek(frame:PosePreviewFrame){
    setSeconds(frame.seconds);pendingSeek.current=frame.seconds;const node=video.current;if(!node)return;node.pause();
    if(node.readyState>=1){try{node.currentTime=frame.seconds;pendingSeek.current=null;}catch{setProblem("The driving clip could not seek to this sample.");}}
  }
  let saved=false;try{saved=client.hasRequest();}catch{/* Recovery reports the actionable error. */}
  const running=!!status&&!poseTerminal(status.state);
  return <Dialog open title="Motion preview" onClose={onClose} footer={<Toolbar>
    {problem?<Button variant="secondary" disabled={busy||disabled} onClick={()=>void perform(signal=>client.recover(signal))}>Retry preview</Button>:!running&&ready&&<Button variant="primary" disabled={busy||disabled} onClick={()=>void perform(signal=>client.start(signal))}>{status?.state==="succeeded"?"New preview":"Detect poses"}</Button>}
    {saved&&(!status||running)&&<Button variant="secondary" disabled={busy||disabled||status?.state==="cancel_requested"} onClick={()=>void perform(signal=>client.cancel(signal))}>Cancel preview</Button>}
    <Button variant="ghost" onClick={onClose}>Close</Button>
  </Toolbar>}>
    <div className="cf-form">
      <Toolbar end={<InfoButton title="Motion preview">Check that the body and hands stay in view before generating. Select a detected pose to seek to that moment in your clip. These are measured samples; they do not guarantee that the generated character follows every movement. Closing this preview leaves its job running.</InfoButton>}>
        {frames.length>0&&<Checkbox checked={overlay} onChange={setOverlay}>Overlay pose</Checkbox>}
        {!problem&&(busy||running)?<ShimmerText>{busy&&!status?"Checking preview":labels[status?.state??""]??"Updating preview"}</ShimmerText>:!problem&&status&&status.state!=="failed"?<StatusText tone={status.state==="succeeded"?"ok":"idle"}>{labels[status.state]}</StatusText>:null}
      </Toolbar>
      <div className="cf-pose-compare">
        <video ref={video} className="cf-performance-canvas" src={assetUrl(client.binding.workspaceId,client.binding.sourceAssetId)} controls muted playsInline preload="metadata" aria-label="Driving clip preview" onTimeUpdate={event=>setSeconds(event.currentTarget.currentTime)} onLoadedMetadata={event=>{if(pendingSeek.current!==null){event.currentTarget.currentTime=pendingSeek.current;pendingSeek.current=null;}}} onError={()=>setProblem("The saved driving clip could not be opened.")}/>
        {overlay&&frames[poseFrameAt(frames,seconds)]&&<PoseOverlay frame={frames[poseFrameAt(frames,seconds)]}/>}
      </div>
      {status?.frames.length?<PoseStrip frames={status.frames} selected={selected} onSelect={seek}/>:null}
      {(problem||status?.state==="failed")&&<Notice inline title="Pose preview unavailable" details={problem||status?.error||undefined}>Your clip is unchanged. Retry preview below uses the same request, so no second job is queued.<InfoButton title="Preview details">{problem||status?.error||"Pose detection did not finish."}</InfoButton></Notice>}
    </div>
  </Dialog>;
}
