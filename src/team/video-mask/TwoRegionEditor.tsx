import {useEffect,useRef,useState} from "react";
import {Button,Collapsible,Dialog,InfoButton,LinkButton,MediaViewer,Notice,ResultTile,TextField,Toolbar} from "../../ds";
import type {CapabilityManifestV2} from "../../capabilities/types";
import {ApiError,assetUrl,workspacePath,type Asset,type Call,type Project,type Run,type Worker,type Workspace} from "../api";
import {activeRun,workerReadiness} from "../state";
import {matchingMask} from "../masked-state";
import {TeamChoice} from "../TeamChoice";
import {RunDevelop} from "../RunDevelop";
import {RegionMaskCreator} from "./RegionMaskCreator";
import {TrackedMaskReview} from "./TrackedMaskReview";
import {buildTwoRegionIntent,readTwoRegionIntent,twoRegionKey,type TwoRegionIntent} from "./two-region-state";
type Saved={firstPrompt:string;secondPrompt:string;maskId:string;pending:TwoRegionIntent|null;runId:string|null};
function stored(key:string){try{return JSON.parse(sessionStorage.getItem(key)??"null");}catch{return null;}}
export function TwoRegionEditor({manifest,catalogue,workspace,project,userId,source,firstMask,assets,workers,preferredWorkerId,firstPrompt,baseControls,call,disabled,onBusyChange,onQueued}:{manifest:CapabilityManifestV2;catalogue:CapabilityManifestV2[];workspace:Workspace;project:Project;userId:string;source:Asset;firstMask:Asset;assets:Asset[];workers:Worker[];preferredWorkerId:string;firstPrompt:string;baseControls:Record<string,unknown>;call:Call;disabled:boolean;onBusyChange:(busy:boolean)=>void;onQueued:()=>void}){
  const key=twoRegionKey(userId,workspace.id,project.id,source.id,firstMask.id),alive=useRef(true);
  const [saved,setSaved]=useState<Saved>(()=>{const s=stored(key),pending=readTwoRegionIntent(s?.pending,project.id,source.id,firstMask.id,manifest.id);return {firstPrompt:pending?String(pending.controls.prompt):typeof s?.firstPrompt==="string"?s.firstPrompt:firstPrompt,secondPrompt:pending?String(pending.controls.prompt_2):typeof s?.secondPrompt==="string"?s.secondPrompt:"",maskId:pending?.inputs.edit_mask_2??(typeof s?.maskId==="string"?s.maskId:""),pending,runId:typeof s?.runId==="string"&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(s.runId)?s.runId:null};});
  const state=useRef(saved);state.current=saved;
  const [open,setOpen]=useState(false),[creating,setCreating]=useState(false),[trackingBusy,setTrackingBusy]=useState(false),[busy,setBusy]=useState(""),[error,setError]=useState(""),[run,setRun]=useState<Run|null>(null),[second,setSecond]=useState<Asset|null>(null),[output,setOutput]=useState<Asset|null>(null),[preview,setPreview]=useState(false),[refresh,setRefresh]=useState(0);
  const ready=workers.filter(w=>workerReadiness(manifest,w).state==="ready"),worker=ready.find(w=>w.id===preferredWorkerId)??ready[0],locked=!!saved.pending||!!saved.runId&&(!run||activeRun(run.state))||!!busy||trackingBusy;
  const choices=[...assets,...(second&&!assets.some(a=>a.id===second.id)?[second]:[])].filter(a=>a.id!==firstMask.id&&matchingMask(a,source,project.id,manifest));
  const selected=choices.find(a=>a.id===saved.maskId),tracker=catalogue.find(m=>m.id==="sam31-video-mask"&&m.coverage.local==="implemented");
  function save(patch:Partial<Saved>,required=false){const next={...state.current,...patch};state.current=next;setSaved(next);try{sessionStorage.setItem(key,JSON.stringify(next));}catch{const message="Request recovery could not be saved. Keep this dialog open and check browser storage.";setError(message);if(required)throw Error(message);}return next;}
  useEffect(()=>{onBusyChange(open);return()=>onBusyChange(false);},[open,onBusyChange]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(!open||!saved.maskId||choices.some(a=>a.id===saved.maskId))return;let current=true;void call<Asset>(workspacePath(workspace.id,`assets/${saved.maskId}`)).then(a=>{if(current&&matchingMask(a,source,project.id,manifest))setSecond(a);}).catch(e=>{if(current)setError((e as Error).message);});return()=>{current=false;};},[open,saved.maskId,assets,call,workspace.id,source,project.id,manifest]);
  useEffect(()=>{if(!open||!saved.runId)return;let current=true,timer:ReturnType<typeof setTimeout>|undefined;const abort=new AbortController();
    async function check(){try{const value=await call<Run>(workspacePath(workspace.id,`runs/${saved.runId}`),"GET",undefined,{signal:abort.signal});if(!current)return;if(value.project_id!==project.id||value.capability_id!==manifest.id)throw Error("This saved edit does not match the current project.");setRun(value);
      if(value.state==="succeeded"){if(!value.output_ids[0])throw Error("The combined edit finished without a video.");const asset=await call<Asset>(workspacePath(workspace.id,`assets/${value.output_ids[0]}`),"GET",undefined,{signal:abort.signal});if(!current)return;if(asset.project_id!==project.id||asset.media_type!=="video")throw Error("The combined output does not match this project.");setOutput(asset);}
      else if(activeRun(value.state))timer=setTimeout(()=>void check(),2000);
    }catch(e){if(current)setError((e as Error).message);}}
    void check();return()=>{current=false;abort.abort();clearTimeout(timer);};
  },[open,saved.runId,refresh,call,workspace.id,project.id,manifest.id]);
  async function queue(){if(disabled||busy||trackingBusy||saved.runId)return;setBusy("queue");setError("");try{
    const intent=saved.pending??(worker&&selected?buildTwoRegionIntent(manifest,project.id,source,firstMask,selected,worker.id,[saved.firstPrompt,saved.secondPrompt],baseControls,crypto.randomUUID()):null);if(!intent)throw Error("Choose the second area and a ready local worker.");save({pending:intent},true);
    const value=await call<{id:string}>(workspacePath(workspace.id,"runs"),"POST",intent);if(!alive.current)return;save({pending:null,runId:value.id});setOutput(null);onQueued();
  }catch(e){if(alive.current){setError((e as Error).message);if(e instanceof ApiError&&e.status>=400&&e.status<500&&![401,408,409,429].includes(e.status))save({pending:null});}}finally{if(alive.current)setBusy("");}}
  async function cancel(){if(!saved.runId||busy)return;setBusy("cancel");try{await call(workspacePath(workspace.id,`runs/${saved.runId}/cancel`),"POST",{});if(alive.current)setRefresh(v=>v+1);}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy("");}}
  const canQueue=!!saved.pending||!!worker&&!!selected&&!!saved.firstPrompt.trim()&&!!saved.secondPrompt.trim();
  return <>
    <Button variant="secondary" disabled={disabled} onClick={()=>setOpen(true)}>Add edit</Button>
    <Dialog open={open} title="Two edits · one video" onClose={()=>{if(!busy){setOpen(false);setPreview(false);}}} footer={<Toolbar>
      {!saved.runId&&<Button variant="primary" disabled={disabled||!!busy||trackingBusy||!canQueue} onClick={()=>void queue()}>{busy==="queue"?"Confirming…":saved.pending?"Confirm same request":"Queue 2 edits"}</Button>}
      {saved.runId&&run&&activeRun(run.state)&&<Button variant="secondary" disabled={!!busy||run.state==="cancel_requested"} onClick={()=>void cancel()}>Cancel edit</Button>}
      {saved.runId&&run&&!activeRun(run.state)&&<Button variant="secondary" disabled={!!busy} onClick={()=>{save({runId:null});setRun(null);setOutput(null);setError("");}}>New take</Button>}
      <Button variant="ghost" disabled={!!busy} onClick={()=>{setOpen(false);setPreview(false);}}>Close</Button>
    </Toolbar>}><div className="cf-form">
      {!saved.runId&&<><TextField label="First change" value={saved.firstPrompt} onChange={value=>save({firstPrompt:value})} disabled={locked} maxLength={20000}/>
        <TeamChoice label="Second area" display={selected?"Reviewed area selected":"Choose a reviewed area"} value={saved.maskId} disabled={locked} options={choices.map(a=>({value:a.id,label:a.name}))} onChange={id=>save({maskId:id})}/>
        {tracker&&!creating&&<Button variant="secondary" disabled={locked||disabled} onClick={()=>setCreating(true)}>Select another object</Button>}
        {tracker&&creating&&<RegionMaskCreator storageScope={`second-edit:${firstMask.id}`} excludeMaskIds={[firstMask.id]} manifest={tracker} pointManifest={catalogue.find(m=>m.id==="sam31-video-point-mask")} backgroundManifest={catalogue.find(m=>m.id==="sam31-video-background-mask")} workers={workers} workspace={workspace} project={project} source={source} call={call} userId={userId} canEdit={!disabled&&!saved.pending&&!busy} onBusyChange={setTrackingBusy} onApproved={asset=>{setSecond(asset);save({maskId:asset.id});setCreating(false);}}/>}
        {selected&&!creating&&<Collapsible title="Review second area"><TrackedMaskReview workspace={workspace.id} source={source} mask={selected}/></Collapsible>}
        <TextField label="Second change" value={saved.secondPrompt} onChange={value=>save({secondPrompt:value})} disabled={locked} maxLength={20000}/>
      </>}
      {run&&run.state!=="succeeded"&&<RunDevelop workspaceId={workspace.id} run={run}/>}
      {output&&<><ResultTile onOpen={()=>setPreview(true)}><video controls preload="metadata" src={assetUrl(workspace.id,output.id)}/></ResultTile><MediaViewer open={preview} mediaType="video" src={assetUrl(workspace.id,output.id)} name={output.name} onClose={()=>setPreview(false)}/><LinkButton href={assetUrl(workspace.id,output.id,true)}>Download video</LinkButton></>}
      {saved.runId&&(!run||activeRun(run.state))&&<Button variant="ghost" disabled={!!busy} onClick={()=>setRefresh(v=>v+1)}>Check status</Button>}
      <InfoButton title="Two edits">Both changes are generated from the original clip and combined into one new video. The second area wins where masks overlap. Review both masks before queueing. Closing this dialog stops its status checks; an accepted job continues and can be reopened here.</InfoButton>
      {error&&<Notice inline title="The combined edit didn't start" details={error}>Nothing was queued. The dialog's own action tries the same two changes again.</Notice>}
    </div></Dialog>
  </>;
}
