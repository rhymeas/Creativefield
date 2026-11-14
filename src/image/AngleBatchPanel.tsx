import {useEffect,useRef,useState} from "react";
import {Button,CameraAngleSheet,ContactSheet,Dialog,InfoButton,Meta,Notice,Toolbar,type ContactSheetItem} from "../ds";
import type {CapabilityManifestV2} from "../capabilities/types";
import {ApiError,assetUrl,workspacePath,type Call,type Project,type Run,type Workspace} from "../team/api";
import {activeRun} from "../team/state";
import type {ImageDraft} from "./image-state";
import {angleBatchPendingPresets,angleBatchSubmittingCount,angleBatchStorageKey,angleRunRequest,extendAngleBatch,freezeAngleBatch,recoverAngleBatchForReview,type AngleBatch} from "./angle-batch";
import {angleBatchActionState,type AngleBatchAction} from "./angle-batch-action";

export function AngleBatchPanel({manifest,draft,workspace,project,userId,workerId,call,runs,disabled,onChanged,onBusy,onAction,onKnownRuns,onSubmittingCount}:{manifest:CapabilityManifestV2;draft:ImageDraft;workspace:Workspace;project:Project;userId:string;workerId:string;call:Call;runs:Run[];disabled:boolean;onChanged:()=>void;onBusy:(busy:boolean)=>void;onAction?:(action:AngleBatchAction|null)=>void;onKnownRuns?:(runs:Run[])=>void;onSubmittingCount?:(count:number)=>void}){
  const scope={workspaceId:workspace.id,projectId:project.id,userId,workerId},storageKey=angleBatchStorageKey(scope,manifest.id),mounted=useRef(true),submitting=useRef(false);
  const [batch,setBatch]=useState<AngleBatch|null>(()=>{try{return recoverAngleBatchForReview(JSON.parse(sessionStorage.getItem(storageKey)??"null"),manifest,scope);}catch{return null;}});
  const [selected,setSelected]=useState<string[]>(()=>batch?.presetIds??[]),[known,setKnown]=useState<Run[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(""),[sheet,setSheet]=useState(false),[uncertain,setUncertain]=useState(false);
  useEffect(()=>{onKnownRuns?.(known);},[known,onKnownRuns]);
  useEffect(()=>()=>onKnownRuns?.([]),[onKnownRuns]);
  const submittingCount=angleBatchSubmittingCount(batch,manifest,busy);
  useEffect(()=>{onSubmittingCount?.(submittingCount);},[submittingCount,onSubmittingCount]);
  useEffect(()=>()=>onSubmittingCount?.(0),[onSubmittingCount]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;onBusy(false);};},[]);
  const ids=Object.values(batch?.runIds??{}),effective=new Map(known.map(run=>[run.id,run]));for(const run of runs)effective.set(run.id,run);
  useEffect(()=>{let current=true;const missing=ids.filter(id=>!runs.some(run=>run.id===id));if(missing.length)void Promise.all(missing.map(id=>call<Run>(workspacePath(workspace.id,`runs/${id}`)))).then(rows=>{if(current)setKnown(old=>[...old.filter(r=>!rows.some(n=>n.id===r.id)),...rows]);}).catch(e=>{if(current)setError((e as Error).message);});return()=>{current=false;};},[batch?.id,ids.join(","),workspace.id,project.id,call]);
  const active=ids.some(id=>{const run=effective.get(id);return !run||activeRun(run.state);});
  useEffect(()=>{
    if(!active||!ids.length)return;
    let current=true;
    const timer=window.setInterval(()=>{
      void Promise.all(ids.map(id=>call<Run>(workspacePath(workspace.id,`runs/${id}`)))).then(rows=>{if(current)setKnown(rows);}).catch(error=>{if(current)setError((error as Error).message);});
    },2500);
    return()=>{current=false;window.clearInterval(timer);};
  },[active,ids.join(","),workspace.id,project.id,call]);
  const items:ContactSheetItem[]=(batch?.presetIds??[]).map(preset=>{const run=effective.get(batch!.runIds[preset]),title=manifest.presets.find(p=>p.id===preset)?.title??preset;return {src:run?.state==="succeeded"&&run.output_ids[0]?assetUrl(workspace.id,run.output_ids[0]):undefined,label:title};});
  const sourcePort=manifest.inputs.find(port=>port.type==="image")?.id;
  const sourceId=sourcePort?(batch?.draft??draft).inputs?.[sourcePort]:undefined;
  const sourceSrc=sourceId?assetUrl(workspace.id,sourceId):undefined;
  const angles=manifest.presets.map(preset=>{
    const run=batch?effective.get(batch.runIds[preset.id]):undefined;
    return {id:preset.id,label:preset.title,src:run?.state==="succeeded"&&run.output_ids[0]?assetUrl(workspace.id,run.output_ids[0]):undefined,status:run?.state??(batch&&!batch.presetIds.includes(preset.id)?"Not selected":"Not generated")};
  });
  const exportItems:ContactSheetItem[]=angles.map(item=>({src:item.src,label:`${item.label} · ${item.status}`}));
  exportItems.splice(4,0,{src:sourceSrc,label:"Original"});
  const pending=ids.some(id=>!effective.has(id)||activeRun(effective.get(id)!.state)),complete=items.filter(item=>item.src).length;
  const actionState=angleBatchActionState({batch,selected,manifest,draft,scope,disabled,busy,pending,uncertain});
  const invokeAction=useRef<()=>void>(()=>{});
  invokeAction.current=()=>{
    if(!actionState.enabled)return;
    if(actionState.kind==="new"){
      try{sessionStorage.removeItem(storageKey);}catch{setError("The saved request could not be cleared. Check browser storage and try again.");return;}setSelected(batch?.presetIds??[]);setBatch(null);setKnown([]);setError("");setUncertain(false);
    }else void queue(actionState.kind==="extend");
  };
  useEffect(()=>{onAction?.({...actionState,invoke:()=>invokeAction.current()});},[onAction,actionState.kind,actionState.label,actionState.enabled,actionState.busy,actionState.hint]);
  useEffect(()=>()=>onAction?.(null),[onAction]);
  function persist(next:AngleBatch){sessionStorage.setItem(storageKey,JSON.stringify(next));setBatch(next);}
  async function queue(extend=false){
    if(submitting.current||disabled)return;submitting.current=true;setBusy(true);onBusy(true);setError("");setUncertain(false);
    let current=batch;
    try{
      current=current??freezeAngleBatch(manifest,draft,selected,scope);
      if(extend&&current)current=extendAngleBatch(current,selected,manifest);
      persist(current);
      for(const preset of angleBatchPendingPresets(current,manifest)){
        if(!mounted.current)break;
        if(current.runIds[preset])continue;
        // Replay the same keys after an unknown response; the server returns accepted runs.
        current={...current,pendingPreset:preset};persist(current);
        const run:Run=await call<Run>(workspacePath(workspace.id,"runs"),"POST",angleRunRequest(current,preset));
        current={...current,pendingPreset:undefined,runIds:{...current.runIds,[preset]:run.id}};sessionStorage.setItem(storageKey,JSON.stringify(current));
        if(mounted.current){setBatch(current);setKnown(old=>[run,...old.filter(r=>r.id!==run.id)]);onChanged();}
      }
    }catch(e){if(mounted.current){setError((e as Error).message);const unknown=!(e instanceof ApiError)||e.status===0||e.status>=500||[408,409,429].includes(e.status);setUncertain(unknown);if(!unknown&&current){try{persist({...current,pendingPreset:undefined});}catch{}}}}
    finally{submitting.current=false;if(mounted.current){setBusy(false);onBusy(false);}}
  }
  return <div className="cf-form">
    <CameraAngleSheet compact items={angles} source={{src:sourceSrc}} selected={selected} disabled={disabled||busy||pending||uncertain||!!batch?.pendingPreset||!!batch&&batch.capabilityVersion!==manifest.version} onChange={setSelected}/>
    <Toolbar>{!onAction&&<Button variant="secondary" disabled={!actionState.enabled} onClick={()=>invokeAction.current()}>{actionState.label}</Button>}{batch&&<Button variant="secondary" disabled={!complete||busy} onClick={()=>setSheet(true)}>Batch contact sheet</Button>}<InfoButton title={manifest.id==="qwen-image-21-angles"?"Angle LoRA, not an orbit":"45° guidance, not an orbit"}><Meta>{manifest.id==="qwen-image-21-angles"?"These runs use the Qwen Image 2.1 Multiple-Angles LoRA with explicit <mva> camera instructions. They are generative reshots, not a reconstructed 3D orbit. Review identity and background for each angle.":"These are prompt presets for a requested 45° viewpoint. They are not a 3D orbit. The model can keep the original viewpoint or change scene details; review each result before using it in a shot."}</Meta></InfoButton></Toolbar>
    {error&&<Notice title="The angle batch didn't finish" actions={<Button variant="secondary" disabled={!actionState.enabled} onClick={()=>invokeAction.current()}>{actionState.label}</Button>} details={error}>Accepted jobs are not resubmitted; {actionState.enabled?`${actionState.label} reuses the original request keys.`:"the batch action above continues it."}</Notice>}
    <Dialog wide open={sheet} title="Angle batch contact sheet" onClose={()=>setSheet(false)} footer={<Button variant="secondary" onClick={()=>setSheet(false)}>Close</Button>}><ContactSheet items={exportItems} title="Camera angles" fileName={`angles-${batch?.id??"batch"}.png`} caption={`${complete} generated angles. The original stays in the center; other slots retain their actual state.`}/></Dialog>
  </div>;
}
