import {useEffect,useMemo,useState} from "react";
import {Button,Dialog,Notice,TextField} from "../ds";
import {ShotFrame,type ShotFrameState} from "../ds/ShotFrame";
import type {CapabilityManifestV2} from "../capabilities/types";
import {ApiError,assetUrl,workspacePath,type Call,type Run,type Worker} from "./api";
import {activeRun,defaultDraft,draftErrors,workerReadiness} from "./state";
import {plainProblem} from "./problems";
import {TeamChoice} from "./TeamChoice";
import {RunDevelop} from "./RunDevelop";
import type {Shot} from "./storyboard-state";

export type StillTake={id:string;plan_key:string;prompt:string;child_run_id:string;state:string;error:string|null;output_ids:string[];approved_asset_id:string|null;approved_at:string|null;rejected_at?:string|null;created_at:string;scene:number;shot:number;take:number};
type Intent={revision:number;workerId:string;idempotencyKey:string;capabilityId:string;version:string;controls:Record<string,string|number|boolean>;planKeys?:string[]};
export function approvedTakes(shots:Shot[],takes:StillTake[]){return Object.fromEntries(shots.flatMap(s=>{const t=takes.filter(t=>t.plan_key===s.key&&t.prompt===s.prompt&&t.approved_asset_id&&t.state==="succeeded").sort((a,b)=>(b.approved_at??"").localeCompare(a.approved_at??""))[0];return t?[[s.key,t]]:[];}));}
export function stillRun(t:StillTake):Run{return {id:t.child_run_id,project_id:"",created_by:"",capability_id:"",capability_version:"",state:t.state,error:t.error,output_ids:t.output_ids,scene:t.scene,shot:t.shot,take:t.take,created_at:t.created_at,updated_at:t.created_at};}

/** Frames for text-only shots. Always mounted, so tiles and approvals know every take; the frame
 * picture itself appears only for the selected shot when it starts from text (`frameable`). */
