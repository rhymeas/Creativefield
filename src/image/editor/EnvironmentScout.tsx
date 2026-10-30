import {useEffect,useRef,useState} from "react";
import {Button,Dialog,Meta,Notice,ResultTile,ScoutReel,SliderField,Toolbar} from "../../ds";
import {ApiError,assetUrl,workspacePath,type Asset,type Call,type Run} from "../../team/api";
import {activeRun} from "../../team/state";
import type {CapabilityManifestV2} from "../../capabilities/types";
import type {PreservationRecord} from "../../capabilities/edit-preservation";
import {PrecisionReview} from "./PrecisionReview";
import {RunDevelop} from "../../team/RunDevelop";
import {freezeScout,recoverScout,SCOUT_DESTINATIONS,scoutPreservation,scoutRunRequest,scoutStorageKey,type ScoutBatch,type ScoutInputs,type ScoutScope} from "./environment-scout";

export function EnvironmentScout({scope,manifest,workerId,routeId,call,canEdit,hasSelection,onPrepare,onKeep,onRefine,onClose}:{scope:ScoutScope;manifest:CapabilityManifestV2;workerId:string;routeId:string;call:Call;canEdit:boolean;hasSelection:boolean;onPrepare:()=>Promise<ScoutInputs>;onKeep:(record:PreservationRecord,inputs:ScoutInputs)=>Promise<void>;onRefine:()=>void;onClose:()=>void}){
  const key=scoutStorageKey(scope),alive=useRef(true),submitting=useRef(false);
  const [batch,setBatch]=useState(()=>{try{return recoverScout(sessionStorage.getItem(key),scope,manifest);}catch{return null;}}),[selected,setSelected]=useState("forest"),[feather,setFeather]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(""),[refresh,setRefresh]=useState(0),[review,setReview]=useState(false);
  const [runs,setRuns]=useState<Record<string,Run>>({}),[results,setResults]=useState<Record<string,PreservationRecord>>({});
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const ids=Object.values(batch?.runIds??{}),unresolved=ids.some(id=>!runs[id]||activeRun(runs[id].state));
  useEffect(()=>{
    if(!batch||!ids.length)return;const frozen=batch;let current=true,timer:ReturnType<typeof setTimeout>|undefined;const abort=new AbortController();
    async function read(){try{
      const rows=await Promise.all(ids.map(id=>call<Run>(workspacePath(scope.workspaceId,`runs/${id}`),"GET",undefined,{signal:abort.signal})));
      const entries=await Promise.all(rows.filter(run=>run.state==="succeeded").map(async run=>{if(!run.output_ids[0])throw Error("The preview finished without an image.");const asset=await call<Asset>(workspacePath(scope.workspaceId,`assets/${run.output_ids[0]}`),"GET",undefined,{signal:abort.signal});return [run.id,scoutPreservation(frozen,run,asset)] as const;}));
      if(!current)return;setRuns(Object.fromEntries(rows.map(run=>[run.id,run])));setResults(Object.fromEntries(entries));
      if(rows.some(run=>activeRun(run.state)))timer=setTimeout(()=>void read(),2000);
    }catch(e){if(current)setError((e as Error).message);}}
    void read();return()=>{current=false;abort.abort();clearTimeout(timer);};
  },[batch?.id,ids.join(","),scope.workspaceId,call,refresh]);
  function persist(next:ScoutBatch){sessionStorage.setItem(key,JSON.stringify(next));if(alive.current)setBatch(next);}
  async function queue(){
    if(!canEdit||submitting.current)return;submitting.current=true;setBusy(true);setError("");let frozen=batch;
    try{
      if(!frozen){const inputs=await onPrepare();if(!alive.current)return;frozen=freezeScout(scope,manifest,workerId,routeId,inputs,feather);persist(frozen);}
      for(const place of SCOUT_DESTINATIONS){
        if(!alive.current)break;if(frozen.runIds[place.id])continue;
        frozen={...frozen,pendingDestination:place.id};persist(frozen);
        const run:Run=await call<Run>(workspacePath(scope.workspaceId,"runs"),"POST",scoutRunRequest(frozen,place.id));
        // Save the accepted receipt even if the dialog closed while POST was in flight.
        frozen={...frozen,pendingDestination:undefined,runIds:{...frozen.runIds,[place.id]:run.id}};persist(frozen);
      }
      if(alive.current)setRefresh(n=>n+1);
    }catch(e){if(e instanceof ApiError&&[400,403,404,413,415,422].includes(e.status)&&frozen){try{persist({...frozen,pendingDestination:undefined});}catch{/* Retain the saved pending key if recovery storage is unavailable. */}}if(alive.current)setError((e as Error).message+" Resume uses the saved request identifiers.");}
    finally{submitting.current=false;if(alive.current)setBusy(false);}
  }
  const run=batch?runs[batch.runIds[selected]]:undefined,p=run?results[run.id]:undefined;
  async function cancel(){if(!run||!canEdit)return;await call(workspacePath(scope.workspaceId,`runs/${run.id}/cancel`),"POST",{});setRefresh(n=>n+1);}
  return <>
    <Dialog wide open title="Environment" onClose={onClose} footer={<Toolbar>
      {(!batch||SCOUT_DESTINATIONS.some(d=>!batch.runIds[d.id]))&&<Button variant="primary" disabled={!canEdit||busy||(!batch&&!hasSelection)} onClick={()=>void queue()}>{busy?"Queuing previews…":batch?"Resume previews":"Generate 5 previews"}</Button>}
      {p&&<Button variant="primary" onClick={()=>setReview(true)}>Compare and use</Button>}
      <Button variant="secondary" disabled={busy} onClick={onRefine}>Refine subject mask</Button>
      {batch&&<Button variant="ghost" disabled={busy||unresolved||!!batch.pendingDestination} onClick={()=>{try{sessionStorage.removeItem(key);setBatch(null);setRuns({});setResults({});setError("");}catch(e){setError((e as Error).message);}}}>New scout</Button>}
      <Button variant="secondary" onClick={onClose}>Close</Button>
    </Toolbar>}>
      <Meta>Select the foreground subject to keep before generating. Scroll or use arrow keys to explore cached previews; browsing never starts a run. Your canvas stays unchanged until you review and keep a result.</Meta>
      {!hasSelection&&!batch&&<Notice inline tone="info" title="Select the subject first">Close this window, then use Select subject, lasso or the mask brush around the foreground you want to keep.</Notice>}
      {!batch&&<SliderField label="Subject edge softness" value={feather} min={0} max={3} step={.1} onChange={setFeather}/>}
      <ScoutReel label="Destinations" value={selected} onSelect={setSelected} items={SCOUT_DESTINATIONS.map(place=>{const id=batch?.runIds[place.id],record=id?results[id]:undefined;return {id:place.id,label:place.label,src:record?assetUrl(scope.workspaceId,record.finalAssetId):undefined};})}/>
      {p&&<ResultTile onOpen={()=>setReview(true)}><img src={assetUrl(scope.workspaceId,p.finalAssetId)} alt={`${SCOUT_DESTINATIONS.find(d=>d.id===selected)?.label} environment preview`}/></ResultTile>}
      {run&&!p&&<RunDevelop workspaceId={scope.workspaceId} run={run} actions={canEdit&&activeRun(run.state)?<Button variant="secondary" onClick={()=>void cancel().catch(e=>setError((e as Error).message))}>Cancel preview</Button>:undefined}/>}
      {p&&<Meta>Preview ready. Compare the original, inspect the mask and check drift before using it.</Meta>}
      {error&&<Notice inline title="The location preview didn't finish" details={error}>Your canvas is unchanged. Check previews below re-reads this batch; starting a new scout uses the same subject selection.</Notice>}
      {batch&&<Button variant="ghost" onClick={()=>setRefresh(n=>n+1)}>Check previews</Button>}
    </Dialog>
    {review&&p&&batch&&<PrecisionReview open onClose={()=>setReview(false)} workspaceId={scope.workspaceId} run={run??null} result={{runId:run!.id,record:p}} onCancel={cancel} onKeep={canEdit&&p.qa.withinTolerance&&p.qa.protectedPixels>0?async()=>{await onKeep(p,batch.inputs);onClose();}:undefined}/>}
  </>;
}
