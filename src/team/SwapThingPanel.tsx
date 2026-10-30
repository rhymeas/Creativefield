import {WorkflowDescription} from "./workflow-info";
import {useEffect,useRef,useState,type ReactNode} from "react";
import {Button,GenerateButton,Meta,ModelCard,Notice,PromptField,TextField,UploadSlot} from "../ds";
import {assetUrl,composerAssets,workspacePath,type Asset,type Call,type Project,type Workspace} from "./api";
import {LibraryChoice} from "./LibraryChoice";
import {TeamMediaInput} from "./TeamMediaInput";
import {reelForManifest} from "./reels";
import {buildSwapSteps,swapClipProblem,swapEditStep,swapThingProblem,EDIT_CAPABILITY,type SwapThingInput} from "./swap-thing";
import {cancelSwapRun,runSwapAttempt,type TrackedStep} from "./swap-run";
import {beginChain,chainKey,clearChain,failedStep,readChain,saveChain,saveStep,type ChainRecord,type SavedInput} from "./replace-chain";

/** The one fact the video drop zone says: the longest clip it takes (CLIP_ENVELOPE holds the full envelope). */
const CLIP_HINT="Drop a video, up to 5 s";

/** The run loop names a step "Find the red car…"; while it works the panel says "Finding the red car…". */
export function progressLabel(label:string):string{
  if(label.startsWith("Find "))return `Finding ${label.slice(5)}`;
  if(label.startsWith("Change "))return `Changing ${label.slice(7)}`;
  return label;
}

/** Swap a thing: a video, the name of what to change, an optional picture of what it becomes, an optional sentence.
 * Nobody draws, uploads or reviews a mask: the app finds it in the background and goes straight on to the change.
 * A chain this tab saved before a reload comes back with its form, its found mask and its attempt number. */