export function StoryboardStills({boardId,workspace,revision,shots,selected,frameable,catalogue,workers,call,authorized,canEdit,disabled,storageKey,onTakes,onAssets,onSelectShot}:{boardId:string;workspace:string;revision:number;shots:Shot[];selected:string;frameable:boolean;catalogue:CapabilityManifestV2[];workers:Worker[];call:Call;authorized:boolean;canEdit:boolean;disabled:boolean;storageKey:string;onTakes:(t:StillTake[])=>void;onAssets:(ids:string[])=>void;/** Takes the panel to the shot that needs a different workflow, so its fix is one click away. */onSelectShot:(key:string)=>void}){
  const manifests=useMemo(()=>catalogue.filter(m=>m.category==="image"&&m.coverage.local==="implemented"&&!m.imageArtifacts&&!m.outputContract&&(m.inputs.every(p=>!p.required)||(m.inputs.filter(p=>p.required).length===1&&m.inputs.filter(p=>p.required)[0].type==="image"))),[catalogue]);
  const [advanced,setAdvanced]=useState(false),[overrides,setOverrides]=useState<Record<string,Record<string,string|number|boolean>>>({});
  const [model,setModel]=useState(""),[workerId,setWorkerId]=useState(""),[takes,setTakes]=useState<StillTake[]>([]),[candidateId,setCandidateId]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[refresh,setRefresh]=useState(0);
  const [pending,setPending]=useState<Intent|null>(()=>{try{const p=JSON.parse(sessionStorage.getItem(`${storageKey}:stills`)??"null");return p&&typeof p.idempotencyKey==="string"&&p.controls?p:null;}catch{return null;}});
  const chosen=manifests.find(m=>m.id===model)??manifests.find(m=>workers.some(w=>workerReadiness(m,w).state==="ready"))??manifests[0];
  const worker=workers.find(w=>w.id===workerId)??workers.find(w=>chosen&&workerReadiness(chosen,w).state==="ready");
  const controls=chosen?{...defaultDraft(chosen).controls,...overrides[chosen.id]}:{};
  delete controls.prompt;
  const invalid=chosen?draftErrors(chosen,{...defaultDraft(chosen),controls:{...controls,prompt:"Saved shot prompt"}}):["Choose a workflow"];
  const live=takes.some(t=>activeRun(t.state));
  useEffect(()=>{if(!authorized)return;let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
    async function read(){try{const t=await call<StillTake[]>(workspacePath(workspace,`storyboards/${boardId}/stills`));if(!alive)return;setTakes(t);onTakes(t);onAssets([...new Set(t.flatMap(t=>t.output_ids??[]))]);if(t.some(t=>activeRun(t.state)))timer=setTimeout(()=>void read(),1200);}catch(e){if(alive)setError((e as Error).message);}}
    void read();return()=>{alive=false;clearTimeout(timer);};
  },[authorized,call,workspace,boardId,revision,refresh,onTakes,onAssets]);
  function track(intent:Intent|null){setPending(intent);try{if(intent)sessionStorage.setItem(`${storageKey}:stills`,JSON.stringify(intent));else sessionStorage.removeItem(`${storageKey}:stills`);}catch{setError("Keep this page open: still request tracking could not be stored.");}}
  async function generate(planKey?:string){if(busy||!canEdit||(!pending&&(disabled||!chosen||!worker)))return;
    const needsImage=(chosen?.inputs??[]).some(p=>p.required&&p.type==="image"),withCast=shots.filter(s=>s.settings.elementInputs.start_image).map(s=>s.key),targets=planKey?[planKey]:needsImage?withCast:undefined;
    if(!pending&&needsImage&&!planKey&&!withCast.length){setError("No shot has a cast picture; attach one or choose a text-to-image still workflow.");return;}
    const intent=pending??{revision,workerId:worker!.id,idempotencyKey:crypto.randomUUID(),capabilityId:chosen!.id,version:chosen!.version,controls,...(targets?{planKeys:targets}:{})};track(intent);setBusy(true);setError("");
    try{await call(workspacePath(workspace,`storyboards/${boardId}/stills`),"POST",intent);track(null);setRefresh(v=>v+1);}catch(e){setError((e as Error).message);if(e instanceof ApiError&&e.status>=400&&e.status<500&&e.status!==401)track(null);}finally{setBusy(false);}
  }
  const current=shots.find(s=>s.key===selected),candidates=takes.filter(t=>t.plan_key===selected&&t.prompt===current?.prompt),candidate=candidates.find(t=>t.id===candidateId)??candidates[0],approved=approvedTakes(shots,takes),accepted=approved[selected];
  /* A failed frame is said in everyday words; the raw message waits behind Details. */
  const candidateProblem=candidate?.error?plainProblem(candidate.error):null,takeProblem=error?plainProblem(error):null;
  const blockedStills=shots.filter(s=>{const approval=approvedTakes([s],takes)[s.key];if(!approval)return false;const cap=catalogue.find(m=>m.id===s.settings.generation?.capabilityId);if(!cap||cap.inputs.some(p=>p.id==="start_image"))return false;const base=cap.id.endsWith("-t2v")?cap.id.slice(0,-4):undefined;const sibling=base?catalogue.find(m=>m.id===base&&m.inputs.some(p=>p.id==="start_image")):undefined;return !sibling;});
  async function approve(){if(!candidate||busy||!canEdit||disabled)return;setBusy(true);setError("");try{await call(workspacePath(workspace,`storyboards/${boardId}/stills/${candidate.id}/approve`),"POST",{});setRefresh(v=>v+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function reject(){if(!candidate||busy||!canEdit||disabled)return;setBusy(true);setError("");try{await call(workspacePath(workspace,`storyboards/${boardId}/stills/${candidate.id}/reject`),"POST",{});setRefresh(v=>v+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function cancel(){if(!candidate||busy||!canEdit)return;setBusy(true);try{await call(workspacePath(workspace,`runs/${candidate.child_run_id}/cancel`),"POST",{});setRefresh(v=>v+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const generationReason=!canEdit?"Creator access is required.":busy?"Wait for the current action to finish.":disabled?"Write the prompt and save the shots first.":live?"Frames are already being generated.":!shots.length?"Add a shot first.":!chosen?"No compatible image workflow is installed.":!worker?"Connect a worker that can run the image workflow.":invalid[0]??(workerReadiness(chosen,worker).state!=="ready"?workerReadiness(chosen,worker).reasons[0]:undefined);
  const takeIndex=candidate?candidates.indexOf(candidate):-1;
  const frameState:ShotFrameState=!candidate?"empty":activeRun(candidate.state)?"running":candidate.state!=="succeeded"||!candidate.output_ids[0]?"empty":accepted?.id===candidate.id?"approved":candidate.rejected_at?"rejected":"candidate";
  const settings=<Dialog className="ds-advanced-dialog" open={advanced&&authorized} title="Frame settings" onClose={()=>setAdvanced(false)} footer={<Button onClick={()=>setAdvanced(false)}>Done</Button>}><div className="cf-form">
      <TeamChoice label="Still workflow" display={chosen?.title??"No local still workflow"} value={chosen?.id??""} options={manifests.map(m=>({value:m.id,label:m.title}))} disabled={!canEdit||busy||!!pending||live} onChange={setModel}/>
      <TeamChoice label="Still worker" display={worker?.name??"Choose a worker"} value={worker?.id??""} options={workers.map(w=>({value:w.id,label:w.name,note:chosen?workerReadiness(chosen,w).reasons.join(" "):"Choose a workflow"}))} disabled={!canEdit||busy||!!pending||live} onChange={setWorkerId}/>
      {chosen?.controls.filter(c=>["width","height","steps","seed"].includes(c.id)&&!c.disabledReason).map(c=><TextField key={c.id} label={c.label} type="number" min={c.min} max={c.max} step={c.step??1} disabled={!canEdit||busy||!!pending||live} value={String(controls[c.id]??"")} onChange={value=>setOverrides(old=>({...old,[chosen.id]:{...old[chosen.id],[c.id]:value===""?"":Number(value)}}))}/>)}
      {invalid.length>0&&<Notice inline priority={20} title="Check frame settings">{invalid.join(" ")}</Notice>}
    </div></Dialog>;
  return <>
    {blockedStills.length>0&&<Notice priority={30} title="Approved frame not used" actions={<Button variant="secondary" disabled={!canEdit||busy||!!pending} onClick={()=>onSelectShot(blockedStills[0].key)}>Open shot {shots.indexOf(blockedStills[0])+1}</Button>}>Shot {shots.indexOf(blockedStills[0])+1} cannot start from a picture. Pick an image-to-video workflow for it to use its frame.</Notice>}
    {pending&&<Notice priority={70} title="Frame request awaiting confirmation" actions={<Button variant="secondary" disabled={!canEdit||busy} onClick={()=>void generate()}>Retry confirmation</Button>}>Retrying reuses the same request, so only one frame is drawn.</Notice>}
    {frameable&&(chosen||candidate)&&<ShotFrame state={frameState} src={candidate?.output_ids[0]?assetUrl(workspace,candidate.output_ids[0]):undefined} running={candidate&&<RunDevelop workspaceId={workspace} run={stillRun(candidate)}/>} take={candidates.length>1?`${takeIndex+1} / ${candidates.length}`:undefined} disabled={!canEdit||busy} drawDisabledReason={generationReason}
      onDraw={canEdit?()=>void generate(selected):undefined} onRetake={canEdit?()=>void generate(selected):undefined}
      onUse={canEdit&&!disabled?()=>void approve():undefined} onReject={canEdit&&!disabled?()=>void reject():undefined} onCancel={canEdit?()=>void cancel():undefined}
      onPrev={takeIndex>0?()=>setCandidateId(candidates[takeIndex-1].id):undefined} onNext={takeIndex>=0&&takeIndex<candidates.length-1?()=>setCandidateId(candidates[takeIndex+1].id):undefined}
      onSettings={canEdit&&manifests.length>0?()=>setAdvanced(true):undefined}/>}
    {settings}
    {frameable&&candidateProblem&&<Notice priority={60} title={candidateProblem.title||"This frame did not finish"} actions={<Button variant="secondary" disabled={!canEdit||busy||!!generationReason} onClick={()=>void generate(selected)}>New take</Button>} details={candidate?.error??undefined}>{candidateProblem.text}</Notice>}
    {takeProblem&&<Notice priority={60} title={takeProblem.title||"Frames need attention"} actions={<Button variant="ghost" disabled={busy} onClick={()=>setRefresh(v=>v+1)}>Check again</Button>} details={error}>{takeProblem.text}</Notice>}
  </>;
}
