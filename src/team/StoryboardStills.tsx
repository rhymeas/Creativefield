import {useEffect,useMemo,useState} from "react";
import {Button,Dialog,IconButton,Meta,Notice,ResultTile,Row,SectionHeader,TextField,Toolbar,Tooltip} from "../ds";
import {Check,Info,X} from "lucide-react";
import type {CapabilityManifestV2} from "../capabilities/types";
import {ApiError,assetUrl,workspacePath,type Call,type Run,type Worker} from "./api";
import {activeRun,defaultDraft,draftErrors,runLabel,workerReadiness} from "./state";
import {plainProblem} from "./problems";
import {TeamChoice} from "./TeamChoice";
import {RunDevelop} from "./RunDevelop";
import type {Shot} from "./storyboard-state";

export type StillTake={id:string;plan_key:string;prompt:string;child_run_id:string;state:string;error:string|null;output_ids:string[];approved_asset_id:string|null;approved_at:string|null;rejected_at?:string|null;created_at:string;scene:number;shot:number;take:number};
type Intent={revision:number;workerId:string;idempotencyKey:string;capabilityId:string;version:string;controls:Record<string,string|number|boolean>;planKeys?:string[]};
export function approvedTakes(shots:Shot[],takes:StillTake[]){return Object.fromEntries(shots.flatMap(s=>{const t=takes.filter(t=>t.plan_key===s.key&&t.prompt===s.prompt&&t.approved_asset_id&&t.state==="succeeded").sort((a,b)=>(b.approved_at??"").localeCompare(a.approved_at??""))[0];return t?[[s.key,t]]:[];}));}
export function stillRun(t:StillTake):Run{return {id:t.child_run_id,project_id:"",created_by:"",capability_id:"",capability_version:"",state:t.state,error:t.error,output_ids:t.output_ids,scene:t.scene,shot:t.shot,take:t.take,created_at:t.created_at,updated_at:t.created_at};}