export function SwapThingPanel({workspace,project,workerId,call,canEdit,onChanged,top,promptOnly,initialVideo}:{workspace:Workspace;project:Project;workerId:string;call:Call;canEdit:boolean;onChanged:()=>void;top?:ReactNode;/** Edit a video with one sentence: what to find and what it becomes are read from the prompt. */promptOnly?:boolean;/** A clip dropped on another screen. */initialVideo?:string}){
  const storage=typeof sessionStorage==="undefined"?null:sessionStorage,key=chainKey(promptOnly?"edit":"swap",workspace.id,project.id);
  const [chain,setChain]=useState<ChainRecord|null>(()=>{const kept=readChain(storage,key);return initialVideo&&kept?.input.video!==initialVideo?null:kept;});
  const [assets,setAssets]=useState<Asset[]>([]),[video,setVideo]=useState(()=>initialVideo??chain?.input.video??""),[reference,setReference]=useState(()=>chain?.input.reference??""),[target,setTarget]=useState(()=>chain?.input.target??""),[prompt,setPrompt]=useState(()=>chain?.input.prompt??"");
  const [busy,setBusy]=useState(""),[error,setError]=useState(""),[failed,setFailed]=useState(false),[,setDoing]=useState(""),[runId,setRunId]=useState<string|null>(null),[cancelling,setCancelling]=useState(false);
  const attempt=useRef(chain?.attempt??0),cancelled=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{void composerAssets(call,workspace.id,project.id,[]).then(page=>{if(alive.current)setAssets(page.items);}).catch(()=>{});},[call,workspace.id,project.id]);
  async function upload(file:File,kind:"image"|"video"){
    const form=new FormData();form.append("file",file);
    const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${encodeURIComponent(project.id)}&kind=${kind}`),"POST",form);
    setAssets(old=>[asset,...old.filter(a=>a.id!==asset.id)]);onChanged();return asset.id;
  }
  async function guard(task:string,work:()=>Promise<void>,step?:string){setBusy(task);setError("");try{await work();}catch(e){if(alive.current)setError((step?swapClipProblem(step,e):undefined)??(e as Error).message);}finally{if(alive.current)setBusy("");}}
  // A new clip, thing or sentence is a new request: the saved chain no longer applies.
  const edited=()=>{planned.current=null;setChain(null);clearChain(storage,key);};

  const swapInput={video,target,reference:reference||undefined,prompt},source=assets.find(asset=>asset.id===video);
  const input:SavedInput={video,target,reference,prompt};
  // In prompt-only editing the sentence is read once per request; the reading drives the chain.
  const planned=useRef<SwapThingInput|null>(null);
  const req=()=>planned.current??swapInput,saved=():SavedInput=>planned.current?{video,target:planned.current.target,reference:planned.current.reference??"",prompt:planned.current.prompt??""}:input;

  /** Find the thing with the run loop, then stop and show the mask. Every press is a new attempt, so Try again
   * queues new runs; a press after a reload reaches the run it already queued. Cancel stops the run that is working. */
  const generate=()=>guard("run",async()=>{
    cancelled.current=false;setFailed(false);setCancelling(false);
    // A mask this chain already found is not found again: it is shown for review.
    if(chain?.outputs.mask){const asset=await call<Asset>(workspacePath(workspace.id,`assets/${encodeURIComponent(chain.outputs.mask)}`));await runChange(asset);return;}
    const resuming=!!chain&&chain.stepIndex===0&&!!chain.runIds.mask;
    if(!resuming)attempt.current+=1;
    if(promptOnly&&!chain&&!planned.current){
      const plan=await call<{target:string;prompt:string;reference?:number;problems:string[]}>(workspacePath(workspace.id,"edit-plan"),"POST",{prompt,images:reference?1:0});
      if(plan.problems.length)throw new Error(plan.problems.join(" "));
      planned.current={video,target:plan.target,reference:plan.reference&&reference?reference:undefined,prompt:plan.prompt};
    }
    const record=chain??beginChain({requestId:crypto.randomUUID(),attempt:attempt.current,input:saved(),steps:buildSwapSteps(req())});
    if(!chain){saveChain(storage,key,record);if(alive.current)setChain(record);}
    let maskRun="",found:Asset|null=null;
    try{
      const [find]=record.steps as TrackedStep[];
      const outputs=await runSwapAttempt({call,workspaceId:workspace.id,projectId:project.id,workerId,attempt:record.attempt,
        steps:[find],
        onStep:label=>{if(alive.current)setDoing(progressLabel(label));},
        onRun:id=>{if(id)maskRun=id;if(alive.current)setRunId(id);},
        onChanged,alive:()=>alive.current});
      const next=saveStep(record,"mask",maskRun,outputs.mask);
      saveChain(storage,key,next);if(alive.current)setChain(next);
      found=await call<Asset>(workspacePath(workspace.id,`assets/${outputs.mask}`));
    }catch(e){
      // The mask that was not found is not fetched again: the next press names a new run.
      const kept=failedStep(record,"mask");attempt.current=kept.attempt;saveChain(storage,key,kept);if(alive.current)setChain(kept);
      if(cancelled.current)return;if(alive.current)setFailed(true);throw e;
    }
    if(found)await runChange(found);
  },"mask");

  /** The mask is found in the background and used at once: change only its area, with that exact mask. */
  async function runChange(approved:Asset){
    setFailed(false);setCancelling(false);
    const record=readChain(storage,key)??chain??beginChain({requestId:crypto.randomUUID(),attempt:attempt.current,input:saved(),steps:buildSwapSteps(req())});
    let editRun="";
    try{
      const outputs=await runSwapAttempt({call,workspaceId:workspace.id,projectId:project.id,workerId,attempt:record.attempt,
        steps:[swapEditStep(req(),approved.id)],
        onStep:label=>{if(alive.current)setDoing(progressLabel(label));},
        onRun:id=>{if(id)editRun=id;if(alive.current)setRunId(id);},
        onChanged,alive:()=>alive.current});
      saveStep(record,"edit",editRun,outputs.edit);
      clearChain(storage,key);if(alive.current)setChain(null);
    }catch(e){
      const kept=failedStep(record,"edit");attempt.current=kept.attempt;saveChain(storage,key,kept);if(alive.current)setChain(kept);
      if(cancelled.current)return;if(alive.current)setFailed(true);throw e;
    }
  }
  async function cancel(){if(!runId||busy||cancelling)return;setBusy("cancel");cancelled.current=true;try{await cancelSwapRun(call,workspace.id,runId);if(alive.current)setCancelling(true);}catch(e){cancelled.current=false;if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy("");}}

  const reason=!canEdit?"Sign in to make videos.":(promptOnly?(!video?"Add your video.":!prompt.trim()?"Say what to change.":undefined):swapThingProblem({video,target,reference,prompt}));
  const locked=!!busy||!canEdit;
  return <div className="cf-form"><WorkflowDescription title="Video editing"><Meta>Choose a source clip and describe the change. Mask preparation and source normalization are part of the selected local editing route.</Meta></WorkflowDescription>
    {top}
    {!promptOnly&&<ModelCard title="Swap a thing" subtitle="Local" video={reelForManifest(EDIT_CAPABILITY.id)}/>}
    <>
      <TeamMediaInput label="Your video" type="video" hint={CLIP_HINT} file={null} selected={source} options={assets.filter(a=>a.media_type==="video")} disabled={locked} canUpload={canEdit}
        onFile={file=>{if(file)void guard("upload",async()=>{setVideo(await upload(file,"video"));edited();});}} onSelect={id=>{setVideo(id);edited();}} onUpload={()=>{}} workspace={workspace.id}/>
      {!promptOnly&&<TextField label="What to change" value={target} disabled={locked} onChange={value=>{setTarget(value);edited();}} placeholder="the red car"/>}
      <UploadSlot label={promptOnly?"Add elements or references":"New thing"} hint={promptOnly?"Optional. Call it @Image 1 in the prompt":"Optional"} accept="image/png,image/jpeg,image/webp" kinds={["image"]} preview={reference?assetUrl(workspace.id,reference):null} previewKind="image" removeLabel="Remove picture" disabled={locked}
        onFile={file=>{if(!file){setReference("");edited();}else void guard("upload",async()=>{setReference(await upload(file,"image"));edited();});}}/>
      {!reference&&assets.some(a=>a.media_type==="image")&&<LibraryChoice value="" disabled={locked} options={assets.filter(a=>a.media_type==="image").map(a=>({value:a.id,label:a.name,preview:{src:assetUrl(workspace.id,a.id)}}))} onChange={id=>{setReference(id);edited();}}/>}
      <PromptField label="Prompt" value={prompt} disabled={locked} onChange={value=>{setPrompt(value);edited();}} placeholder={promptOnly?"Describe what to change, for example: make his jacket red.":"Optional. What it becomes."}/>
      {error&&<Notice title="The change didn't start" actions={<Button variant="secondary" disabled={!!busy||!!reason} onClick={()=>void generate()}>Try again</Button>} details={error}>Nothing was sent twice: trying again reuses the same request and pictures.</Notice>}
      {chain&&chain.stepIndex>0&&<Meta>Picks up where your last run stopped.</Meta>}
      <GenerateButton label={busy==="run"?"Generating…":failed?"Try again":chain?"Continue":"Generate"} busy={busy==="run"} disabled={!!busy||!!reason} disabledReason={reason} onClick={()=>void generate()}/>
      {runId&&<Button variant="secondary" disabled={!!busy||cancelling} onClick={()=>void cancel()}>{busy==="cancel"||cancelling?"Cancelling…":"Cancel"}</Button>}
    </>
  </div>;
}
