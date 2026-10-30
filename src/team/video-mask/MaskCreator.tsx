import {useEffect,useState} from "react";
import {Button,Collapsible,LinkButton,MediaCard,Meta,Notice,SliderField,StatusText,TextField} from "../../ds";
import type {CapabilityManifestV2} from "../../capabilities/types";
import {ApiError,assetUrl,workspacePath,type Asset,type Call,type Project,type Run,type Worker,type Workspace} from "../api";
import {activeRun,submissionIntent,workerReadiness} from "../state";
import {RunDevelop} from "../RunDevelop";
import {TrackedMaskReview,trackedReviewGeometry} from "./TrackedMaskReview";
import {pendingTrackingIntent,recoverableTrackedMasks,recoverableTrackingRun,trackingStorageKey,type TrackingIntent} from "./tracking-state";
import {PointSelectionEditor} from "./PointSelectionEditor";
import {validTrackingPoints,type VideoTrackingPoint} from "./point-selection";

function stored(key:string){try{return JSON.parse(sessionStorage.getItem(key)??"null");}catch{return null;}}
export function MaskCreator({manifest,workers,workspace,project,source,call,canEdit,userId,onApproved,onBusyChange,preserveSubject=false,storageScope="",excludeMaskIds=[]}:{manifest:CapabilityManifestV2;workers:Worker[];workspace:Workspace;project:Project;source:Asset;call:Call;canEdit:boolean;userId:string;onApproved:(asset:Asset)=>void;onBusyChange?:(busy:boolean)=>void;preserveSubject?:boolean;storageScope?:string;excludeMaskIds?:string[]}){
  const key=trackingStorageKey(userId,workspace.id,project.id,source.id,manifest.id)+(storageScope?`:${storageScope}`:""),thresholdControl=manifest.controls.find(c=>c.id==="threshold"),excluded=excludeMaskIds.join("|");
  const pointMode=manifest.outputContract?.trackingMode==="points";
  const [pending,setPending]=useState<TrackingIntent|null>(()=>{const intent=pendingTrackingIntent(stored(key+":intent"),project.id,source.id,manifest.id);return intent&&("points" in intent.tracking)===pointMode?intent:null;});
  const [runId,setRunId]=useState<string|null>(()=>{const v=stored(key+":run");return typeof v==="string"&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v)?v:null;});
  const [prompt,setPrompt]=useState(pending&&"prompt" in pending.tracking?pending.tracking.prompt:""),[threshold,setThreshold]=useState(pending?.controls.threshold??Number(thresholdControl?.default??.35)),[mask,setMask]=useState<Asset|null>(null),[run,setRun]=useState<Run|null>(null),[discover,setDiscover]=useState(true),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(""),[error,setError]=useState("");
  const [points,setPoints]=useState<VideoTrackingPoint[]>(()=>{if(pending&&"points" in pending.tracking)return pending.tracking.points;const saved=stored(key+":selection");return validTrackingPoints(saved)?saved:[];});
  const selectionValid=pointMode?validTrackingPoints(points):prompt.trim().length>=2;
  const worker=workers.find(w=>workerReadiness(manifest,w).state==="ready"),working=!!runId||!!pending||busy==="create";
  const reviewState=(mask?.metadata?.maskReview as {state?:string}|undefined)?.state,approved=reviewState==="approved";
  function remember(suffix:string,value:unknown){try{if(value===null)sessionStorage.removeItem(key+suffix);else sessionStorage.setItem(key+suffix,JSON.stringify(value));}catch{setError("Keep this page open: tracking recovery could not be saved in this browser.");}}
  function trackRun(id:string|null){setRunId(id);remember(":run",id);}
  function trackIntent(intent:TrackingIntent|null){setPending(intent);remember(":intent",intent);}
  useEffect(()=>{onBusyChange?.(working||!!busy);return()=>onBusyChange?.(false);},[working,busy,onBusyChange]);
  useEffect(()=>{
    if(!discover||runId||pending||mask)return;let active=true;
    void Promise.all([call<Asset[]>(workspacePath(workspace.id,`assets/${source.id}/tracked-masks`)),call<Run[]>(workspacePath(workspace.id,`assets/${source.id}/tracking-runs?capabilityId=${encodeURIComponent(manifest.id)}`))]).then(async([assets,runs])=>{
      if(!active)return;const existing=recoverableTrackingRun(runs,source,project.id,manifest.id,userId);
      if(existing){setRun(existing);trackRun(existing.id);setDiscover(false);return;}
      const selected=recoverableTrackedMasks(assets.filter(asset=>!excludeMaskIds.includes(asset.id)),source,project.id,manifest.id)[0];if(!selected)return;
      const producer=(selected.metadata?.sourceLinkedMask as {producerRunId?:string})?.producerRunId;
      if(producer){const detail=await call<Run>(workspacePath(workspace.id,`runs/${producer}`));if(!active)return;const snapshot=detail.invocation as unknown as {trackingSnapshot?:{prompt?:string}};if(snapshot?.trackingSnapshot?.prompt)setPrompt(old=>old||snapshot.trackingSnapshot!.prompt!);}
      if(active)setMask(selected);
    }).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};
  },[call,workspace.id,project.id,manifest.id,source,discover,runId,pending,mask,userId,excluded]);
  useEffect(()=>{
    if(!runId)return;let active=true,timer:ReturnType<typeof setTimeout>|undefined;const abort=new AbortController();
    async function poll(){try{
      const value=await call<Run>(workspacePath(workspace.id,`runs/${runId}`),"GET",undefined,{signal:abort.signal});if(!active)return;setRun(value);
      if(value.state==="succeeded"){
        if(!value.output_ids[0])throw new Error("The mask run finished without an output asset.");
        const asset=await call<Asset>(workspacePath(workspace.id,`assets/${value.output_ids[0]}`),"GET",undefined,{signal:abort.signal});if(!active)return;
        if(!recoverableTrackedMasks([asset],source,project.id,manifest.id).length){trackRun(null);setDiscover(false);setError("The completed mask was rejected or no longer matches this source. No new run was started.");return;}
        setMask(asset);trackRun(null);setError("");return;
      }
      if(!activeRun(value.state)){setError(value.error??`Tracking ended: ${value.state}. No new run was started.`);trackRun(null);return;}
      if(value.state==="submission_unknown")setError("Submission outcome is unknown. Reconcile this run in run history; no duplicate job is started.");
      timer=setTimeout(()=>void poll(),2000);
    }catch(e){if(active)setError((e as Error).message);}}
    void poll();return()=>{active=false;abort.abort();clearTimeout(timer);};
  },[call,runId,workspace.id,project.id,manifest.id,source,refresh]);
  async function create(){if(!canEdit||busy||runId||(!pending&&(!worker||!selectionValid)))return;
    const tracking=pointMode?{frameIndex:0 as const,objectIndex:1 as const,points:points.map(point=>({...point}))}:{prompt:prompt.trim()};
    const intent=pending??submissionIntent({projectId:project.id,workerId:worker!.id,capabilityId:manifest.id,version:manifest.version,routeId:"local" as const,inputs:{source_video:source.id},elementInputs:{},controls:pointMode?{}:{threshold},audioPolicy:"mute" as const,tracking});
    trackIntent(intent);setBusy("create");setDiscover(false);setError("");setMask(null);
    try{const result=await call<{id:string}>(workspacePath(workspace.id,"runs"),"POST",intent);trackRun(result.id);trackIntent(null);}catch(e){setError((e as Error).message);if(e instanceof ApiError&&e.status>=400&&e.status<500&&![401,409].includes(e.status))trackIntent(null);}finally{setBusy("");}
  }
  async function cancel(){if(!canEdit||!runId||busy)return;setBusy("cancel");try{await call(workspacePath(workspace.id,`runs/${runId}/cancel`),"POST",{});setRefresh(v=>v+1);}catch(e){setError((e as Error).message);}finally{setBusy("");}}
  async function review(decision:"approve"|"reject"){
    if(!mask?.sha256||!canEdit||busy)return;setBusy(decision);setError("");
    try{
      if(approved&&decision==="approve"){onApproved(mask);return;}
      await call(workspacePath(workspace.id,`assets/${mask.id}/mask-review`),"POST",{decision,expectedSha256:mask.sha256});
      if(decision==="approve")onApproved(await call<Asset>(workspacePath(workspace.id,`assets/${mask.id}`)));
      setMask(null);setDiscover(false);
    }catch(e){setError((e as Error).message);}finally{setBusy("");}
  }
  if(manifest.coverage.local!=="implemented")return null;
  return <div className="cf-form">
    {!mask?<>
      {pointMode?<PointSelectionEditor workspace={workspace.id} source={source} value={points} onChange={value=>{setPoints(value);remember(":selection",value);}} disabled={working||!canEdit}/>:<>
        <TextField maxLength={200} label={preserveSubject?"Subject to keep":"Object to change"} value={prompt} onChange={setPrompt} placeholder={preserveSubject?"e.g. the person in the foreground":"e.g. the jacket, the person, the car"} disabled={working||!canEdit}/>
        <Collapsible title="Tracking settings"><SliderField label="Detection threshold" value={threshold} min={thresholdControl?.min??0} max={thresholdControl?.max??1} step={thresholdControl?.step??.05} onChange={setThreshold} disabled={working||!canEdit}/></Collapsible>
      </>}
      {pending&&<Notice inline priority={70} title="Tracking request awaiting confirmation">The source, selection, worker and settings are frozen. Confirming below reuses the same request identifier, so one tracking job runs.</Notice>}
      <Button variant="secondary" disabled={!canEdit||!!busy||!!runId||(!pending&&(!worker||!selectionValid))} onClick={()=>void create()}>{busy==="create"?"Confirming tracking…":pending?"Confirm tracking request":preserveSubject?"Select background":"Track this object"}</Button>
      {run&&run.state!=="succeeded"&&<RunDevelop workspaceId={workspace.id} run={run}/>}
      {runId&&<><Button variant="secondary" disabled={!canEdit||!!busy||run?.state==="cancel_requested"} onClick={()=>void cancel()}>Cancel tracking</Button><Button variant="ghost" disabled={!!busy} onClick={()=>setRefresh(v=>v+1)}>Check tracking status</Button></>}
      {!worker&&!working&&<Meta>A ready worker with this installed tracking workflow is required to create another mask.</Meta>}
    </>:<>
      <StatusText tone={approved?"ok":"warn"}>{approved?"Mask in use":"Mask ready — use it to continue"}</StatusText>
      {!approved&&<Meta>Nothing is applied until you use the mask. Check a few frames, then press "Use this mask".</Meta>}
      <TrackedMaskReview key={mask.id} workspace={workspace.id} source={source} mask={mask}/>
      <Collapsible title="Play the full mask clip"><MediaCard media={<video controls preload="metadata" src={assetUrl(workspace.id,mask.id)}/>} title="Tracked area"/></Collapsible>
      <Button variant="primary" disabled={!!busy||!canEdit||!trackedReviewGeometry(source,mask)} onClick={()=>void review("approve")}>{busy==="approve"?"Approving…":approved?"Use approved mask":"Use this mask"}</Button>
      {!approved?<Button variant="secondary" disabled={!!busy||!canEdit} onClick={()=>void review("reject")}>Reject and adjust</Button>:<Button variant="ghost" disabled={!!busy||!canEdit} onClick={()=>{setMask(null);setDiscover(false);}}>Track another mask</Button>}
    </>}
    {error&&<Notice priority={60} title="Tracking didn't start" actions={<Button variant="secondary" disabled={!canEdit||!!busy||(!pending&&(!worker||!selectionValid))} onClick={()=>void create()}>Try again</Button>} details={error}>No mask was made. Trying again reuses this selection, worker and settings, so one tracking job runs.</Notice>}
    {run?.state==="submission_unknown"&&<LinkButton variant="secondary" href="#library/runs">Open run history</LinkButton>}
  </div>;
}