export function StoryboardStills({boardId,workspace,revision,shots,selected,catalogue,workers,call,authorized,canEdit,disabled,storageKey,onTakes,onAssets,onSelectShot}:{boardId:string;workspace:string;revision:number;shots:Shot[];selected:string;catalogue:CapabilityManifestV2[];workers:Worker[];call:Call;authorized:boolean;canEdit:boolean;disabled:boolean;storageKey:string;onTakes:(t:StillTake[])=>void;onAssets:(ids:string[])=>void;/** Takes the panel to the shot that needs a different workflow, so its fix is one click away. */onSelectShot:(key:string)=>void}){
  const manifests=useMemo(()=>catalogue.filter(m=>m.category==="image"&&m.coverage.local==="implemented"&&!m.imageArtifacts&&!m.outputContract&&(m.inputs.every(p=>!p.required)||(m.inputs.filter(p=>p.required).length===1&&m.inputs.filter(p=>p.required)[0].type==="image"))),[catalogue]);
  const [advanced,setAdvanced]=useState(false),[overrides,setOverrides]=useState<Record<string,Record<string,string|number|boolean>>>({});
  const [model,setModel]=useState(""),[workerId,setWorkerId]=useState(""),[takes,setTakes]=useState<StillTake[]>([]),[candidateId,setCandidateId]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[note,setNote]=useState(""),[refresh,setRefresh]=useState(0);
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
    const intent=pending??{revision,workerId:worker!.id,idempotencyKey:crypto.randomUUID(),capabilityId:chosen!.id,version:chosen!.version,controls,...(targets?{planKeys:targets}:{})};track(intent);setBusy(true);setError("");setNote(!pending&&targets&&shots.length>targets.length?`Frames requested for ${targets.length} shot${targets.length===1?"":"s"}; ${shots.length-targets.length} without a cast picture skipped.`:"");
    try{await call(workspacePath(workspace,`storyboards/${boardId}/stills`),"POST",intent);track(null);setRefresh(v=>v+1);}catch(e){setError((e as Error).message);if(e instanceof ApiError&&e.status>=400&&e.status<500&&e.status!==401)track(null);}finally{setBusy(false);}
  }
  const current=shots.find(s=>s.key===selected),candidates=takes.filter(t=>t.plan_key===selected&&t.prompt===current?.prompt),candidate=candidates.find(t=>t.id===candidateId)??candidates[0],approved=approvedTakes(shots,takes),accepted=approved[selected];
  /* A failed frame is said in everyday words; the raw message waits behind Details. */
  const candidateProblem=candidate?.error?plainProblem(candidate.error):null,takeProblem=error?plainProblem(error):null;
  const blockedStills=shots.filter(s=>{const approval=approvedTakes([s],takes)[s.key];if(!approval)return false;const cap=catalogue.find(m=>m.id===s.settings.generation?.capabilityId);if(!cap||cap.inputs.some(p=>p.id==="start_image"))return false;const base=cap.id.endsWith("-t2v")?cap.id.slice(0,-4):undefined;const sibling=base?catalogue.find(m=>m.id===base&&m.inputs.some(p=>p.id==="start_image")):undefined;return !sibling;});
  async function approve(){if(!candidate||busy||!canEdit||disabled)return;setBusy(true);setError("");try{await call(workspacePath(workspace,`storyboards/${boardId}/stills/${candidate.id}/approve`),"POST",{});setRefresh(v=>v+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function reject(){if(!candidate||busy||!canEdit||disabled)return;setBusy(true);setError("");try{await call(workspacePath(workspace,`storyboards/${boardId}/stills/${candidate.id}/reject`),"POST",{});setRefresh(v=>v+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function cancel(){if(!candidate||busy||!canEdit)return;setBusy(true);try{await call(workspacePath(workspace,`runs/${candidate.child_run_id}/cancel`),"POST",{});setRefresh(v=>v+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const generationReason=!canEdit?"Creator access is required.":busy?"Wait for the current action to finish.":disabled?"Add a prompt to each shot and save your changes first.":live?"Frames are already being generated.":!shots.length?"Create shot cards first.":!chosen?"No compatible image workflow is installed.":!worker?"Connect a worker that can run the image workflow.":invalid[0]??(workerReadiness(chosen,worker).state!=="ready"?workerReadiness(chosen,worker).reasons[0]:undefined);
  return <div className="cf-form">
    {blockedStills.length>0&&<Notice priority={30} title="Approved frame not used" actions={<Button variant="secondary" disabled={!canEdit||busy||!!pending} onClick={()=>onSelectShot(blockedStills[0].key)}>Open shot {shots.indexOf(blockedStills[0])+1}</Button>}>Shot {shots.indexOf(blockedStills[0])+1} uses a workflow that cannot start from a picture, so its approved frame is ignored. Pick an image-to-video model for that shot to use the frame.</Notice>}
    <SectionHeader title="Storyboard frames" end={<Tooltip content="A storyboard frame is a still image that plans a shot's composition. Generate candidates, then approve one to guide that shot's video. A new take keeps the approved frame until you replace it."><IconButton label="About storyboard frames"><Info size={14}/></IconButton></Tooltip>}/>
    <Meta>Frames are drawn from the shot text only, so they do not carry a saved character's face. Approving one makes it that shot's first picture.</Meta>
    {current?.settings.elementInputs.start_image&&<Meta>This shot already starts from its cast picture; approving a frame replaces that picture for this shot.</Meta>}
    <Row label="Advanced settings" display="Optional" disabled={!canEdit||busy||!!pending||live} onClick={()=>setAdvanced(true)}/>
    <Dialog open={advanced&&authorized} title="Advanced still settings" onClose={()=>setAdvanced(false)} footer={<Button onClick={()=>setAdvanced(false)}>Done</Button>}><div className="cf-form">
      <TeamChoice label="Still workflow" display={chosen?.title??"No local still workflow"} value={chosen?.id??""} options={manifests.map(m=>({value:m.id,label:m.title}))} disabled={!canEdit||busy||!!pending||live} onChange={setModel}/>
      <TeamChoice label="Still worker" display={worker?.name??"Choose a worker"} value={worker?.id??""} options={workers.map(w=>({value:w.id,label:w.name,note:chosen?workerReadiness(chosen,w).reasons.join(" "):"Choose a workflow"}))} disabled={!canEdit||busy||!!pending||live} onChange={setWorkerId}/>
      {chosen?.controls.filter(c=>["width","height","steps","seed"].includes(c.id)&&!c.disabledReason).map(c=><TextField key={c.id} label={c.label} type="number" min={c.min} max={c.max} step={c.step??1} disabled={!canEdit||busy||!!pending||live} value={String(controls[c.id]??"")} onChange={value=>setOverrides(old=>({...old,[chosen.id]:{...old[chosen.id],[c.id]:value===""?"":Number(value)}}))}/>)}
      {invalid.length>0&&<Notice inline priority={20} title="Check still settings">{invalid.join(" ")}</Notice>}
    </div></Dialog>
    {pending&&<Notice priority={70} title="Still request awaiting confirmation" actions={<Button variant="secondary" disabled={!canEdit||busy} onClick={()=>void generate()}>Retry confirmation</Button>}>The saved shot prompts, workflow and request identifier are frozen, so retrying records one frame request instead of two.</Notice>}
    <Button variant="secondary" disabledReason={generationReason} disabled={!canEdit||busy||(!pending&&(disabled||live||!!invalid.length||!shots.length||!worker||!chosen||workerReadiness(chosen,worker).state!=="ready"))} onClick={()=>void generate()}>{pending?"Confirm frame request":"Generate frames"}</Button>
    {note&&<Meta>{note}</Meta>}
    {candidate&&<>
      <TeamChoice label="Frame take" display={`Take ${candidate.take} · ${runLabel[candidate.state]??candidate.state}`} value={candidate.id} options={candidates.map(t=>({value:t.id,label:`Take ${t.take} · ${runLabel[t.state]??t.state}${t.approved_at?" · approved":t.rejected_at?" · rejected":""}`}))} disabled={busy} onChange={setCandidateId}/>
      {candidate.state==="succeeded"&&candidate.output_ids[0]?<ResultTile caption={accepted?.id===candidate.id?"Approved":candidate.rejected_at?"Rejected":"Candidate"}><img src={assetUrl(workspace,candidate.output_ids[0])} alt={`Still for shot ${candidate.shot}`}/></ResultTile>:<RunDevelop workspaceId={workspace} run={stillRun(candidate)}/>}
      {candidateProblem&&<Notice priority={60} title={candidateProblem.title||"This frame did not finish"} actions={<Button variant="secondary" disabled={!canEdit||disabled||busy||live||!!pending||!!invalid.length||!worker||!chosen||workerReadiness(chosen,worker).state!=="ready"} onClick={()=>void generate(selected)}>New take</Button>} details={candidate.error??undefined}>{candidateProblem.text}</Notice>}
      <Toolbar>
      {activeRun(candidate.state)?<Button variant="secondary" disabled={!canEdit||busy||candidate.state==="cancel_requested"} onClick={()=>void cancel()}>Cancel frame</Button>:<IconButton label={candidate.approved_at?"Frame approved":candidate.rejected_at?"Frame rejected":"Approve frame"} disabled={!canEdit||disabled||busy||candidate.state!=="succeeded"||!!candidate.approved_at||!!candidate.rejected_at} onClick={()=>void approve()}><Check size={16}/></IconButton>}
      {candidate.state==="succeeded"&&!candidate.approved_at&&!candidate.rejected_at&&<IconButton label="Reject candidate" disabled={!canEdit||disabled||busy} onClick={()=>void reject()}><X size={16}/></IconButton>}
      {!activeRun(candidate.state)&&<Button variant="ghost" disabledReason={generationReason} disabled={!canEdit||disabled||busy||live||!!pending||!!invalid.length||!worker||!chosen||workerReadiness(chosen,worker).state!=="ready"} onClick={()=>void generate(selected)}>New take</Button>}
      </Toolbar>
      {accepted&&accepted.id!==candidate.id&&<Meta>The pinned frame remains take {accepted.take}; this candidate has not replaced it.</Meta>}
    </>}
    {takeProblem&&<Notice priority={60} title={takeProblem.title||"Frames need attention"} actions={<Button variant="ghost" disabled={busy} onClick={()=>setRefresh(v=>v+1)}>Check again</Button>} details={error}>{takeProblem.text}</Notice>}
  </div>;
}
