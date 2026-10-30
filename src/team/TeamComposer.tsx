import {WorkflowDescription} from "./workflow-info";
import {TeamMediaInput} from "./TeamMediaInput";
import {DEFAULT_MIN_FREE_SHARE} from "../capabilities/hardware";
import {endFramePair,endFrameRoute,isEndFrameVariant,withOptionalEndImage} from "./end-frame";
import {lazy,Suspense,useCallback,useEffect,useMemo,useRef,useState,type ReactNode} from "react";
import { UploadSlot, Button, SegmentedTabs, useToast, Checkbox, TextField, Collapsible, GenerateButton, Meta, Notice, Panel, PromptField, Params, ParamButton, ReferenceTray, Row, Rule, Thumb, ToggleRow, Dialog, ShimmerText, GestureStage, CameraPathPreview, LinkButton, PresetGrid, PresetCard, HowItWorks } from "../ds";
import {Clock,Gauge,Sparkles,Video,Volume2,WandSparkles} from "lucide-react";
import {catalogueTitles} from "./job-queue";
import {ToolHero} from "./heroes";
import type {CapabilityManifestV2} from "../capabilities/types";
import {ApiError,assetUrl,workspacePath,composerAssets,mergeAssets,type Asset,type Call,type Project,type ReusableElement,type User,type Worker,type Workspace} from "./api";
import {defaultDraft,draftErrors,draftKey,promptOptional,soleReadyWorker,submissionIntent,workerReadiness,type Draft} from "./state";
import {plainProblem,plainReasons,workerBlocker} from "./problems";
import {audienceOf,settingsLabel} from "./audience";
import {TeamRuns} from "./TeamLibrary";
import {effectGuide,effectPromptCopy} from "./effect-guides";
import {TeamChoice,type TeamChoiceOption} from "./TeamChoice";
import {assetMatchesPort} from "../capabilities/assets";
import {clearMaskForSource,isMaskedEdit,matchingMask} from "./masked-state";
import {MaskHowItWorks} from "./mask-how-it-works";
import {MASK_EDIT_IDEAS} from "./video-mask/edit-ideas";
import {TrackedMaskReview} from "./video-mask/TrackedMaskReview";
import {RegionMaskCreator} from "./video-mask/RegionMaskCreator";
import {beginOperation,finishOperation,invalidateOperation,operationGate,ownsOperation} from "./operation-gate";
import {chooseElementInput,compatibleElementOptions} from "./element-selection";
import {capabilitySurface} from "../capabilities/surfaces";
import {secondsToWanFrames} from "../workflow/build";
import {WAN_ANIMATE_MAX_DESIRED_FRAMES} from "../capabilities/motion";
import {reelForManifest,reelForSection} from "./reels";
import {nativeCameraGesture,nativeCameraMoves,nativeCameraPose} from "./camera-controls";
import {cameraPair,cameraRoute as cameraPathRoute} from "./camera-route";

const VoicePreview=lazy(()=>import("./audio/VoicePreview").then(module=>({default:module.VoicePreview})));
const PosePreview=lazy(()=>import("./performance/PosePreview").then(module=>({default:module.PosePreview})));
const MaskCorrectionEditor=lazy(()=>import("./video-mask/MaskCorrectionEditor").then(module=>({default:module.MaskCorrectionEditor})));
const TwoRegionEditor=lazy(()=>import("./video-mask/TwoRegionEditor").then(module=>({default:module.TwoRegionEditor})));

type Intent={projectId:string;workerId:string;idempotencyKey:string;capabilityId:string;version:string;routeId:string;inputs:Record<string,string>;elementInputs:Draft["elementInputs"];controls:Draft["controls"];audioPolicy:Draft["audioPolicy"];presetId?:string;consent?:{webcam?:boolean;voice?:boolean}};
function readDraft(key:string,m:CapabilityManifestV2):Draft {const draft=defaultDraft(m);try{const saved=JSON.parse(localStorage.getItem(key)??"null");if(saved&&saved.controls&&saved.inputs&&typeof saved.controls==="object"&&typeof saved.inputs==="object"){
  for(const c of m.controls){const v=saved.controls[c.id];if(!c.disabledReason&&["string","number","boolean"].includes(typeof v))draft.controls[c.id]=v;}
  for(const p of m.inputs)if(typeof saved.inputs[p.id]==="string")draft.inputs[p.id]=saved.inputs[p.id];
  if(saved.elementInputs&&typeof saved.elementInputs==="object")for(const p of m.inputs){const binding=saved.elementInputs[p.id];if(binding&&typeof binding.elementId==="string"&&typeof binding.assetId==="string"&&!draft.inputs[p.id])draft.elementInputs[p.id]={elementId:binding.elementId,assetId:binding.assetId};}
  if(m.audioPolicies.includes(saved.audioPolicy))draft.audioPolicy=saved.audioPolicy;
  if(typeof saved.presetId==="string"&&m.presets.some(preset=>preset.id===saved.presetId))draft.presetId=saved.presetId;
}}catch{}return draft;}
function readIntent(key:string):Intent|null {try{return JSON.parse(sessionStorage.getItem(`${key}:intent`)??"null");}catch{return null;}}
const mediaLabels:Record<string,string>={start_image:"Start image",end_image:"End image",motion_video:"Motion video",source_video:"Source clip",edit_mask:"Mask"};
const audioLabels:Record<string,string>={preserve:"Preserve source",mute:"Mute",replace:"Replace",mix:"Mix"};
const CAMERA_MOVES=[
  {id:"pan-left",label:"Pan left",instruction:"The camera slowly pans left."},
  {id:"pan-right",label:"Pan right",instruction:"The camera slowly pans right."},
  {id:"pan-up",label:"Pan up",instruction:"The camera slowly tilts up."},
  {id:"pan-down",label:"Pan down",instruction:"The camera slowly tilts down."},
  {id:"zoom-in",label:"Zoom in",instruction:"The camera slowly zooms in."},
  {id:"zoom-out",label:"Zoom out",instruction:"The camera slowly zooms out."},
] as const;
/** The speed control runs 0–10; half steps keep the compact menu short. */
export const CAMERA_SPEEDS=Array.from({length:21},(_,index)=>index/2);
/** A frame size said the way the clip comes out: width × height, e.g. 480 × 848. */
export function resolutionLabel(width:number,height:number){return `${width} × ${height}`;}
/** A row that offers a single option is not a choice; only a real audio decision earns the Audio button. */
export const audioChoice=(manifest:CapabilityManifestV2)=>manifest.audioPolicies.length>1;
/** The Advanced dialog holds the settings the panel keeps out of sight. Motion adds its pose text and its negative prompt. */
export function advancedControls(manifest:CapabilityManifestV2,motionRoute:boolean,nativeCamera:boolean){
  const inline=["width","height","length","prompt","seed",...(nativeCamera?["camera_pose","speed"]:[])];
  return manifest.controls.filter(control=>!inline.includes(control.id)&&(motionRoute?control.id==="motion_prompt"||control.id==="negative":control.id!=="motion_prompt"));
}
/** Lip sync is an audio tool, so Create Video leaves it out; a workflow already open stays in its own list. */
export const createVideoCandidate=(manifest:CapabilityManifestV2,openId?:string)=>capabilitySurface(manifest)==="video-create"&&(!manifest.voiceContract||manifest.id===openId);
/** The first sentence of a workflow's description, short enough for one line under its name in the Model list. */
export function firstSentence(text:string){
  const clean=text.trim().replace(/\s+/g," "),end=clean.search(/\.\s/),first=(end>0?clean.slice(0,end):clean).replace(/\.$/,"");
  return first.length>90?`${first.slice(0,87).trimEnd()}…`:first;
}
/** Motion transfer runs at 24 FPS and is exactly as long as the driving clip, up to the 641-frame cap. */
export const MOTION_MAX_CLIP_SECONDS=WAN_ANIMATE_MAX_DESIRED_FRAMES/24;
export function motionClipNotice(seconds:number|null){
  return seconds!==null&&Number.isFinite(seconds)&&seconds>MOTION_MAX_CLIP_SECONDS?`This clip is too long. Use up to ${Math.floor(MOTION_MAX_CLIP_SECONDS)} seconds.`:null;
}

