import {useEffect,useRef,useState} from "react";
import {AngleSweepViewer,Button,ContactSheet,Dialog,InfoButton,Meta,Notice,ResultGrid,StatusText,Toolbar,type SweepFrame} from "../ds";
import {RunDevelop} from "../team/RunDevelop";
import {ApiError,assetUrl,workspacePath,type Asset,type Call,type Project,type Run,type Workspace} from "../team/api";
import {activeRun} from "../team/state";
import {freezeSweep,pendingDirections,recoverSweep,sweepFrameTimes,sweepOrder,sweepRunRequest,sweepStorageKey,SWEEP_DIRECTIONS,SWEEP_FRAMES_PER_SIDE,type Sweep,type SweepDirection} from "./angle-sweep";
import {readSweepFrames,type SweepStill} from "./sweep-frames";

type Stills=Partial<Record<SweepDirection,SweepStill[]>>;

export function AngleSweepPanel({workspace,project,userId,workerId,call,sourceAssetId,disabled,onChanged}:{workspace:Workspace;project:Project;userId:string;workerId:string;call:Call;sourceAssetId?:string;disabled?:boolean;onChanged:()=>void}){
  const scope={workspaceId:workspace.id,projectId:project.id,userId,workerId},storageKey=sweepStorageKey(scope),mounted=useRef(true),submitting=useRef(false);
  const [sweep,setSweep]=useState<Sweep|null>(()=>{try{return sourceAssetId?recoverSweep(JSON.parse(sessionStorage.getItem(storageKey)??"null"),scope,sourceAssetId):null;}catch{return null;}});
  const [runs,setRuns]=useState<Partial<Record<SweepDirection,Run>>>({}),[stills,setStills]=useState<Stills>({}),[index,setIndex]=useState(0),[busy,setBusy]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(""),[sheet,setSheet]=useState(false);
  const reading=useRef(new Set<SweepDirection>()),stillsRef=useRef<Stills>({});stillsRef.current=stills;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;for(const list of Object.values(stillsRef.current))for(const s of list??[])URL.revokeObjectURL(s.url);};},[]);
  // A different source image starts a fresh sweep; the saved one stays in storage until replaced.
  // A saved sweep for the chosen source comes back as soon as that source is chosen, also after a reload.
  useEffect(()=>{
    if(sweep&&sweep.sourceAssetId!==sourceAssetId){setSweep(null);setRuns({});setStills({});return;}
    if(!sweep&&sourceAssetId)try{const saved=recoverSweep(JSON.parse(sessionStorage.getItem(storageKey)??"null"),scope,sourceAssetId);if(saved)setSweep(saved);}catch{}
  },[sourceAssetId]);
  // Follow the submitted runs only while one of them is still working.
  useEffect(()=>{
    if(!sweep)return;let live=true;
    const load=async()=>{
      const next:Partial<Record<SweepDirection,Run>>={};
      await Promise.all(SWEEP_DIRECTIONS.map(async d=>{const id=sweep.runIds[d.id];if(id)try{next[d.id]=await call<Run>(workspacePath(workspace.id,`runs/${id}`));}catch{}}));
      if(live&&mounted.current){setRuns(old=>({...old,...next}));return Object.values(next).some(run=>activeRun(run.state));}
      return false;
    };
    let timer=0;const tick=async()=>{const again=await load();if(live&&again)timer=window.setTimeout(tick,2500);};void tick();
    return()=>{live=false;window.clearTimeout(timer);};
  },[sweep?.id,sweep?.runIds.left,sweep?.runIds.right]);
  // Turn each finished clip into stills once.
  useEffect(()=>{
    for(const d of SWEEP_DIRECTIONS){
      const run=runs[d.id],output=run?.state==="succeeded"?run.output_ids[0]:undefined;
      if(!output||stills[d.id]||reading.current.has(d.id))continue;
      reading.current.add(d.id);
      readSweepFrames(assetUrl(workspace.id,output),duration=>sweepFrameTimes(duration,SWEEP_FRAMES_PER_SIDE+1))
        .then(list=>{if(mounted.current)setStills(old=>({...old,[d.id]:list.slice(1)}));else list.forEach(s=>URL.revokeObjectURL(s.url));})
        .catch(e=>{if(mounted.current)setError((e as Error).message);})
        .finally(()=>reading.current.delete(d.id));
    }
  },[runs]);
  const persist=(next:Sweep)=>{sessionStorage.setItem(storageKey,JSON.stringify(next));setSweep(next);};
  async function queue(){
    if(submitting.current||disabled||!sourceAssetId)return;submitting.current=true;setBusy(true);setError("");
    let current=sweep;
    try{
      current=current??freezeSweep(sourceAssetId,scope);persist(current);
      for(const direction of pendingDirections(current)){
        if(!mounted.current)break;
        // The same keys are replayed after an unknown response, so an accepted run is never doubled.
        current={...current,pending:direction};persist(current);
        const run:Run=await call<Run>(workspacePath(workspace.id,"runs"),"POST",sweepRunRequest(current,direction));
        current={...current,pending:undefined,runIds:{...current.runIds,[direction]:run.id}};persist(current);
        if(mounted.current)setRuns(old=>({...old,[direction]:run}));onChanged();
      }
    }catch(e){if(mounted.current)setError(e instanceof ApiError&&e.status===0?"The team server did not answer. Try again; nothing was submitted twice.":(e as Error).message);}
    finally{submitting.current=false;if(mounted.current)setBusy(false);}
  }
  function reset(){try{sessionStorage.removeItem(storageKey);}catch{setError("The saved sweep could not be cleared. Check browser storage.");return;}setSweep(null);setRuns({});setStills(old=>{for(const list of Object.values(old))for(const s of list??[])URL.revokeObjectURL(s.url);return {};});setIndex(0);}
  const left=stills.left,right=stills.right,original=sourceAssetId?assetUrl(workspace.id,sourceAssetId):undefined;
  const frames:SweepFrame[]=original?sweepOrder((left??[]).map((s,i)=>({src:s.url,label:`Left ${i+1}`})),{src:original,label:"Original"},(right??[]).map((s,i)=>({src:s.url,label:`Right ${i+1}`}))):[];
  const originalIndex=left?.length??0,orderedStills=[...[...(left??[])].reverse(),undefined,...(right??[])];
  useEffect(()=>{setIndex(originalIndex);},[frames.length]);
  const working=busy||SWEEP_DIRECTIONS.some(d=>runs[d.id]&&activeRun(runs[d.id]!.state));
  const failed=SWEEP_DIRECTIONS.filter(d=>runs[d.id]&&["failed","canceled","cancelled"].includes(runs[d.id]!.state));
  async function save(i:number){
    const still=orderedStills[i];if(!still||!sourceAssetId||saving)return;setSaving(true);setError("");
    try{
      const form=new FormData(),name=frames[i].label?.toLowerCase().replace(/\s+/g,"-")??`view-${i+1}`;form.append("file",new File([still.blob],`angle-sweep-${name}.png`,{type:"image/png"}));
      await call<Asset>(workspacePath(workspace.id,`assets?projectId=${encodeURIComponent(project.id)}&kind=image&parentId=${encodeURIComponent(sourceAssetId)}`),"POST",form);onChanged();
    }catch(e){setError((e as Error).message);}finally{if(mounted.current)setSaving(false);}
  }
  const canStart=!disabled&&!!sourceAssetId&&!working&&!(sweep&&pendingDirections(sweep).length===0);
  const developing=SWEEP_DIRECTIONS.filter(d=>runs[d.id]&&activeRun(runs[d.id]!.state));
  const slate=(label?:string)=>{const run=label?.startsWith("Left")?runs.left:label?.startsWith("Right")?runs.right:undefined;return run?` · Take ${run.take}`:"";};
  return <div className="cf-form">
    <Toolbar>
      {canStart&&<Button variant="secondary" onClick={()=>void queue()}>{sweep&&pendingDirections(sweep).length?"Resume nearby views":"Create nearby views"}</Button>}
      {sweep&&!working&&<Button variant="ghost" onClick={reset}>New nearby views</Button>}
      {frames.length>1&&<Button variant="secondary" onClick={()=>setSheet(true)}>Contact sheet</Button>}
      <InfoButton title="Nearby views, not an orbit"><Meta>Two short lateral camera moves start from your image. Frames are read from the finished clips so you can scrub nearby views and save one as a still. This is an approximate sideways move with natural parallax, not a 45° orbit or true 3D rotation. The two views closest to the original are the most reliable; outer views can blur or leave the frame.</Meta></InfoButton>
      {sweep&&SWEEP_DIRECTIONS.map(d=><StatusText key={d.id} tone={runs[d.id]?.state==="succeeded"?"ok":failed.some(f=>f.id===d.id)?"warn":"active"}>{d.label} · {runs[d.id]?.state==="succeeded"?"ready":runs[d.id]?(failed.some(f=>f.id===d.id)?(/cancel/.test(runs[d.id]!.state)?"cancelled":"failed"):"working"):"waiting"}{runs[d.id]?` · Take ${runs[d.id]!.take}`:""}</StatusText>)}
    </Toolbar>
    {!sourceAssetId?<Meta>Choose a source image to create nearby views.</Meta>:disabled&&!sweep&&<Meta>The local worker is not ready yet.</Meta>}
    {developing.length>0&&<ResultGrid count={developing.length} aspect={1} label="Sweep previews">{developing.map(d=><RunDevelop key={d.id} workspaceId={workspace.id} run={runs[d.id]!} caption={`${d.label} · Take ${runs[d.id]!.take}`}/>)}</ResultGrid>}
    {frames.length>1&&<AngleSweepViewer frames={frames} originalIndex={originalIndex} index={Math.min(index,frames.length-1)} onIndex={setIndex} onSave={i=>void save(i)} saving={saving} reliableSteps={2}/>}
    {(error||failed.length>0)&&<Notice title="The sweep didn't finish" actions={<Button variant="secondary" disabled={disabled||!sourceAssetId} onClick={()=>void queue()}>Start a new sweep</Button>} details={error||failed.map(f=>`${f.label}: ${runs[f.id]?.error??f.id}`).join("\n")||undefined}>{error||`The ${failed.map(f=>f.label.toLowerCase()).join(" and ")} camera move failed. A new sweep uses this image and starts that move again.`}</Notice>}
    <Dialog wide open={sheet} title="Angle sweep contact sheet" onClose={()=>setSheet(false)} footer={<Button variant="secondary" onClick={()=>setSheet(false)}>Close</Button>}><ContactSheet items={frames.map(f=>({src:f.src,label:`${f.label??"View"}${slate(f.label)}`}))} fileName="angle-sweep-contact-sheet.png"/></Dialog>
  </div>;
}
