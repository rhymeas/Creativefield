import {useEffect,useRef,useState} from "react";
import {Button,Dialog,FrameStrip,GenerateButton,Meta,Notice,PanelSection,ResultGrid,ResultTile} from "../ds";
import {assetUrl,workspacePath,type Call} from "./api";
import type {SceneAnchorReview,SceneAnchorVariant} from "../capabilities/scene-anchor";
import {sceneAnchorKey} from "./scene-anchor-state";
import {TeamChoice} from "./TeamChoice";

type Saved={context:string;requestKey:string;runId?:string;variant?:SceneAnchorVariant;history?:Partial<Record<SceneAnchorVariant,{runId:string;requestKey:string}>>};
export function ReplaceSceneFrame({workspace,project,worker,video,references,prompt,disabled,call,onChanged,onBusy,onUse}:{workspace:string;project:string;worker:string;video:string;references:string[];prompt:string;disabled:boolean;call:Call;onChanged:()=>void;onBusy:(busy:boolean)=>void;onUse?:(assetId:string)=>void}){
  const context=JSON.stringify({video,references,prompt,worker}),key=sceneAnchorKey(workspace,project);
  const saved=useRef<Saved|null>(null);
  if(!saved.current){try{const s=JSON.parse(sessionStorage.getItem(key)??"null");saved.current=s?.context===context?s:{context,variant:"flux",requestKey:crypto.randomUUID()};}catch{saved.current={context,variant:"flux",requestKey:crypto.randomUUID()};}}
  const [variant,setVariant]=useState<SceneAnchorVariant>(()=>saved.current?.variant==="flux"?"flux":"qwen");
  const [review,setReview]=useState<SceneAnchorReview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[open,setOpen]=useState(false);
  const alive=useRef(true),abort=useRef<AbortController|null>(null);
  const persist=()=>{try{sessionStorage.setItem(key,JSON.stringify(saved.current));}catch{/* Server receipts remain authoritative. */}};
  const read=(run:string)=>call<SceneAnchorReview>(workspacePath(workspace,`replace-anchors/${run}`),"GET",undefined,{signal:abort.current?.signal});
  async function finish(initial:SceneAnchorReview){
    let current=initial;
    while(alive.current&&current.state==="working"){
      await new Promise(resolve=>setTimeout(resolve,1500));
      if(!alive.current)return;
      current=await read(initial.runId);
    }
    if(alive.current){setReview(current);onChanged();}
  }
  useEffect(()=>{
    alive.current=true;abort.current=new AbortController();
    if(saved.current?.runId){setBusy(true);onBusy(true);void read(saved.current.runId).then(finish).catch(e=>{if(alive.current)setError((e as Error).message);}).finally(()=>{if(alive.current){setBusy(false);onBusy(false);}});}
    return()=>{alive.current=false;abort.current?.abort();onBusy(false);};
  },[context,workspace,project,call,variant]);
  async function generate(){
    if(busy||disabled)return;setBusy(true);onBusy(true);setError("");
    try{
      if(review?.state==="rejected"||review?.state==="failed"||review?.state==="ready"||review?.state==="approved")saved.current={context,variant,requestKey:crypto.randomUUID(),history:saved.current?.history};
      persist();
      const result=await call<SceneAnchorReview>(workspacePath(workspace,"replace-anchors"),"POST",{projectId:project,workerId:worker,videoAssetId:video,referenceIds:references,variant,frameIndex:0,prompt,requestKey:saved.current!.requestKey},{timeoutMs:120000});
      saved.current!.runId=result.runId;persist();if(alive.current)setReview(result);onChanged();await finish(result);
    }catch(e){if(alive.current)setError((e as Error).message);}
    finally{if(alive.current){setBusy(false);onBusy(false);}}
  }
  return <PanelSection label="Scene frame">
    <TeamChoice label="Frame model" display={variant==="flux"?"Flux 2 Klein · experiment":"Qwen Image 2.1"} value={variant} disabled={busy||disabled} options={[{value:"qwen",label:"Qwen Image 2.1"},{value:"flux",label:"Flux 2 Klein · experiment"}]} onChange={value=>{const next=value as SceneAnchorVariant,previous=saved.current,history={...previous?.history};if(previous?.runId)history[variant]={runId:previous.runId,requestKey:previous.requestKey};const receipt=history[next];saved.current={context,variant:next,requestKey:receipt?.requestKey??crypto.randomUUID(),runId:receipt?.runId,history};persist();setReview(null);setError("");setVariant(next);}}/>
    {!review?.candidateId&&<Meta>Optional reference experiment. It does not require approval or replace the video-frame test.</Meta>}
    {review?.candidateId&&<FrameStrip label="Review scene frame" items={[{src:assetUrl(workspace,review.sourceFrameId),label:"Source frame"},{src:assetUrl(workspace,review.candidateId),label:"Candidate scene frame"}]}/>}
    {review?.candidateId&&<><Button variant="secondary" onClick={()=>setOpen(true)}>Review full frame</Button><Dialog wide open={open} title="Scene frame review" onClose={()=>setOpen(false)} footer={<Button variant="ghost" onClick={()=>setOpen(false)}>Close</Button>}><ResultGrid count={2} aspect={0} label="Source and candidate"><ResultTile caption="Source frame"><img src={assetUrl(workspace,review.sourceFrameId)} alt="Source frame"/></ResultTile><ResultTile caption="Candidate scene frame"><img src={assetUrl(workspace,review.candidateId)} alt="Candidate scene frame"/></ResultTile></ResultGrid></Dialog></>}
    {review?.candidateId&&onUse&&<Button variant="secondary" disabled={busy||disabled} onClick={()=>onUse(review.candidateId!)}>Use for video</Button>}
    {(error||review?.error)&&<Notice priority={1} title="The scene frame didn't finish" actions={<Button variant="secondary" disabled={busy||disabled} onClick={()=>void generate()}>Try again</Button>} details={error||review?.error||undefined}>Your clip is unchanged. Trying again reuses the same reference picture and request.</Notice>}
    <GenerateButton label={busy?"Creating frame…":"Generate"} busy={busy} disabled={busy||disabled} onClick={()=>void generate()}/>
  </PanelSection>;
}