export function TeamComposer({manifest:chosenManifest,catalogue,onCapability,user,workspace,project,workers,call,canQueue,authorized,onQueued,workflowIds,top,initialInputs,onUseImage,workflowInfo,onWorkerSettings,onModels,onRunLocal}:{workflowInfo?:ReactNode;initialInputs?:Record<string,string>;onUseImage?:(assetId:string)=>void;manifest:CapabilityManifestV2;catalogue:CapabilityManifestV2[];onCapability:(id:string)=>void;user:User;workspace:Workspace;project:Project;workers:Worker[];call:Call;canQueue:boolean;authorized:boolean;onQueued:()=>void;/** Restrict the workflow picker, for a workspace with clearly separated modes. */workflowIds?:string[];/** Shown first in the panel, e.g. the Change page's choice of tool. */top?:ReactNode;/** The place that registers ComfyUI, so a missing worker can be added from here. */onWorkerSettings?:()=>void;/** The models and nodes a workflow needs, so a missing file can be added from here. */onModels?:()=>void;/** The same run on this computer, when the chosen cloud route cannot start. */onRunLocal?:()=>void}){
  /* The end image is optional on Wan 2.2 14B: it is one model for the person, with two graphs behind it. */
  const endPair=useMemo(()=>endFramePair(chosenManifest,catalogue),[chosenManifest,catalogue]);
  const manifest=useMemo(()=>withOptionalEndImage(chosenManifest,endPair),[chosenManifest,endPair]);
  const key=draftKey(user.id,workspace.id,project.id,manifest.id);
  /* The one person on this PC has Settings; a shared workspace calls it Team settings. */
  const settingsPlace=settingsLabel(audienceOf(user));
  const [draft,setDraft]=useState<Draft>(()=>{const d=readDraft(key,manifest);return initialInputs&&!readIntent(key)?{...d,inputs:{...d.inputs,...initialInputs}}:d;}),[pending,setPending]=useState<Intent|null>(()=>readIntent(key)),[workerId,setWorkerId]=useState(()=>soleReadyWorker(manifest,workers));
  const [files,setFiles]=useState<Record<string,File|null>>({}),[assets,setAssets]=useState<Asset[]>([]),[elements,setElements]=useState<ReusableElement[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(""),[runVersion,setRunVersion]=useState(0),[saved,setSaved]=useState("");
  const [advancedOpen,setAdvancedOpen]=useState(false);
  /* The prompt starts switched off only when the workflow already has its subject, and on as soon as
     the draft carries words of the user's own (a typed request, a restored draft). */
  const [promptOn,setPromptOn]=useState(()=>!promptOptional(manifest)||String(draft.controls.prompt??"")!==String(defaultDraft(manifest).controls.prompt??""));
  const [addingReference,setAddingReference]=useState(false);
  const [cameraMove,setCameraMove]=useState("");
  const [voiceConsent,setVoiceConsent]=useState(false);
  const [requirements,setRequirements]=useState<{state:string;missing:string[];instructions:string}|null>(null);
  const [drivingSeconds,setDrivingSeconds]=useState<number|null>(null);
  const [starting,setStarting]=useState(false),mounted=useRef(true);
  useEffect(()=>()=>{mounted.current=false;},[]);

  const assetEpoch=useRef(0),uploadGate=useRef(operationGate());
  const masked=isMaskedEdit(manifest),contract=manifest.mediaContract;
  const [maskMethod,setMaskMethod]=useState<"track"|"upload">("track");
  const [trackingBusy,setTrackingBusy]=useState(false),[multiEditBusy,setMultiEditBusy]=useState(false),[correctionBusy,setCorrectionBusy]=useState(false);
  const closeAdvanced=useCallback(()=>setAdvancedOpen(false),[]);
  useEffect(()=>{try{localStorage.setItem(key,JSON.stringify(draft));}catch{setError("Draft could not be saved in this browser.");}},[key,draft]);
  /* A picture or clip sent here from the full view arrives as a new draft; an open composer takes it at once. */
  useEffect(()=>{const take=(event:Event)=>{if((event as CustomEvent<string>).detail===key)setDraft(readDraft(key,manifest));};addEventListener("cf-draft-preset",take);return()=>removeEventListener("cf-draft-preset",take);},[key,manifest]);
  const selectedIds=JSON.stringify(Object.values(draft.inputs).sort());
  useEffect(()=>{if(!authorized)return;const current=++assetEpoch.current;void composerAssets(call,workspace.id,project.id,JSON.parse(selectedIds) as string[]).then(page=>{if(current===assetEpoch.current)setAssets(page.items);}).catch(e=>{if(current===assetEpoch.current)setError((e as Error).message);});return()=>{assetEpoch.current++;};},[call,workspace.id,project.id,authorized,selectedIds]);
  useEffect(()=>{if(!authorized){setElements([]);return;}let current=true;void call<ReusableElement[]>(workspacePath(workspace.id,`elements?projectId=${encodeURIComponent(project.id)}`)).then(value=>{if(current)setElements(value);}).catch(e=>{if(current)setError((e as Error).message);});return()=>{current=false;};},[call,workspace.id,project.id,authorized]);
  useEffect(()=>{if(authorized)return;invalidateOperation(uploadGate.current);setBusy("");},[authorized,workspace.id,project.id,manifest.id]);
  useEffect(()=>{if(!authorized||!masked)return;let current=true;setRequirements(null);void call<{state:string;missing:string[];instructions:string}>(workspacePath(workspace.id,"masked-edit-requirements")).then(value=>{if(current)setRequirements(value);}).catch(e=>{if(current)setError((e as Error).message);});return()=>{current=false;};},[authorized,masked,call,workspace.id]);
  useEffect(()=>{setWorkerId(id=>workers.some(w=>w.id===id)?id:soleReadyWorker(manifest,workers));},[workers,manifest]);

  const worker=workers.find(w=>w.id===workerId),readiness=worker?workerReadiness(manifest,worker):null;
  /* The catalogue shows this in an info popover; the screen where a run is queued should say it outright. */
  const workerHardware=worker?.inventory?.hardware,ramTotal=workerHardware?.ramTotal??0,ramFree=workerHardware?.ramFree??null,memoryTight=ramFree!==null&&ramTotal>0&&ramFree/ramTotal<=(workerHardware?.minFreeShare??DEFAULT_MIN_FREE_SHARE);
  const missing=manifest.inputs.filter(port=>port.required&&!draft.inputs[port.id]&&!draft.elementInputs[port.id]);
  const ready=readiness?.state==="ready"&&manifest.coverage.local==="implemented"&&(!masked||requirements?.state==="ready");
  /* A stopped ComfyUI is the usual reason a model cannot run here. The screen stays open, names it and
     starts it, then waits for the worker to answer so nobody reloads (rule 36). */
  const sleeping=ready?undefined:worker?(readiness?.state==="offline"?worker:undefined):workers.filter(w=>workerReadiness(manifest,w).state==="offline").sort((a,b)=>Number(!!b.can_start)-Number(!!a.can_start)||Number(b.enabled)-Number(a.enabled))[0];
  /* One cause, said once, in the problem bar, carrying the one action that clears it (rules 36, 42).
     The Generate button does not repeat it: its footer line covers this draft only. */
  const blocker=workerBlocker({worker,workers,readiness,offlineWorker:sleeping,starting,settings:settingsPlace,canRunLocal:!!onRunLocal});
  async function startComfy(target=sleeping){
    if(!target)return;
    setStarting(true);setError("");
    try{
      await call(workspacePath(workspace.id,`workers/${target.id}/start`),"POST");
      for(let tries=0;tries<45&&mounted.current;tries++){
        await new Promise(resolve=>setTimeout(resolve,4000));
        const result=await call<{inventory:{online?:boolean}}>(workspacePath(workspace.id,`workers/${target.id}/probe`),"POST").catch(()=>null);
        if(result?.inventory.online)break;
      }
      onQueued();
    }catch(e){if(mounted.current)setError((e as Error).message);}
    finally{if(mounted.current)setStarting(false);}
  }
  /* The cause clears on its own: the screen rechecks when it comes back into view, with no reload. */
  useEffect(()=>{
    if(!blocker||starting)return;
    const recheck=()=>{if(document.visibilityState!=="hidden")onQueued();};
    addEventListener("focus",recheck);document.addEventListener("visibilitychange",recheck);
    return()=>{removeEventListener("focus",recheck);document.removeEventListener("visibilitychange",recheck);};
  },[blocker?.title,starting,onQueued]);
  /** The one action the current cause carries, labelled with its own verb. */
  function blockerAction(){
    if(!blocker)return undefined;
    const fix=blocker.fix;
    if(fix.kind==="start-comfy")return <Button variant="secondary" disabled={starting} onClick={()=>void startComfy(sleeping??worker)}>{starting?"Starting…":fix.label}</Button>;
    if(fix.kind==="connect-comfy"||fix.kind==="open-settings")return onWorkerSettings?<Button variant="secondary" onClick={onWorkerSettings}>{fix.kind==="connect-comfy"?fix.label:"Open worker settings"}</Button>:undefined;
    if(fix.kind==="open-models")return <Button variant="secondary" onClick={()=>{if(onModels)onModels();else onQueued();}}>Open Models</Button>;
    if(fix.kind==="run-local")return onRunLocal?<Button variant="secondary" onClick={onRunLocal}>Run on this computer</Button>:undefined;
    return <Button variant="secondary" disabled={starting} onClick={()=>onQueued()}>Check again</Button>;
  }
  const unresolved=manifest.inputs.filter(p=>draft.inputs[p.id]&&!assets.some(a=>a.id===draft.inputs[p.id]&&assetMatchesPort(a,p)));
  const unresolvedElements=manifest.inputs.filter(port=>{const binding=draft.elementInputs[port.id];if(!binding)return false;const element=elements.find(item=>item.id===binding.elementId),asset=element?.assets.find(item=>item.id===binding.assetId);return !asset||!assetMatchesPort(asset,port);});
  const source=contract?assets.find(a=>a.id===draft.inputs[contract.sourceInput]):undefined;
  const cameraRoute=manifest.id==="wan22-i2v-14b"&&manifest.controls.some(c=>c.id==="prompt");
  const nativeMoves=nativeCameraMoves(manifest);
  const nativeCamera=nativeMoves.length>0;
  const nativePoseControl=manifest.controls.find(c=>c.id==="camera_pose");
  const nativeSpeedControl=manifest.controls.find(c=>c.id==="speed"&&!c.disabledReason);
  const cameraMoveInfo=CAMERA_MOVES.find(move=>move.id===cameraMove);
  const cameraPathModel=cameraRoute?cameraPair(chosenManifest,catalogue):undefined;
  const cameraInstruction=cameraMoveInfo?`Camera move: ${cameraMoveInfo.instruction}`:"";
  const cameraSource=cameraRoute||nativeCamera?assets.find(a=>a.id===draft.inputs.start_image):undefined;
  const motionRoute=manifest.category==="motion"&&manifest.inputs.some(port=>port.id==="motion_video");
  const drivingClip=motionRoute&&!files.motion_video?assets.find(asset=>asset.id===draft.inputs.motion_video&&asset.project_id===project.id&&asset.media_type==="video"):undefined;
  /* The result is exactly as long as the driving clip, so read its length before queueing. */
  const drivingClipId=drivingClip?.id;
  useEffect(()=>{
    setDrivingSeconds(null);
    if(!drivingClipId)return;
    let alive=true;
    const video=document.createElement("video");video.preload="metadata";video.muted=true;
    const read=()=>{if(alive)setDrivingSeconds(Number.isFinite(video.duration)?video.duration:null);};
    video.addEventListener("loadedmetadata",read);
    video.src=assetUrl(workspace.id,drivingClipId);video.load();
    return()=>{alive=false;video.removeEventListener("loadedmetadata",read);video.removeAttribute("src");video.load();};
  },[drivingClipId,workspace.id]);
  const motionNotice=motionRoute?motionClipNotice(drivingSeconds):null;
  const poseBinding=drivingClip?.sha256&&workerId?{userId:user.id,workspaceId:workspace.id,projectId:project.id,workerId,sourceAssetId:drivingClip.id,sourceSha256:drivingClip.sha256}:undefined;
  const webcamSelected=!!assets.find(asset=>asset.id===draft.inputs.motion_video)?.name.startsWith("webcam-take-");
  const selectedMask=contract?assets.find(a=>a.id===draft.inputs[contract.maskInput]):undefined;
  const voiceAudio=manifest.voiceContract?assets.find(a=>a.id===draft.inputs[manifest.voiceContract!.audioInput]):undefined;
  const maskCreator=masked?catalogue.find(item=>item.id==="sam31-video-mask"&&item.coverage.local==="implemented"):undefined;
  const trackingReady=!!maskCreator&&workers.some(candidate=>workerReadiness(maskCreator,candidate).state==="ready");
  const useTracking=trackingReady&&maskMethod==="track";
  const invalidMask=masked&&!!selectedMask&&!matchingMask(selectedMask,source,project.id,manifest);
  const errors=[...draftErrors(manifest,draft),...unresolved.map(p=>`${p.label}: select available shared ${p.type} media.`),...unresolvedElements.map(p=>`${p.label}: select an available compatible Element asset.`),...(invalidMask?["The selected mask was not validated for this exact source video."]:[]),...(manifest.voiceContract&&!voiceConsent?["Confirm permission for this portrait and voice."]:[]),...(Object.values(files).some(Boolean)?["Upload the chosen media before queueing."]:[])],valid=missing.length===0&&errors.length===0&&!motionNotice;
  const locked=!!pending||!canQueue||!!busy||trackingBusy||multiEditBusy||correctionBusy;
  useEffect(()=>{if(locked)setAdvancedOpen(false);},[locked]);
  function changeControl(id:string,value:string|number|boolean){if(locked)return;setDraft(d=>({...d,controls:{...d.controls,[id]:value}}));}
  function choosePreset(id:string){if(locked)return;setDraft(d=>({...d,presetId:d.presetId===id?undefined:id}));}
  /* Create Video always offers a clip to edit and pictures to start from, like one tool. A drop moves to the
     workflow that takes it, with the file and the words already in place. */
  /** A clip to edit goes to prompt-only editing, which finds the area itself. */
  async function editWith(file:File){
    if(locked)return;setBusy("upload");setError("");
    try{const form=new FormData();form.append("file",file);const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${encodeURIComponent(project.id)}`),"POST",form);location.hash=`video/edit/${asset.id}`;}
    catch(e){setError((e as Error).message);}finally{setBusy("");}
  }
  async function startWith(target:CapabilityManifestV2,port:string,file:File){
    if(locked)return;setBusy("upload");setError("");
    try{
      const form=new FormData();form.append("file",file);
      const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${encodeURIComponent(project.id)}`),"POST",form);
      const nextKey=draftKey(user.id,workspace.id,project.id,target.id),next=readDraft(nextKey,target);
      next.inputs[port]=asset.id;
      if(target.controls.some(control=>control.id==="prompt")&&String(draft.controls.prompt??"").trim())next.controls.prompt=draft.controls.prompt;
      localStorage.setItem(nextKey,JSON.stringify(next));onCapability(target.id);
    }catch(e){setError((e as Error).message);}finally{setBusy("");}
  }
  async function upload(role:string,chosen?:File){const file=chosen??files[role];if(!file)return false;const sourceId=contract&&role===contract.maskInput?draft.inputs[contract.sourceInput]:undefined;if(contract&&role===contract.maskInput&&!sourceId){setError("Add and upload a source clip before validating its mask.");return false;}const current=beginOperation(uploadGate.current,role);setBusy(role);setError("");try{const form=new FormData();form.append("file",file);const path=sourceId?workspacePath(workspace.id,`assets/${sourceId}/mask-sequence`):workspacePath(workspace.id,`assets?projectId=${project.id}`);const asset=await call<Asset>(path,"POST",form,sourceId?{timeoutMs:180000}:undefined);if(!ownsOperation(uploadGate.current,current))return false;setAssets(a=>[asset,...a]);setDraft(d=>({...d,inputs:{...d.inputs,[role]:asset.id}}));setFiles(f=>({...f,[role]:null}));return true;}catch(e){if(ownsOperation(uploadGate.current,current))setError(`${(e as Error).message} The file is still selected; retry explicitly after checking the requirements.`);return false;}finally{if(finishOperation(uploadGate.current,current))setBusy("");}}
  function saveIntent(value:Intent|null){setPending(value);try{if(value)sessionStorage.setItem(`${key}:intent`,JSON.stringify(value));else sessionStorage.removeItem(`${key}:intent`);}catch{setError("This request is tracked only while the page stays open; browser storage is unavailable.");}}
  async function queue(){
    if(!canQueue||busy||(!pending&&(!ready||!valid)))return;
    setBusy("queue");setError("");setSaved("");
    const consent={...(webcamSelected?{webcam:true}:{}),...(manifest.voiceContract?{voice:voiceConsent}:{})};
    /* A switched-off prompt is not sent: an empty text is a run without words, not an example prompt. */
    const controls=promptOptional(manifest)&&!promptOn?{...draft.controls,prompt:""}:draft.controls;
    const path=cameraMove&&cameraPathModel&&!draft.inputs.end_image?cameraPathRoute(cameraPathModel,cameraMove,draft.inputs,controls):undefined;
    const intent=pending??submissionIntent({projectId:project.id,workerId,...(path?{capabilityId:path.capabilityId,version:path.version,inputs:path.inputs}:(({capabilityId,version,inputs})=>({capabilityId,version,inputs}))(endFrameRoute(manifest,endPair,draft.inputs))),routeId:"local",elementInputs:draft.elementInputs,controls:path?path.controls:cameraInstruction?{...controls,prompt:`${cameraInstruction}\n\n${String(controls.prompt??"").trim()}`.trim()}:controls,...(draft.presetId?{presetId:draft.presetId}:{}),audioPolicy:draft.audioPolicy,...(Object.keys(consent).length?{consent}:{})});
    saveIntent(intent);
    try {const result=await call<{id:string}>(workspacePath(workspace.id,"runs"),"POST",intent);saveIntent(null);setSaved(`Request recorded: ${result.id}`);setRunVersion(v=>v+1);onQueued();}
    catch(e){setError((e as Error).message);if(e instanceof ApiError&&e.status>=400&&e.status<500&&e.status!==401&&e.status!==409)saveIntent(null);}
    finally{setBusy("");}
  }
  const resolutions=Object.entries(manifest.resolutions??{}),selectedResolution=resolutions.find(([,s])=>s.width===draft.controls.width&&s.height===draft.controls.height)?.[0]??"";
  const surface=capabilitySurface(manifest);
  /* An effect screen explains the chosen effect in the panel itself: what it does and what it needs. */
  const guide=effectGuide(manifest.id),promptCopy=effectPromptCopy(guide);
  const candidates=useMemo(()=>catalogue.filter(m=>m.coverage.local==="implemented"&&(workflowIds?workflowIds.includes(m.id):surface==="motion"?capabilitySurface(m)==="motion":surface==="video-edit"?isMaskedEdit(m):surface==="video-enhance"?capabilitySurface(m)==="video-enhance":surface==="video-effect"?capabilitySurface(m)==="video-effect":createVideoCandidate(m,manifest.id)&&(m.id===manifest.id||!isEndFrameVariant(m.id)))),[catalogue,surface,workflowIds,manifest.id]);
  const createSurface=createVideoCandidate(manifest,manifest.id)||masked;
  const editTarget=createSurface&&!masked?catalogue.find(m=>m.coverage.local==="implemented"&&isMaskedEdit(m)&&!!m.mediaContract):undefined;
  const imageTarget=createSurface&&!masked&&!manifest.inputs.some(port=>port.type==="image")?candidates.find(m=>createVideoCandidate(m)&&m.inputs.some(port=>port.type==="image"&&port.id==="start_image")):undefined;
  const workflowOptions:TeamChoiceOption[]=candidates.map(m=>{const candidates=workers.map(w=>workerReadiness(m,w)),r=candidates.find(r=>r.state==="ready")??candidates[0];return {value:m.id,label:m.title,note:firstSentence(m.description),icon:m.mediaContract?<Sparkles size={16}/>:<Video size={16}/>,status:!r||r.state==="offline"?"offline":r.state==="ready"?"ready":r.state==="download_required"?"missing":"incompatible",detail:r?.state==="ready"?undefined:plainReasons(r?.reasons??[],{settings:settingsPlace})||`Connect ComfyUI in ${settingsPlace} before queueing.`};});
  const length=manifest.controls.find(c=>c.id==="length"),seed=manifest.controls.find(c=>c.id==="seed");
  function setInput(role:string,id:string){if(contract&&role===contract.sourceInput)invalidateOperation(uploadGate.current);setDraft(d=>{let inputs={...d.inputs},elementInputs={...d.elementInputs};if(contract&&role===contract.sourceInput)inputs=clearMaskForSource(inputs,manifest);if(id){inputs[role]=id;delete elementInputs[role];}else delete inputs[role];return {...d,inputs,elementInputs};});if(contract&&role===contract.sourceInput){setFiles(f=>({...f,[contract.maskInput]:null}));setBusy("");}}
  function setElementInput(role:string,value:string){setDraft(d=>chooseElementInput(d,role,value));setFiles(f=>({...f,[role]:null}));}
  const toast=useToast();
  /* A failed request is said in everyday words; the raw text waits behind Details (rule 36). */
  const failure=error?plainProblem(error,{settings:settingsPlace}):null;
  useEffect(()=>{if(saved)toast(saved);},[saved]);
  const advanced=advancedControls(manifest,motionRoute,nativeCamera);
  function controlField(c:(typeof manifest.controls)[number]){
    const label=c.id==="prompt"?(masked?"3 · Describe the change":motionRoute?"What should happen?":manifest.category==="motion"?"Describe the shot":promptCopy?.label??"Prompt"):c.id==="motion_prompt"?"Motion details":c.id==="negative"?"Negative prompt":c.label;
    if(c.disabledReason)return <Notice inline title={c.label}>{c.disabledReason}</Notice>;
    if(c.type==="string")return <PromptField disabled={locked} label={label} compact={c.id!=="prompt"||motionRoute} placeholder={c.id!=="prompt"?`Enter ${label.toLowerCase()}`:motionRoute?"Describe the character, setting and action":masked?"Say what should be there instead, for example a red mug in place of the blue one":promptCopy?.placeholder??"Describe the shot"} value={String(draft.controls[c.id]??"")} onChange={v=>changeControl(c.id,v)}/>;
    if(c.type==="select")return <Row disabled={locked} label={label} display={String(draft.controls[c.id]??"")} value={draft.controls[c.id] as string|number} options={c.options?.map(v=>({value:v,label:String(v)}))} onChange={v=>changeControl(c.id,v)}/>;
    if(c.type==="boolean")return <Checkbox checked={!!draft.controls[c.id]} onChange={v=>changeControl(c.id,v)}>{label}</Checkbox>;
    return <TextField label={label} type="number" min={c.min} max={c.max} step={c.id==="strength"?"0.05":c.type==="integer"?1:"any"} value={String(draft.controls[c.id]??"")} onChange={v=>changeControl(c.id,v===""?"":Number(v))}/>;
  }
  const maskChoice=source&&trackingReady&&!selectedMask?<SegmentedTabs quiet label="Mask method" value={maskMethod} onChange={setMaskMethod} items={[{id:"track",label:"Select area"},{id:"upload",label:"Upload mask"}]}/>:null;
  const workerChoice=<TeamChoice label="Worker" display={worker?.name??"Choose a worker"} disabled={locked} value={workerId} onChange={setWorkerId} options={workers.map(w=>{const r=workerReadiness(manifest,w);return {value:w.id,label:w.name,disabled:r.state!=="ready",status:r.state==="ready"?"ready":r.state==="offline"?"offline":r.state==="download_required"?"missing":"incompatible",detail:r.state!=="ready"?plainReasons(r.reasons,{settings:settingsPlace}):undefined};})}/>;
  const promptControl=manifest.controls.find(c=>c.id==="prompt"),optionalPrompt=promptOptional(manifest);
  /* Reference pictures (a style, an object, a person) go into one tray instead of a stack of boxes. */
  const referencePorts=manifest.inputs.filter(port=>port.type==="image"&&/reference/i.test(port.id)),emptyReference=referencePorts.find(port=>!draft.inputs[port.id]);
  /* Quality is the frame size the clip comes out at; the menu notes its length and speed. */
  const qualityOptions=resolutions.map(([id,size])=>({value:id,label:resolutionLabel(size.width,size.height),note:[length?`${draft.controls.length} s`:null,manifest.timing?`${manifest.timing.fps} fps`:null].filter(Boolean).join(" · ")}));
  const quality=qualityOptions.find(option=>option.value===selectedResolution);
  /* Speed is a quick camera setting like duration, so both share one Params row. */
  const speedOptions=nativeSpeedControl?CAMERA_SPEEDS.filter(speed=>speed>=Number(nativeSpeedControl.min??0)&&speed<=Number(nativeSpeedControl.max??10)).map(speed=>({value:speed,label:`${speed}×`})):[];
  /* One box per media input. A reference picture is not one of these boxes. */
  function mediaZone(port:(typeof manifest.inputs)[number]){
    const isMask=!!contract&&port.id===contract.maskInput,sourceReady=!isMask||!!source;
    if(isMask&&useTracking&&!selectedMask)return <div key={port.id} className="cf-form">{maskChoice}</div>;
    const options=assets.filter(a=>isMask?matchingMask(a,source,project.id,manifest):assetMatchesPort(a,port)&&(!manifest.voiceContract||port.id!==manifest.voiceContract.audioInput||["audio/wav","audio/x-wav"].includes(a.content_type)));
    const elementOptions=masked?[]:compatibleElementOptions(elements,port);
    const elementBinding=draft.elementInputs[port.id],elementValue=elementBinding?`${elementBinding.elementId}:${elementBinding.assetId}`:"",elementChoice=elementOptions.find(option=>option.value===elementValue);
    /* The longest clip a run takes is the one fact the drop zone itself says, in short words. */
    const clipHint=port.id==="motion_video"&&motionRoute?`Drop a video, up to ${Math.floor(MOTION_MAX_CLIP_SECONDS)} s`:port.id==="source_video"?guide?.clipHint:undefined;
    const hint=isMask?(sourceReady?"White marks edits; black uses the source before export. Exported pixels can differ. The mask must match your clip frame for frame.":"Add a source clip first. The mask is checked against it."):clipHint;
    return <div key={port.id} className="cf-form">{isMask&&maskChoice}<TeamMediaInput accept={manifest.voiceContract&&port.id===manifest.voiceContract.audioInput?"audio/wav,audio/x-wav,.wav":undefined} label={manifest.category==="motion"&&port.id==="start_image"?"Character image":masked&&port.id==="source_video"?"1 · Clip to change":masked&&port.id==="edit_mask"?"2 · Mask (white = change)":(manifest.category==="3d"?port.label:`${mediaLabels[port.id]??port.label}${port.id==="end_image"&&!port.required?" (optional)":""}`)} type={port.type} representation={port.representation} hint={hint} uploadLabel={isMask?(busy===port.id?"Validating mask…":"Validate and upload mask"):undefined} file={files[port.id]??null} selected={assets.find(a=>a.id===draft.inputs[port.id])} element={elementChoice&&elementBinding?{name:elementChoice.label,src:assetUrl(workspace.id,elementBinding.assetId)}:undefined} options={options} characters={elementOptions.map(option=>({value:option.value,label:option.label,kind:option.note.split(" · ")[0],assetId:option.value.slice(option.value.indexOf(":")+1)}))} uploading={busy===port.id?(isMask?"Checking the mask…":"Uploading…"):undefined} onCharacter={value=>setElementInput(port.id,value)} disabled={locked||!sourceReady} canUpload={workspace.role!=="viewer"} workspace={workspace.id} onFile={file=>{setAddingReference(false);setFiles(old=>{const next={...old,[port.id]:file};if(contract&&port.id===contract.sourceInput)next[contract.maskInput]=null;return next;});if(file)setDraft(d=>{const elementInputs={...d.elementInputs};delete elementInputs[port.id];return {...d,elementInputs};});if(contract&&port.id===contract.sourceInput)setInput(port.id,"");/* A chosen clip or image is uploaded at once, so "Queue" never waits on a hidden second step; masks keep their explicit validation. */if(file&&!isMask&&workspace.role!=="viewer")void upload(port.id,file);}} onSelect={id=>{setAddingReference(false);setInput(port.id,id);if(!id)setElementInput(port.id,"");}} onUpload={()=>void upload(port.id)}/></div>;
  }
  return <div className="cf-production"><WorkflowDescription title={manifest.title}>{workflowInfo??<><Meta>{manifest.description}</Meta>{masked&&<MaskHowItWorks/>}{guide&&<HowItWorks compact title={guide.summary} lead="" steps={guide.steps.map(step=>({icon:<WandSparkles size={16}/>,...step}))}/>}</>}</WorkflowDescription><Panel footer={<div className="cf-form">
    {blocker&&<Notice consequence priority={35} title={blocker.title} actions={blockerAction()} details={blocker.details}>{blocker.text}</Notice>}
    {masked&&requirements&&requirements.state!=="ready"&&<Notice priority={40} title="Installation required" actions={<Button variant="secondary" disabled={locked} onClick={()=>{if(onModels)onModels();else onQueued();}}>Open Models</Button>} details={requirements.missing.join("\n")}>{requirements.missing.join(", ")}. Models shows which files are missing and how to add them{requirements.instructions?`; ${requirements.instructions}`:""}</Notice>}
    {!canQueue&&(workspace.role==="viewer"
      ?<Notice tone="info" title="Viewer access">You can look, but not upload or queue runs.</Notice>
      :<Notice priority={10} consequence title="Sign in or reconnect to queue">Your draft is preserved.</Notice>)}
    {/* A frozen request is a state, not a failure: its retry is the panel's own primary action. */}
    {pending&&<Notice tone="info" title="Request awaiting confirmation">The request is frozen. The Generate button checks and retries it with the same identifier, so no duplicate job is created.</Notice>}{masked&&requirements===null&&<ShimmerText>Checking FFmpeg and FFprobe…</ShimmerText>}
    {motionNotice&&<Notice inline>{motionNotice}</Notice>}
    {error&&failure&&<Notice priority={60} title={failure.title||"This request did not go through"} actions={<Button variant="secondary" disabled={!!busy||!canQueue} onClick={()=>void queue()}>Try again</Button>} details={error}>{failure.text}</Notice>}
    {<GenerateButton disabled={!!busy} aria-disabled={!busy&&(!canQueue||(!pending&&(!ready||!valid)))} disabledReason={pending?undefined:[missing.length?`Add ${missing.map(p=>p.label.toLowerCase()).join(" and ")}.`:"",...errors].filter(Boolean).join(" ")||undefined} onClick={()=>{if(busy||!canQueue||(!pending&&(!ready||!valid))){if(!pending&&!ready)toast(blocker?.text??"This workflow cannot run here yet.");else if(!pending&&!valid)toast(missing[0]?`${missing[0].label}: select available shared ${missing[0].type} media.`:errors[0]??motionNotice??"This request is not ready yet.");return;}void queue();}} label={pending?"Check / retry same request":"Generate"}/>}
  </div>}>
    <div className="cf-form"><TeamChoice variant="model" label="Model" display={manifest.title.split(" (")[0]} subtitle={manifest.title.split(" (")[1]?.replace(")","")??"Local ComfyUI"} video={reelForManifest(manifest.id)??reelForSection("video")} value={manifest.id} options={workflowOptions} onChange={onCapability} disabled={locked}/>{top}{memoryTight&&<Notice inline title="Low free memory, a run may wait to start"/>}
      <fieldset disabled={locked} className="cf-fieldset">
        {editTarget&&<UploadSlot label="Add a video to edit" hint="Up to 5 s" accept="video/mp4,video/webm,video/quicktime" kinds={["video"]} disabled={locked} onFile={file=>{if(file)void editWith(file);}}/>}
        {imageTarget&&<UploadSlot label="Add a picture to start from" hint="Your video begins with it" accept="image/png,image/jpeg,image/webp" kinds={["image"]} disabled={locked} onFile={file=>{if(file)void startWith(imageTarget,"start_image",file);}}/>}
        {manifest.inputs.filter(port=>!referencePorts.includes(port)).map(mediaZone)}
        {referencePorts.length>0&&<ReferenceTray label={referencePorts.length===1?referencePorts[0].label:"References"} max={referencePorts.length} onAdd={()=>{if(!locked)setAddingReference(true);}}>{referencePorts.map(port=>{const asset=assets.find(a=>a.id===draft.inputs[port.id]);return asset?<Thumb key={port.id} label={port.label} src={assetUrl(workspace.id,asset.id)} onRemove={()=>{if(!locked)setInput(port.id,"");}} dragData={{type:"application/x-comfyfield-asset",value:asset.id}}/>:null;})}</ReferenceTray>}
        {referencePorts.length>0&&addingReference&&emptyReference&&mediaZone(emptyReference)}
        <Rule/>
        {masked&&source&&<ParamButton disabled={locked} title="Edit ideas" icon={<WandSparkles size={16}/>} label="Edit ideas" value={MASK_EDIT_IDEAS.find(idea=>idea.prompt===draft.controls.prompt)?.value??"custom"} options={MASK_EDIT_IDEAS.map(idea=>({value:idea.value as string,label:idea.label}))} onChange={value=>{const idea=MASK_EDIT_IDEAS.find(idea=>idea.value===value);if(idea)changeControl("prompt",idea.prompt);}}/>}
        {promptControl&&optionalPrompt&&<ToggleRow label="Prompt" checked={promptOn} onChange={setPromptOn} disabled={locked}/>}
        {promptControl&&(!optionalPrompt||promptOn)&&controlField(promptControl)}
        {manifest.controls.filter(c=>c.id==="motion_prompt"&&!motionRoute).map(c=><div key={c.id}>{controlField(c)}</div>)}
        {qualityOptions.length>0&&<Row label="Quality" display={quality?.label??"Choose"} value={selectedResolution} options={qualityOptions} onChange={id=>{if(locked)return;const size=manifest.resolutions![id];setDraft(d=>({...d,controls:{...d.controls,width:size.width,height:size.height}}));}}/>}
        <Row subtle disabled={locked} label="Advanced settings" display="Optional controls" onClick={()=>setAdvancedOpen(true)}/>
      </fieldset>
      {canQueue&&<LinkButton variant="ghost" href={`#nodes/feature/${manifest.id}`}>Edit in nodes</LinkButton>}
      <fieldset disabled={locked} className="cf-fieldset">
        {manifest.presets.length>0&&!masked&&<PresetGrid label="Look">{manifest.presets.map(preset=><PresetCard key={preset.id} label={preset.title} selected={draft.presetId===preset.id} onSelect={()=>choosePreset(preset.id)} icon={<WandSparkles size={18}/>}/>)}</PresetGrid>}
        {masked&&selectedMask&&contract&&<Button variant="secondary" disabled={locked} onClick={()=>setInput(contract.maskInput,"")}>Change area</Button>}
        {authorized&&manifest.voiceContract&&manifest.timing&&voiceAudio&&<Suspense fallback={null}><VoicePreview key={`${voiceAudio.id}:${draft.controls.audio_start}:${draft.controls.length}`} workspace={workspace.id} asset={voiceAudio} startSeconds={Number(draft.controls.audio_start??0)} durationSeconds={secondsToWanFrames(Number(draft.controls.length),manifest.timing.fps)/manifest.timing.fps}/></Suspense>}
        {manifest.voiceContract&&<><Checkbox checked={voiceConsent} onChange={setVoiceConsent}>I have permission to animate this portrait with this voice and save the result in this project.</Checkbox><Meta>WAV, up to 60 s</Meta></>}
        {masked&&selectedMask&&source&&<TrackedMaskReview key={selectedMask.id} workspace={workspace.id} source={source} mask={selectedMask}/>}
      </fieldset>
      {motionRoute&&authorized&&canQueue&&poseBinding&&<Suspense fallback={null}><PosePreview key={JSON.stringify(poseBinding)} binding={poseBinding} call={call} disabled={!!pending||!!busy}/></Suspense>}
        {useTracking&&!selectedMask&&maskCreator&&source&&contract&&<RegionMaskCreator pointManifest={catalogue.find(item=>item.id==="sam31-video-point-mask"&&item.coverage.local==="implemented")} backgroundManifest={catalogue.find(item=>item.id==="sam31-video-background-mask"&&item.coverage.local==="implemented")} userId={user.id} onBusyChange={setTrackingBusy} key={`${source.id}:${maskCreator.id}`} manifest={maskCreator} workers={workers} workspace={workspace} project={project} source={source} call={call} canEdit={canQueue&&authorized&&workspace.role!=="viewer"} onApproved={asset=>{setAssets(current=>mergeAssets([asset],current));setInput(contract.maskInput,asset.id);}}/>}
      {masked&&source&&selectedMask&&!invalidMask&&<Suspense fallback={null}><MaskCorrectionEditor key={`correct:${selectedMask.id}`} workspace={workspace.id} userId={user.id} source={source} mask={selectedMask} call={call} disabled={!canQueue||!authorized||workspace.role==="viewer"||!!pending||!!busy||trackingBusy||multiEditBusy} onBusyChange={setCorrectionBusy} onCorrected={asset=>{setAssets(current=>mergeAssets([asset],current));setInput(contract!.maskInput,asset.id);}}/></Suspense>}
      {masked&&source&&selectedMask&&!invalidMask&&catalogue.find(m=>m.id==="wan21-vace-two-region-edit"&&m.coverage.local==="implemented")&&<Suspense fallback={<Button variant="secondary" disabled>Loading…</Button>}><TwoRegionEditor key={`${workspace.id}:${project.id}:${source.id}:${selectedMask.id}`} manifest={catalogue.find(m=>m.id==="wan21-vace-two-region-edit")!} catalogue={catalogue} workspace={workspace} project={project} userId={user.id} source={source} firstMask={selectedMask} assets={assets} workers={workers} preferredWorkerId={workerId} firstPrompt={String(draft.controls.prompt??"")} baseControls={draft.controls} call={call} disabled={!canQueue||!authorized||workspace.role==="viewer"||!!pending||!!busy||trackingBusy||correctionBusy} onBusyChange={setMultiEditBusy} onQueued={()=>{setRunVersion(v=>v+1);onQueued();}}/></Suspense>}
      <fieldset disabled={locked} className="cf-fieldset">
        {nativeCamera&&<div className="cf-form">
          <Row disabled={locked} label="Camera move" display={String(draft.controls.camera_pose??"Static")} value={String(draft.controls.camera_pose??"Static")} options={nativePoseControl?.options?.map(pose=>({value:pose,label:String(pose)}))} onChange={pose=>changeControl("camera_pose",pose)}/>
          <GestureStage
            src={cameraSource?assetUrl(workspace.id,cameraSource.id):undefined}
            alt="Selected start frame for the native camera move"
            value={nativeCameraGesture(manifest,draft.controls.camera_pose)}
            moves={nativeMoves}
            onChange={gesture=>{const pose=nativeCameraPose(manifest,gesture);if(pose!==undefined)changeControl("camera_pose",pose);}}
            disabled={locked}
            instruction="Gestures snap to a straight pan or zoom; the selected trajectory guides generation"
          />
          <CameraPathPreview src={cameraSource?assetUrl(workspace.id,cameraSource.id):undefined} alt="Start frame moving along the chosen camera path" pose={String(draft.controls.camera_pose??"Static")} speed={Number(draft.controls.speed??1)} seconds={Number(draft.controls.length??1)}/>
        </div>}
        {cameraRoute&&<div className="cf-form">
          <Row disabled={locked} label="Camera move" display={cameraMoveInfo?.label??"No camera move"} value={cameraMove} options={[{value:"",label:"No camera move",note:"Use the prompt as written"},...CAMERA_MOVES.map(move=>({value:move.id,label:move.label,note:move.instruction}))]} onChange={setCameraMove}/>
          <GestureStage
            src={cameraSource?assetUrl(workspace.id,cameraSource.id):undefined}
            alt="Selected start frame for the camera move"
            value={cameraMove}
            moves={CAMERA_MOVES.map(move=>({id:move.id,label:move.label}))}
            onChange={setCameraMove}
            disabled={locked}
            instruction={cameraPathModel&&!draft.inputs.end_image?"Pick a move: the camera follows it on a fixed path (640×640, up to 5 s)":"The move is added to the start of your prompt when you queue"}
          />
          {cameraInstruction&&(cameraPathModel&&!draft.inputs.end_image?<Meta>Runs on the camera model: the path is followed, the prompt only describes the scene</Meta>:<Meta>{cameraInstruction}</Meta>)}
        </div>}
        <span className="cf-scroll-reserve" aria-hidden/>
      </fieldset>
    </div>
  </Panel><TeamRuns workspace={workspace} project={project} user={user} call={call} canEdit={canQueue} authorized={authorized} version={runVersion} titles={catalogueTitles(catalogue)} capabilityId={[manifest.id,...(endPair?[endPair.id]:[]),...(cameraPathModel?[cameraPathModel.id]:[])]} examples={manifest.outputs.some(p=>p.type==="video")?"video":manifest.outputs.some(p=>p.type==="image")?"image":undefined} outputAction={onUseImage?run=>run.output_ids[0]?<Button variant="secondary" onClick={()=>onUseImage(run.output_ids[0])}>Use for 3D</Button>:null:undefined} hero={latest=>(capabilitySurface(manifest)==="image"||(!manifest.outputs.some(p=>p.type==="video")&&manifest.category!=="3d"))?undefined:<ToolHero latest={latest} kind={manifest.category==="3d"?"model3d":capabilitySurface(manifest)==="motion"||manifest.category==="motion"?"motion":capabilitySurface(manifest)==="video-effect"?"restyle":"create"} workflowId={manifest.id}/>}/><Dialog open={advancedOpen&&!locked} title="Advanced" onClose={closeAdvanced} footer={<Button variant="primary" onClick={closeAdvanced}>Done</Button>}><div className="cf-form">
    {(length||nativeSpeedControl||(audioChoice(manifest)&&!masked))&&<Params>
      {length&&<ParamButton disabled={locked} title="Duration" icon={<Clock size={16}/>} label={`${draft.controls.length}s`} value={Number(draft.controls.length)} onChange={v=>changeControl("length",v)} options={Array.from({length:Math.floor((length.max??10)-(length.min??1))+1},(_,i)=>({value:(length.min??1)+i,label:`${(length.min??1)+i} ${(length.min??1)+i===1?"second":"seconds"}`}))}/>}
      {nativeSpeedControl&&<ParamButton disabled={locked} title="Camera speed" icon={<Gauge size={16}/>} label={`${Number(draft.controls.speed??nativeSpeedControl.default??1)}×`} value={Number(draft.controls.speed??nativeSpeedControl.default??1)} onChange={v=>changeControl("speed",v)} options={speedOptions}/>}
      {audioChoice(manifest)&&!masked&&<ParamButton disabled={locked} title="Audio" icon={<Volume2 size={16}/>} label={manifest.voiceContract&&draft.audioPolicy==="replace"?"Voice take":audioLabels[draft.audioPolicy]} value={draft.audioPolicy} onChange={v=>setDraft(d=>({...d,audioPolicy:v}))} options={manifest.audioPolicies.map(p=>({value:p,label:manifest.voiceContract&&p==="replace"?"Voice take":audioLabels[p]}))}/>}
    </Params>}
    {advanced.map(c=><div key={c.id}>{controlField(c)}</div>)}{seed&&<TextField label="Seed" type="number" min={seed.min} max={seed.max} step={1} value={String(draft.controls.seed??"")} onChange={v=>changeControl("seed",v===""?"":Number(v))}/>}{(!ready||workers.length>1)&&workerChoice}{masked&&<Collapsible title="Requirements"><Meta>Constant 16 FPS · 17–81 frames · 4n+1 frames · timestamp zero · dimensions divisible by 16 · up to 832 pixels per side and 399360 pixels per frame · square pixels · no rotation · source may include audio · mask must be grayscale and silent · output is muted</Meta></Collapsible>}</div></Dialog></div>;
}

