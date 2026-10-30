import {useEffect,useRef,useState} from "react";
import {Button,Dialog,FrameStrip,GenerateButton,Meta,Notice,PanelSection,ResultGrid,ResultTile} from "../ds";
import {assetUrl,workspacePath,type Call,type Run} from "./api";
import {activeRun} from "./state";
import {videoProbeKey,videoProbeContext} from "./scene-anchor-state";
import {REPLACE_VIDEO_PROBE_ID,SINGLE_VIDEO_PROBE_ID,SCENE_VIDEO_PROBE_ID,SCENE_VIDEO_PROBE_VERSION,REPLACE_VIDEO_PROBE_VERSION,VIDEO_PROBE_FRAMES,VIDEO_PROBE_INDICES} from "../capabilities/replace-video-probe";

type Saved={context:string;requestKey:string;runId?:string;sourceId?:string;sourceVersion?:1};
export function ReplaceVideoFrames({workspace,project,worker,video,references,prompt,personIndex=0,sceneImageId,disabled,call,onChanged,onBusy}:{workspace:string;project:string;worker:string;video:string;references:string[];prompt:string;personIndex?:number;sceneImageId?:string;disabled:boolean;call:Call;onChanged:()=>void;onBusy:(busy:boolean)=>void}){
  const single=references.length===1;
  const context=videoProbeContext({video,references,prompt,worker,personIndex,sceneImageId}),key=videoProbeKey(workspace,project),saved=useRef<Saved|null>(null);
  if(!saved.current){try{const s=JSON.parse(sessionStorage.getItem(key)??"null");saved.current=s?.context===context?s:{context,requestKey:crypto.randomUUID()};}catch{saved.current={context,requestKey:crypto.randomUUID()};}}
  const [run,setRun]=useState<Run|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[open,setOpen]=useState(false);
  const alive=useRef(true),controller=useRef<AbortController|null>(null);
  const persist=()=>{try{sessionStorage.setItem(key,JSON.stringify(saved.current));}catch{/* Server receipts remain authoritative. */}};
  useEffect(()=>{persist();},[context]);
  const read=(id:string)=>call<Run>(workspacePath(workspace,`runs/${id}`),"GET",undefined,{signal:controller.current?.signal});
  async function follow(initial:Run){
    let current=initial;if(alive.current)setRun(current);
    while(alive.current&&activeRun(current.state)){
      await new Promise(resolve=>setTimeout(resolve,1500));if(!alive.current)return;
      current=await read(initial.id);if(alive.current)setRun(current);
    }
    if(alive.current)onChanged();
  }
  useEffect(()=>{
    alive.current=true;controller.current=new AbortController();
    if(saved.current?.runId){setBusy(true);onBusy(true);void read(saved.current.runId).then(follow).catch(e=>{if(alive.current)setError((e as Error).message);}).finally(()=>{if(alive.current){setBusy(false);onBusy(false);}});}
    return()=>{alive.current=false;controller.current?.abort();onBusy(false);};
  },[context,workspace,project,call]);
  async function generate(){
    if(busy||disabled)return;setBusy(true);onBusy(true);setError("");
    try{
      if(run&&!activeRun(run.state))saved.current={context,requestKey:crypto.randomUUID()};persist();
      if(!saved.current!.sourceId||saved.current!.sourceVersion!==1){const cut=await call<{id:string}>(workspacePath(workspace,"video-frame-sources"),"POST",{projectId:project,assetId:video});saved.current!.sourceId=cut.id;saved.current!.sourceVersion=1;persist();}
      const assignment=single?`Only the person on the ${personIndex===1?"right":"left"} matches the supplied character reference. All other people keep their original source appearance and clothes.`:"The left person matches the first character reference, the right person matches the second.";
      const instruction=`The source scene, camera, positions and poses are preserved. ${assignment} Preserve the reference facial identity, hair, clothing and accessories. Clean photographic scene without social-media interface, captions, play icons or counters.`+(prompt.trim()?` ${prompt.trim()}`:"");
      const result=await call<Run>(workspacePath(workspace,"runs"),"POST",{projectId:project,workerId:worker,idempotencyKey:`video-probe:${saved.current!.requestKey}`,capabilityId:sceneImageId?SCENE_VIDEO_PROBE_ID:single?SINGLE_VIDEO_PROBE_ID:REPLACE_VIDEO_PROBE_ID,version:sceneImageId?SCENE_VIDEO_PROBE_VERSION:REPLACE_VIDEO_PROBE_VERSION,routeId:"local",inputs:sceneImageId?{source_video:saved.current!.sourceId,scene_image:sceneImageId}:{source_video:saved.current!.sourceId,character_image:references[0],...(!single?{character_image_2:references[1]}:{})},controls:{prompt:instruction,...(sceneImageId?{people:single?String(personIndex):"0,1",replacement_mode:false}:single?{person:String(personIndex)}:{})},audioPolicy:"mute"});
      saved.current!.runId=result.id;persist();onChanged();await follow(result);
    }catch(e){if(alive.current)setError((e as Error).message);}
    finally{if(alive.current){setBusy(false);onBusy(false);}}
  }
  const frames=(run?.output_ids??[]).slice(0,2).map((id,i)=>({src:assetUrl(workspace,id),label:`Video frame ${VIDEO_PROBE_INDICES[i]+1}`}));
  return <PanelSection label="Video frames">
    {sceneImageId&&<FrameStrip label="Video reference" items={[{src:assetUrl(workspace,sceneImageId),label:"Scene frame used for appearance"}]}/>}
    <Meta>SCAIL-2 generates a {VIDEO_PROBE_FRAMES}-frame test and shows two sampled video frames. No full video or upscale.</Meta>
    {busy&&<Meta>{!run?"Preparing the short test…":run.state==="pending"?"Waiting for the local worker…":run.state==="queued"?"Queued on the local worker…":run.state==="running"?"Generating video frames…":"Checking the frame test…"}</Meta>}
    {frames.length>0&&<><FrameStrip label="Generated video frames" items={frames}/><Button variant="secondary" onClick={()=>setOpen(true)}>View video frames</Button><Dialog wide open={open} title="Generated video frames" onClose={()=>setOpen(false)} footer={<Button variant="ghost" onClick={()=>setOpen(false)}>Close</Button>}><ResultGrid count={frames.length} aspect={0} label="Sampled video output">{frames.map(f=><ResultTile key={f.label} caption={f.label}><img src={f.src} alt={f.label}/></ResultTile>)}</ResultGrid></Dialog></>}
    {run?.state==="canceled"&&<Meta>Frame test stopped.</Meta>}
    {(error||run?.state==="failed")&&<Notice priority={1} title="The frame test didn't finish" actions={<Button variant="secondary" disabled={busy||disabled} onClick={()=>void generate()}>Try again</Button>} details={error||run?.error||undefined}>{run?.state==="failed"?"The short test stopped before it produced frames. Your clip is unchanged; trying again runs the same test.":"The short frame test did not start. Trying again reuses the same request."}</Notice>}
    <GenerateButton label="Generate" busy={busy} disabled={busy||disabled} onClick={()=>void generate()}/>
  </PanelSection>;
}
