import {Box,CircleHelp,Clapperboard,Cloud,Footprints,Image as ImageIcon,LogOut,Maximize2,Move,Palette,Plus,Scissors,Settings,Sparkles,Video} from "lucide-react";
import {annotationStorageKey,imageAnnotationsSchema} from "../image/annotations";
import {TeamStoryboard} from "./TeamStoryboard";
import {KeyframeStudio} from "./KeyframeStudio";
import {StartScreen} from "./StartScreen";
import {GettingStarted} from "./GettingStarted";
import {Welcome} from "./Welcome";
import {CloudSignIn,reopenCloudSignIn,type CloudAccountFacts} from "./CloudSignIn";
import {Guide} from "./Guide";
import {SwapThingPanel} from "./SwapThingPanel";
import {ReferenceReplacePanel} from "./ReferenceReplacePanel";
import {changeChoiceFromHash,startTasks,type StartTask} from "./start-tasks";
import {ProjectCreateDialog,TeamProjects} from "./TeamProjects";
import {useCallback,useEffect,useRef,useState,type ReactNode} from "react";
import {IconButton,Panel,Reveal,ExpandToggle,AmbientReelProvider,MediaEditProvider,type MediaEditSource,type MediaToolSet,ScrollFades,useDensity,Button,EmptyState,Page,ShimmerText,ToastHost,UserMenu,ProblemBar,ProblemHost,Dialog,Meta,Notice,TopBar,WorkspaceBar,LinkButton} from "../ds";
import {AuthPanel} from "./AuthPanel";
import {ApiError,storeCloudKey,assetUrl,composerAssets,composerResultAssets,mergeAssets,request,workspacePath,type Asset,type Call,type RequestOptions,type Run,type User,type Workspace,type Project,type Worker,type Catalogue} from "./api";
import {TeamComposer} from "./TeamComposer";
import {TransformVideo} from "./TransformVideo";
import {TeamLibrary,TeamRuns} from "./TeamLibrary";
import {feedMode,feedScope} from "./media-feed";
import {runLocation} from "./job-queue";
import {JobQueueIndicator} from "./JobQueueIndicator";
import {TeamSettings} from "./TeamSettings";
import {ChatgptImageStudio} from './ChatgptImageStudio';
import {CloudRenderStudio} from "./CloudRenderStudio";
import {cloudFeature} from "../capabilities/router-models";
import {TeamChoice} from "./TeamChoice";
import {CapabilityCatalogue} from "../ui/CapabilityCatalogue";
import {bestWorkerReadiness,defaultDraft,draftKey,restoreDraft,refreshWorkerInventory,workerReadiness} from "./state";
import {plainProblem} from "./problems";
import {audienceOf,noWorkspaceText,settingsLabel,workspaceFacts} from "./audience";
import type {CapabilityManifestV2,Readiness} from "../capabilities/types";
import "./team.css";
import {isMaskedEdit} from "./masked-state";
import {WorkflowInfoProvider,WorkflowInfoButton} from "./workflow-info";
import {BlockShot} from "./BlockShot";
import {reelForSection} from "./reels";
import {capabilityPurpose,capabilitySurface,isCreateVideoWorkflow,isImageWorkflow,isVideoWorkflow} from "../capabilities/surfaces";
import {isSelectedImageModel} from "../capabilities/image-model-selection";
import {ImageStudio} from "../image/ImageStudio";
import {identityPhotosetWorkerAllowed} from "../image/identity-photoset";
import {ImageEditor} from "../image/editor/ImageEditor";
import {addCharacterReferences,defaultImageDraft,imageDraftWithReferences,imageRunBody,restoreImageRetakeDraft,type ImageDraft} from "../image/image-state";
import {isSelectedVideoCreate,routeImageToVideo,routeImageToVideoDraft,routeTask,taskPacks} from "../capabilities/tasks";
import {CharacterWorkspace,type CharacterMode} from "./characters/CharacterWorkspace";
import {AudioStudio,type AudioRequirements} from "./audio";
import {VideoEditStudio,videoModeFromHash,type VideoEditRequirements} from "./video-edit";
import {ComfyLibraryPanel} from "./ComfyLibrary";
import {ImageTo3DPanel} from "./three-d/ImageTo3DPanel";
import {ModelToolsPanel} from "./three-d/ModelToolsPanel";
import {TextTo3DPanel} from "./three-d/TextTo3DPanel";
import {ThreeDStudio} from "./three-d/ThreeDStudio";
import {NATIVE_THREE_D_TOOLS} from "./three-d/tools";
import {ComfyNodes} from "./nodes/ComfyNodes";
import {IntentDock} from "./intent/IntentDock";
import {assetMatchesPort} from "../capabilities/assets";
import {currentIntentReference,intentImageReferenceTarget,intentPromptDraft,intentReferenceDraft} from "./intent/reference";
import {beginOperation,finishOperation,invalidateOperation,operationGate} from "./operation-gate";
import type {IntentTarget} from "./intent/router";
import {nativeWorkflowHash} from "./workflow-navigation";
import {routeState,sectionFromHash} from "./route-state";
import {videoHashPart,videoWorkflowHash} from "../ui/studio-route";
import {selectTransformManifest} from "./transform-video-state";
import {catalogueTitles} from "./job-queue";
import {ToolHero,type HeroKind} from "./heroes";
import {ProductionContent} from "./ProductionWorkspace";
import logo from "../assets/creativefield-logo-trim.png";
import {RecreateMediaProvider,RecreateProvider,type RecreateMedia,type RecreateRun} from "./recreate";

/** A worker's kind comes from the server; the shared Worker type does not carry it yet. */
export type VideoWorkspaceMode="create"|"edit"|"trim"|"storyboard"|"keyframes"|"effects"|"transform"|"replace"|"workflow";
export function videoWorkflowMode(manifest:CapabilityManifestV2):VideoWorkspaceMode{
  if(manifest.id==="video-edit")return "trim";
  if(isMaskedEdit(manifest))return "edit";
  if(manifest.id==="h3-effects")return "effects";
  if(capabilitySurface(manifest)==="video-effect")return "effects";
  return isCreateVideoWorkflow(manifest)||capabilitySurface(manifest)==="video-enhance"?"create":"workflow";
}
export type RunTarget="local"|"cloud"|"router"|"chatgpt";
/** Comfy Cloud runs no job from an API key on its free tier: said once, with what to do. */
export const CLOUD_PLAN_LINE="Comfy Cloud workflows need a paid Comfy plan. Comfy Router models (FLUX, Seedance, Kling) run on your credits on any plan.";
export const isCloudWorker=(worker:Worker)=>(worker as Worker&{kind?:"local"|"cloud"}).kind==="cloud";
/** Every creative canvas offers the cloud setup path; this computer remains the default. */
/** `guest` is set for a hosted guest only: their cloud is connected by signing in with their own key. */
export function runTargetOptions(workers:Worker[],imageEditing=false,guest?:{signedIn:boolean;cloudJobs?:boolean}):{value:RunTarget;label:string;note?:string}[]|undefined{
  const connected=guest?.signedIn??workers.some(isCloudWorker);
  /* A hosted guest renders on their own Comfy account only: this computer and ChatGPT are not offered online (rule 26).
     Comfy Router models bill credits on any plan; Comfy Cloud workflows need a paid Comfy plan. */
  if(guest)return [{value:"router",label:"Comfy Router",note:connected?"Ready · FLUX, Seedance and Kling on your Comfy credits":"Sign in with your own Comfy key"},{value:"cloud",label:"Comfy Cloud",note:!connected?"Sign in with your own Comfy key":guest.cloudJobs===false?"Needs a paid Comfy plan":"Connected · uses your Comfy Cloud credits"}];
  return [{value:"local",label:"This computer"},{value:"cloud",label:"Comfy Cloud",note:connected?"Connected · uses your Comfy Cloud credits":"Set up a cloud worker · no render starts"},{value:"router",label:"Comfy Router · BYOK",note:"Hosted models · your Comfy credits"},...(imageEditing?[{value:"chatgpt" as const,label:"ChatGPT",note:"Your sign-in · subscription quota"}]:[])];
}
/** A run goes to the chosen target only; this computer stays the default. */
export function targetWorkers(workers:Worker[],target:RunTarget):Worker[]{
  return target==="router"||target==="chatgpt"?[]:target==="cloud"?workers.filter(isCloudWorker):workers.filter(worker=>!isCloudWorker(worker));
}
/** The first switch to Comfy Cloud is a clear yes after one line about credits. */
export function CloudRunConsent({onUse,onKeep}:{onUse:()=>void;onKeep:()=>void}){
  return <Dialog open title="Use Comfy Cloud?" onClose={onKeep} footer={<><Button variant="ghost" onClick={onKeep}>Keep local</Button><Button variant="primary" onClick={onUse}>Use Comfy Cloud</Button></>}><Meta>Cloud runs use your Comfy Cloud credits.</Meta></Dialog>;
}

/* The image workspace: Create and Edit, plus the picture tools that have a ready workflow of their own.
   Angles and Relight are tabs of this screen, so switching between them keeps the picture already chosen. */
export type ImageTab="create"|"angles"|"relight"|"edit";
/** Replace character on Comfy Cloud, in the order the Model row offers them. */
const CLOUD_REPLACE_MODELS=["scail2-character-replace","cloud-h3-character-swap","cloud-kling-omni-edit","cloud-seedance2-reference"];
const ANGLE_WORKFLOWS=taskPacks("image.angles"),RELIGHT_WORKFLOW="flux2-klein-relight";
/** The angle workflow this computer really has ready: the camera-angle tool first, then the 45° angle shots. */
export function angleWorkflow<T extends {id:string}>(ready:T[]):T|undefined{
  return routeTask("image.angles",ready)?.pack;
}
/** One row of tabs. A tool gets a tab only while its workflow is ready here (rule 26); Photo editing has its own place, FotoField. */
export function imageTabs(ready:Array<{id:string;inputs?:Array<{required:boolean}>}>):Array<{id:ImageTab;label:string}>{
  return [
    ...(imageTabTarget("create",ready)?[{id:"create" as const,label:"Create"}]:[]),
    ...(angleWorkflow(ready)?[{id:"angles" as const,label:"Angles"}]:[]),
    ...(ready.some(m=>m.id===RELIGHT_WORKFLOW)?[{id:"relight" as const,label:"Relight"}]:[]),
  ];
}
/** Which tab the open workflow belongs to; anything that is not a picture tool is Create. */
export function imageTabFor(manifestId:string|undefined,route:string):ImageTab{
  if(route==="imageedit")return "edit";
  if(manifestId===RELIGHT_WORKFLOW)return "relight";
  return manifestId&&ANGLE_WORKFLOWS.includes(manifestId)?"angles":"create";
}
/** The model picker stays within the active Image workspace. */
export function imageModelsForTab<T extends {id:string}>(models:T[],tab:ImageTab):T[]{
  return models.filter(model=>imageTabFor(model.id,"image")===tab);
}
/** The workflow a tab opens; Create uses only the configured image-generation models. */
export function imageTabTarget<T extends {id:string;inputs?:Array<{required:boolean}>}>(tab:ImageTab,ready:T[]):T|undefined{
  if(tab==="angles")return angleWorkflow(ready);
  if(tab==="relight")return ready.find(m=>m.id===RELIGHT_WORKFLOW);
  if(tab==="edit")return undefined;
  return routeTask("image.create",ready)?.pack;
}
/** A tab starts from its own earlier draft, so its preset is still there when you come back.
    A first visit keeps the picture that is already chosen on the other tab. */
export function imageDraftForTab(manifest:CapabilityManifestV2,remembered:Record<string,ImageDraft>,showing:ImageDraft):ImageDraft{
  const earlier=remembered[manifest.id];
  if(earlier)return earlier;
  const inputs=Object.fromEntries(Object.entries(showing.inputs??{}).filter(([port,asset])=>!!asset&&manifest.inputs.some(input=>input.id===port&&input.type==="image")));
  return Object.keys(inputs).length?{...defaultImageDraft(manifest),inputs}:defaultImageDraft(manifest);
}

/** Carry only values accepted by the new workflow; unsupported controls keep their defaults. */
export function carryCreateDraft(manifest:CapabilityManifestV2,previous:ImageDraft):ImageDraft {
  const next=defaultImageDraft(manifest);
  for(const control of manifest.controls){
    const value=previous.controls[control.id];
    if(value===undefined || !(control.id in next.controls))continue;
    if(control.options && !control.options.includes(value as never))continue;
    if(typeof value==="number" && ((control.min!==undefined&&value<control.min)||(control.max!==undefined&&value>control.max)))continue;
    if(typeof value!==typeof next.controls[control.id])continue;
    next.controls[control.id]=value;
  }
  const inputs=Object.fromEntries(Object.entries(previous.inputs??{}).filter(([id])=>manifest.inputs.some(port=>port.id===id&&port.type==="image")));
  const elementInputs=Object.fromEntries(Object.entries(previous.elementInputs??{}).filter(([id])=>manifest.inputs.some(port=>port.id===id&&port.type==="image")));
  return {...next,...(Object.keys(inputs).length?{inputs}:{}),...(Object.keys(elementInputs).length?{elementInputs}:{})};
}

export default function TeamApp(){
  const [user,setUser]=useState<User|null>(null),[workspaces,setWorkspaces]=useState<Workspace[]>([]),[workspaceId,setWorkspaceId]=useState("");
  const [authRequired,setAuthRequired]=useState(false),[offline,setOffline]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState("");
  /* A hosted guest whose session changed under this tab (another tab, or the old shared demo) is resynced, never asked for a password. */
  const guestTab=useRef(false),resync=useRef<()=>Promise<void>>(async()=>{});
  const call:Call=useCallback(async<T,>(path:string,method?:string,body?:unknown,options?:RequestOptions)=>{
    try {const value=await request<T>(path,method,body,options);setOffline(false);return value;}
    catch(e){if(e instanceof ApiError){if(guestTab.current&&(e.status===401||e.status===403))void resync.current().catch(()=>undefined);else if(e.status===401)setAuthRequired(true);if(e.status===0)setOffline(true);}throw e;}
  },[]);
  const signIn=useCallback(async()=>{
    const account=await request<User>("/auth/me"),memberships=await request<Workspace[]>("/workspaces");
    guestTab.current=!!account.guest;setUser(account);setWorkspaces(memberships);setWorkspaceId(id=>memberships.some(w=>w.id===id)?id:memberships[0]?.id??"");setAuthRequired(false);setOffline(false);setError("");setLoading(false);
  },[]);
  resync.current=signIn;
  useEffect(()=>{let active=true;void signIn().catch(e=>{if(active){if(!(e instanceof ApiError)||e.status!==401)setError((e as Error).message);setLoading(false);}});return()=>{active=false;};},[signIn]);
  const signOut=useCallback(async()=>{await call("/auth/logout","POST");setUser(null);setWorkspaces([]);setWorkspaceId("");setAuthRequired(false);},[call]);
  const closeReauth=useCallback(()=>{},[]);
  const workspace=workspaces.find(w=>w.id===workspaceId);
  if(loading)return <div className="cf-auth"><ShimmerText>Connecting to your team server…</ShimmerText></div>;
  if(!user)return <AuthPanel onSignedIn={signIn} serverError={error||undefined} onRetry={()=>void signIn().catch(e=>setError((e as Error).message))}/>;
  return <ToastHost><ProblemHost>
    {workspace?<TeamWorkspace key={`${user.id}:${workspace.id}`} user={user} workspace={workspace} workspaces={workspaces} onWorkspace={setWorkspaceId} call={call} authorized={!authRequired} offline={offline} onSignOut={signOut} onReconnect={()=>void signIn().catch(e=>setError((e as Error).message))}/>:<div className="cf-auth"><EmptyState title="No workspace access" text={noWorkspaceText(audienceOf(user))} action={<Button variant="secondary" onClick={()=>void signOut()}>Sign out</Button>}/></div>}
    <Dialog open={authRequired&&!user.localSingleUser} title="Sign in to continue" onClose={closeReauth}><Notice inline title="Your session has expired">Your draft is preserved. Signing in below keeps it, and you queue explicitly when ready.</Notice><AuthPanel embedded onSignedIn={signIn}/></Dialog>
  </ProblemHost></ToastHost>;
}

const sectionOf=(route:string)=>route==="openjutsu"?"video":route;
/* `#video/camera` names a workflow; `#video/trim` names a mode, and a mode wins. */
const videoWorkflowFromHash=(hash:string)=>videoModeFromHash(hash)?undefined:videoHashPart(hash);
const isImageCapability=(manifest:Catalogue[number])=>isImageWorkflow(manifest)&&isSelectedImageModel(manifest.id);
const remixImageModel=(manifest:Catalogue[number])=>["fibo2-edit","qwen-image-21-edit"].includes(manifest.id)&&isImageCapability(manifest);
const adImageModel=(manifest:Catalogue[number])=>["fibo2-edit","flux2-klein-edit","qwen-image-21-edit"].includes(manifest.id)&&isImageCapability(manifest);
export function selectAdModel(catalogue:Catalogue,statuses:Record<string,Readiness>,current:string,named:string,remix=false){
  const choices=catalogue.filter(m=>(remix?remixImageModel(m):adImageModel(m))&&m.coverage.local==="implemented");
  const requested=choices.find(m=>m.id===named),ready=choices.find(m=>statuses[m.id]?.state==="ready");
  return requested?.id??(choices.some(m=>m.id===current&&(!ready||statuses[m.id]?.state==="ready"))?current:ready?.id??choices[0]?.id??"");
}

function TeamWorkspace({user,workspace,workspaces,onWorkspace,call,authorized,offline,onSignOut,onReconnect}:{user:User;workspace:Workspace;workspaces:Workspace[];onWorkspace:(id:string)=>void;call:Call;authorized:boolean;offline:boolean;onSignOut:()=>Promise<void>;onReconnect:()=>void}){
  const [routeHash,setRouteHash]=useState(location.hash);
  const [route,setRoute]=useState(sectionFromHash(location.hash)),[settings,setSettings]=useState(false),[modelsOpen,setModelsOpen]=useState(()=>sectionFromHash(location.hash)==="catalogue"),[creatingProject,setCreatingProject]=useState(false),[projects,setProjects]=useState<Project[]>([]),[projectId,setProjectId]=useState("");
  const [workers,setWorkers]=useState<Worker[]>([]),[catalogue,setCatalogue]=useState<Catalogue>([]),[capabilityId,setCapabilityId]=useState("");
  const [addressWorkflow,setAddressWorkflow]=useState<string|null>(()=>videoWorkflowFromHash(location.hash)??null);
  const [videoMode,setVideoMode]=useState<VideoWorkspaceMode>(()=>videoModeFromHash(location.hash)??"create");
  const [characterMode,setCharacterMode]=useState<CharacterMode>("characters");
  const [imageDraft,setImageDraft]=useState<ImageDraft>({controls:{}}),[imageAssets,setImageAssets]=useState<Asset[]>([]),[imageRuns,setImageRuns]=useState<Run[]>([]),[imageBusy,setImageBusy]=useState(false),[imageIntentKey,setImageIntentKey]=useState("");
  const [storyboardImage,setStoryboardImage]=useState<{projectId:string;workspaceId:string;assetId:string}|null>(null);
  const [storyboardIdea,setStoryboardIdea]=useState<{projectId:string;workspaceId:string;text:string}|null>(null);
  /* The draft each image tab was left with, so a tab switch returns to the same picture and preset. */
  const imageDraftMemory=useRef<Record<string,ImageDraft>>({});
  const [intentText,setIntentText]=useState(""),[intentMode,setIntentMode]=useState(()=>{try{return localStorage.getItem("comfyfield.intent-mode")==="1";}catch{return false;}});
  const [intentReference,setIntentReference]=useState<Asset|null>(null),[intentReferenceError,setIntentReferenceError]=useState(""),[intentUploading,setIntentUploading]=useState(false);
  const intentScope=useRef("");
  const intentReferenceGate=useRef(operationGate());
  const [error,setError]=useState(""),[version,setVersion]=useState(0),[checking,setChecking]=useState(false),[,setCharacterCount]=useState(0),[audioRequirements,setAudioRequirements]=useState<AudioRequirements|null>(null),[videoEditRequirements,setVideoEditRequirements]=useState<VideoEditRequirements|null>(null);
  const cloudDraftRef=useRef<{workspaceId:string;projectId:string;inputs:Record<string,string>;prompt:string}>();
  const [routerIncoming,setRouterIncoming]=useState<{workspaceId:string;projectId:string;inputs:Record<string,string>;prompt:string}>();
  const [routerImageTab,setRouterImageTab]=useState<ImageTab>("create");
  const [runOn,setRunOn]=useState<RunTarget>("local"),[askCloud,setAskCloud]=useState(false);
  useEffect(()=>{try{localStorage.setItem("comfyfield.intent-mode",intentMode?"1":"0");}catch{}},[intentMode]);
  const [settingsSection,setSettingsSection]=useState("account");
  const modelsReturnHash=useRef(sectionFromHash(location.hash)==="catalogue"?"#make":location.hash||"#make");
  const closeSettings=useCallback(()=>{setSettings(false);setSettingsSection("account");},[]);
  const openModels=useCallback(()=>{if(sectionFromHash(location.hash)!=="catalogue")modelsReturnHash.current=location.hash||"#make";setModelsOpen(true);},[]);
  const closeModels=useCallback(()=>{setModelsOpen(false);if(sectionFromHash(location.hash)==="catalogue")location.hash=modelsReturnHash.current.replace(/^#/,"")||"make";},[]);
  useEffect(()=>{if(!authorized)setSettings(false);},[authorized]);
  useEffect(()=>{if(!authorized)setModelsOpen(false);},[authorized]);
  useEffect(()=>{const update=()=>{const next=sectionFromHash(location.hash);setRouteHash(location.hash);setRoute(next);if(next==="catalogue")setModelsOpen(true);else modelsReturnHash.current=location.hash||"#make";const mode=videoModeFromHash(location.hash),workflow=videoWorkflowFromHash(location.hash);if(mode)setVideoMode(mode);else if(workflow)setVideoMode("create");setAddressWorkflow(workflow??null);};addEventListener("hashchange",update);return()=>removeEventListener("hashchange",update);},[]);
  useEffect(()=>{if(routeHash==="#video/transform/edit")location.hash="video/edit";},[routeHash]);
  useEffect(()=>{if(route==="influencer")setCharacterMode("scenes");},[route]);
  const refresh=useCallback(()=>setVersion(v=>v+1),[]);
  useEffect(()=>{if(!authorized)return;const timer=setInterval(refresh,60000);return()=>clearInterval(timer);},[authorized,refresh]);
  useEffect(()=>{if(!authorized){setAudioRequirements(null);return;}let current=true;void call<AudioRequirements>(workspacePath(workspace.id,"audio-requirements")).then(result=>{if(current)setAudioRequirements(result);}).catch(()=>{if(current)setAudioRequirements(null);});return()=>{current=false;};},[authorized,workspace.id,call,version]);
  useEffect(()=>{if(!authorized){setVideoEditRequirements(null);return;}let current=true;void call<VideoEditRequirements>(workspacePath(workspace.id,"video-extension-requirements")).then(result=>{if(current)setVideoEditRequirements(result);}).catch(()=>{/* Retain the inspected workspace during a transient outage; call owns the connection notice. */});return()=>{current=false;};},[authorized,workspace.id,call,version]);
  useEffect(()=>{
    if(!authorized)return;let current=true;
    void Promise.all([call<Project[]>(workspacePath(workspace.id,"projects")),call<Worker[]>(workspacePath(workspace.id,"workers")),call<Catalogue>(workspacePath(workspace.id,"catalogue"))]).then(([p,w,c])=>{if(!current)return;setProjects(p);setWorkers(w);setCatalogue(c);setProjectId(id=>p.some(p=>p.id===id)?id:p[0]?.id??"");setError("");}).catch(e=>{if(current)setError((e as Error).message);});
    return()=>{current=false;};
  },[call,workspace.id,version,authorized]);
  useEffect(()=>{if(route!=="video"&&route!=="motion"&&route!=="image")return;if(route==="video"&&(videoMode==="transform"||videoMode==="workflow"))return;setCapabilityId(id=>{const selected=catalogue.find(m=>m.id===id);if(selected&&(route==="image"?isImageCapability(selected):route==="motion"?selected.category==="motion":videoMode==="edit"?isMaskedEdit(selected):videoMode==="effects"?selected.id==="h3-effects":(isCreateVideoWorkflow(selected)&&isSelectedVideoCreate(selected.id))||capabilitySurface(selected)==="video-enhance"))return id;return (route==="image"?imageTabTarget("create",catalogue.filter(m=>m.coverage.local==="implemented"&&isImageCapability(m)))?.id:route==="video"&&videoMode!=="edit"&&videoMode!=="effects"?routeTask("video.create",catalogue.filter(m=>m.coverage.local==="implemented"))?.pack.id:undefined)??catalogue.find(m=>route==="image"?false:route==="motion"?m.coverage.local==="implemented"&&m.category==="motion":videoMode==="edit"?isMaskedEdit(m):videoMode==="effects"?m.coverage.local==="implemented"&&m.id==="h3-effects":m.coverage.local==="implemented"&&m.category==="t2v"&&isSelectedVideoCreate(m.id))?.id??"";});},[route,catalogue,videoMode]);
  /* A link may name the video workflow: `#video/camera`. It selects once the list is known, and an
     unknown id falls back to this screen's default. */
  useEffect(()=>{
    if(!addressWorkflow)return;
    const named=catalogue.find(m=>m.id===addressWorkflow);
    if(!named&&!catalogue.length)return;
    if(named&&route==="video"&&isVideoWorkflow(named)&&(named.id==="h3-effects"||!isCreateVideoWorkflow(named)||isSelectedVideoCreate(named.id))){setCapabilityId(named.id);setVideoMode(videoWorkflowMode(named));}
    setAddressWorkflow(null);
  },[addressWorkflow,catalogue,route]);
  useEffect(()=>{if(route!=="image")return;const named=catalogue.find(m=>m.id===routeHash.split("/")[1]&&isImageCapability(m));if(named)setCapabilityId(named.id);},[routeHash,route,catalogue]);
  const manifest=catalogue.find(m=>m.id===capabilityId),project=projects.find(p=>p.id===projectId);
  intentScope.current=`${workspace.id}:${project?.id??""}`;
  /* The Comfy account behind the cloud key, shown in the user menu. */
  const [account,setAccount]=useState<CloudAccountFacts|null>(null),[cloudSignIn,setCloudSignIn]=useState(reopenCloudSignIn),[guide,setGuide]=useState(false);
  useEffect(()=>{if(!authorized)return;let live=true;void call<NonNullable<typeof account>>(workspacePath(workspace.id,"cloud-account")).then(a=>{if(live)setAccount(a);}).catch(()=>{});return()=>{live=false;};},[authorized,workspace.id,call]);
  const cloudWorker=workers.find(isCloudWorker),runChoices=runTargetOptions(workers,route==="image"||route==="imageedit"||runOn==="chatgpt",user.guest?{signedIn:!!account?.connected,cloudJobs:account?.canSubmit!==false}:undefined),runWorkers=targetWorkers(workers,runOn==="router"?"local":runOn),cloudConsentKey=`comfyfield.cloud-consent:v1:${user.id}:${workspace.id}`;
  useEffect(()=>{if(runOn==="cloud"&&!cloudWorker){setRunOn("local");setAskCloud(false);}},[runOn,cloudWorker]);
  /* A signed-in guest always runs on their Comfy Cloud, also after a reload. */
  useEffect(()=>{if(!user.guest||!account?.connected)return;const cloudJobs=account.canSubmit!==false&&!!cloudWorker;if(runOn==="local"||runOn==="cloud"&&!cloudJobs)setRunOn(cloudJobs?"cloud":"router");},[user.guest,account?.connected,account?.canSubmit,cloudWorker,runOn]);
  /* The draft is set from the tab that is opening: its own earlier draft, or the picture already chosen on
     the tab being left. `imageDraft` is read once here on purpose, so it is not a dependency. */
  useEffect(()=>{if((route==="image"||route==="marketing"||route==="remix")&&manifest&&isImageCapability(manifest)){setImageDraft(imageDraftForTab(manifest,imageDraftMemory.current,imageDraft));setImageIntentKey("");}},[route,manifest?.id,manifest?.version]);
  const selectedImageIds=JSON.stringify(Object.values(imageDraft.inputs??{}).filter(Boolean).sort());
  const imageOutputIds=JSON.stringify(imageRuns.filter(run=>route==="image"&&imageTabFor(manifest?.id,route)==="create" ? imageTabFor(run.capability_id,route)==="create" && catalogue.some(m=>m.id===run.capability_id&&isImageCapability(m)) : run.capability_id===manifest?.id).flatMap(run=>run.output_ids));
  useEffect(()=>{
    if(!authorized||(route!=="image"&&route!=="marketing"&&route!=="remix")||!project)return;let current=true;
    void Promise.all([composerAssets(call,workspace.id,project.id,JSON.parse(selectedImageIds) as string[]),composerResultAssets(call,workspace.id,project.id,JSON.parse(imageOutputIds) as string[]).catch(e=>{if(current)setError((e as Error).message);return [] as Asset[];})])
      .then(([assets,outputs])=>{if(current)setImageAssets(mergeAssets(assets.items,outputs).filter(asset=>asset.media_type==="image"));})
      .catch(e=>{if(current)setError((e as Error).message);});
    return()=>{current=false;};
  },[authorized,route,project?.id,workspace.id,call,version,selectedImageIds,imageOutputIds]);
  useEffect(()=>{
    if(!authorized||(route!=="image"&&route!=="marketing"&&route!=="remix")||!project)return;let current=true;
    void call<Run[]>(workspacePath(workspace.id,`runs?projectId=${project.id}`))
      .then(runs=>{if(current)setImageRuns(runs);}).catch(e=>{if(current)setError((e as Error).message);});
    return()=>{current=false;};
  },[authorized,route,project?.id,workspace.id,call,version]);
  const canCreate=workspace.role!=="viewer"&&authorized&&!offline;
  /* A failed request is said in everyday words; the raw text waits behind Details (rule 36). */
  const failure=error?plainProblem(error):null;
  function pickRunOn(value:string){
    if(user.guest&&!account?.connected&&(value==="router"||value==="cloud")){setAskCloud(false);setCloudSignIn(true);return;}
    if(value==="chatgpt"){const incoming=route==="imageedit"&&location.hash.split("/")[1]?{inputs:{source_image:location.hash.split("/")[1]},prompt:""}:route==="image"?{inputs:imageDraft.inputs??{},prompt:String(imageDraft.controls.prompt??"")}:undefined;setRouterIncoming(incoming&&project?{...incoming,workspaceId:workspace.id,projectId:project.id}:undefined);setRouterImageTab("edit");setRunOn("chatgpt");setAskCloud(false);location.hash="imageedit";return;}
    if(value==="router"){let incoming:{inputs:Record<string,string>;prompt:string}|undefined;const local=cloudDraftRef.current;if(project&&local?.workspaceId===workspace.id&&local.projectId===project.id&&(videoMode==="replace"||(videoMode==="transform"&&changeChoiceFromHash(location.hash)==="person")))incoming=local;else if(route==="image")incoming={inputs:imageDraft.inputs??{},prompt:String(imageDraft.controls.prompt??"")};else if(project&&manifest&&videoMode==="create"){try{const d=JSON.parse(localStorage.getItem(draftKey(user.id,workspace.id,project.id,manifest.id))??"null");if(d?.inputs)incoming={inputs:d.inputs,prompt:String(d.controls?.prompt??"")};}catch{}}setRouterIncoming(incoming&&project?{...incoming,workspaceId:workspace.id,projectId:project.id}:undefined);setRunOn("router");setAskCloud(false);return;}
    if(value!=="cloud"){setRunOn("local");setAskCloud(false);return;}
    /* A hosted guest signs in with their own Comfy Cloud key instead of setting up a worker. */
    if(user.guest&&!account?.connected){setAskCloud(false);setCloudSignIn(true);return;}
    if(!cloudWorker){setAskCloud(false);setSettingsSection("workers");setSettings(true);return;}
    let accepted=false;try{accepted=localStorage.getItem(cloudConsentKey)==="yes";}catch{}
    if(accepted){setRunOn("cloud");setAskCloud(false);return;}
    setAskCloud(true);
  }
  /* A hosted guest has no worker to add: their worker is Comfy Cloud, reached by signing in. */
  function openWorkerSettings(){if(user.guest){setCloudSignIn(true);return;}setSettingsSection("workers");setSettings(true);}
  function useCloud(){try{localStorage.setItem(cloudConsentKey,"yes");}catch{}setAskCloud(false);setRunOn("cloud");}
  function keepLocal(){setAskCloud(false);setRunOn("local");}
  /* Signing in names the credits in its own words, so it is also the yes to running on Comfy Cloud. */
  async function signedInCloud(next:CloudAccountFacts){setAccount(next);setCloudSignIn(false);try{localStorage.setItem(cloudConsentKey,"yes");}catch{}const w=await call<Worker[]>(workspacePath(workspace.id,"workers")).catch(()=>null);if(w)setWorkers(w);setRunOn(next.canSubmit===false?"router":"cloud");}
  async function signOutCloud(){storeCloudKey("");await call(workspacePath(workspace.id,"cloud-key"),"DELETE").catch(()=>undefined);setAccount({connected:false});setRunOn("local");}
  const audioReady=canCreate&&audioRequirements?.state==="ready";
  const trimReady=workspace.role!=="viewer"&&authorized&&videoEditRequirements?.trim.state==="ready";
  async function createProject(name:string,description:string){setError("");try{const p=await call<Project>(workspacePath(workspace.id,"projects"),"POST",{name,description:description||undefined});setProjects(old=>[p,...old]);setProjectId(p.id);return true;}catch(e){setError((e as Error).message);return false;}}
  const statuses:Record<string,Readiness>=Object.fromEntries(catalogue.map(m=>{
    const readiness=bestWorkerReadiness(m,runWorkers);
    return [m.id,offline?{state:"offline",reasons:["The team server cannot confirm worker readiness."],missing:readiness.missing}:readiness];
  }));
  useEffect(()=>{
    if(route!=="marketing"&&route!=="remix")return;
    setCapabilityId(current=>selectAdModel(catalogue,statuses,current,routeHash.split("/")[1]??"",route==="remix"));
  },[route,routeHash,catalogue,workers,runOn,offline]);
  const readyImageWorkers=manifest&&isImageCapability(manifest)?runWorkers.filter(worker=>workerReadiness(manifest,worker).state==="ready").sort((a,b)=>a.id.localeCompare(b.id)):[];
  const imageWorker=readyImageWorkers[0];
  async function queueImage(target:Catalogue[number],draft:ImageDraft){
    if(!project||!canCreate||!isImageCapability(target))return;
    const worker=runWorkers.filter(candidate=>workerReadiness(target,candidate).state==="ready").sort((a,b)=>a.id.localeCompare(b.id))[0];
    const routeId=target.routes.find(candidate=>candidate.execution==="local_comfy"&&candidate.implementation==="implemented")?.id;
    if(!worker||!routeId)return;
    const idempotencyKey=imageIntentKey||crypto.randomUUID();setImageIntentKey(idempotencyKey);setImageBusy(true);setError("");
    try{
      const run=await call<Run>(workspacePath(workspace.id,"runs"),"POST",imageRunBody({projectId:project.id,workerId:worker.id,idempotencyKey,routeId},target,draft));
      setImageRuns(old=>[run,...old.filter(item=>item.id!==run.id)]);setImageIntentKey("");refresh();
    }catch(e){setError((e as Error).message);}finally{setImageBusy(false);}
  }
  async function cancelImageRun(run:Run){
    const result=await call<{state:string}>(workspacePath(workspace.id,`runs/${run.id}/cancel`),"POST");
    setImageRuns(old=>old.map(item=>item.id===run.id?{...item,state:result.state}:item));
    refresh();
  }
  async function retakeImage(run:Run){
    if(!manifest||!canCreate||imageBusy||imageIntentKey)return;
    setImageBusy(true);setError("");
    try{
      // The lightweight run list intentionally omits invocation. Fetch the
      // durable input snapshot instead of accidentally retrying today's draft.
      const original=await call<Run>(workspacePath(workspace.id,`runs/${run.id}`));
      const target=catalogue.find(m=>m.id===original.capability_id && isImageCapability(m));
      if(original.project_id!==project?.id||!target||!original.invocation)
        throw new Error("The original run inputs are not available for this workflow.");
      const next=restoreImageRetakeDraft(target,original.invocation);
      setImageDraft(next);imageDraftMemory.current[target.id]=next;
      if(target.id!==manifest.id){setCapabilityId(target.id);location.hash=nativeWorkflowHash(target);}
      await queueImage(target,next);
    }catch(error){setError((error as Error).message);}
    finally{setImageBusy(false);}
  }
  async function generateImage(draft:ImageDraft){
    if(!manifest)return;
    await queueImage(manifest,draft);
  }
  const inpaintManifest=catalogue.find(m=>m.id==="image-edit-sd21-inpaint"&&m.coverage.local==="implemented"),inpaintWorker=inpaintManifest?runWorkers.filter(worker=>workerReadiness(inpaintManifest,worker).state==="ready").sort((a,b)=>a.id.localeCompare(b.id))[0]:undefined,inpaintRouteId=inpaintManifest?.routes.find(r=>r.execution==="local_comfy"&&r.implementation==="implemented")?.id;
  const inpaintRoute=inpaintManifest&&inpaintWorker&&inpaintRouteId&&canCreate?{manifest:inpaintManifest,workerId:inpaintWorker.id,routeId:inpaintRouteId}:undefined;
  const routeFor=(id:string)=>{const m=catalogue.find(x=>x.id===id&&x.coverage.local==="implemented");if(!m||!canCreate)return undefined;const w=runWorkers.filter(worker=>workerReadiness(m,worker).state==="ready").sort((a,b)=>a.id.localeCompare(b.id))[0],r=m.routes.find(r=>r.execution==="local_comfy"&&r.implementation==="implemented")?.id;return w&&r?{manifest:m,workerId:w.id,routeId:r}:undefined;};
  /* The MiniMax H3 swap (OpenJutsu) is the Replace character engine when it is installed. */
  const openjutsuAdvanced=catalogue.find(m=>m.id==="openjutsu-h3-advanced"&&m.coverage.local==="implemented");const openjutsuLocal=catalogue.find(m=>m.id==="openjutsu-h3-swap");const openjutsuUsesLocal=!!openjutsuLocal&&!routeHash.startsWith("#openjutsu/cloud");const objectSwapLocal=catalogue.find(m=>m.id==="h3-object-swap");
  const replaceRoute=routeFor("scail2-character-replace"),swapMaskRoute=routeFor("sam31-video-mask"),swapEditRoute=routeFor("wan21-vace-masked-edit"),vfxRoute=routeFor("nvidia-vfx-upscale");
  // Prefer the local guided Qwen workflow for FotoField; it follows selected-object
  // replacement instructions on the verified cat-to-pumpkin case. Other models
  // remain available through the model selector and readiness determines fallback.
  const editRoutes=["qwen-image-21-edit","fibo2-edit","flux2-klein-edit"].map(routeFor).filter((route): route is NonNullable<typeof route> => !!route);
  const editRoute=editRoutes[0];
  const readyManifests=catalogue.filter(m=>statuses[m.id]?.state==="ready"),readyImages=readyManifests.filter(isImageCapability),shownImages=catalogue.filter(m=>m.coverage.local==="implemented"&&isImageCapability(m)),readyEdit=readyManifests.some(isMaskedEdit),readyMotion=readyManifests.some(m=>m.category==="motion"),readyEnhance=readyManifests.some(m=>m.category==="enhance"),readyEffects=readyManifests.some(m=>m.id==="h3-effects");
  /* The image screen's own tabs: the open workflow decides which one is on, and a tab for a tool that is not
     ready here is never drawn (rule 26). */
  const chatgptUnsupported=runOn==="chatgpt"&&["video","motion","3d","audio","characters","influencer"].includes(route);
  const chatgptPage=runOn==="chatgpt"&&(route==="image"||route==="imageedit");
  const routerPage=runOn==="router"&&!(route==="video"&&videoMode==="keyframes")&&["video","motion","image","imageedit","3d","audio","characters","influencer"].includes(route);
  const imageTabItems=runOn==="chatgpt"?[{id:"angles" as const,label:"Angles"},{id:"relight" as const,label:"Relight"}]:runOn==="router"?[{id:"create" as const,label:"Create"},{id:"angles" as const,label:"Angles"},{id:"relight" as const,label:"Relight"}]:imageTabs(shownImages),wantedImageTab=imageTabFor(manifest?.id,route),imageTab=imageTabItems.some(item=>item.id===wantedImageTab)?wantedImageTab:imageTabItems[0]?.id??"create";
  /* Block a shot hands its grey layout to Grey-block to video when that is ready here. */
  const previsTarget=routeTask("video.previs",readyManifests)?.pack;
  const intentImage=imageTabTarget("create",readyImages),intentVideo=routeTask("video.create",readyManifests)?.pack,intentMotion=readyManifests.find(m=>m.category==="motion");
  const intentAvailable={image:intentReference?!!intentImageReferenceTarget(readyImages):!!intentImage,"image-edit":!!intentImageReferenceTarget(readyImages,manifest?.id),video:intentReference?!!routeImageToVideo(readyManifests.filter(isCreateVideoWorkflow)):!!intentVideo,motion:!!intentMotion,edit:readyEdit,trim:trimReady,storyboard:!!project&&canCreate,audio:audioReady};
  /* Only leave a mode the person asked for once readiness is actually known. On a reload or a deep
     link the catalogue is still empty for a moment, and falling back then dropped `#video/effects`
     and `#video/edit` into Create even when those modes were ready a second later.
     Trim keeps its mode: an unready `#video/trim` names what is missing instead of switching. */
  useEffect(()=>{
    if(!catalogue.length)return;
    if((videoMode==="effects"&&!readyEffects))setVideoMode("create");
  },[videoMode,readyEdit,readyEffects,catalogue.length,capabilityId,route]);
  const choose=(id:string)=>{const selected=catalogue.find(m=>m.id===id);if(!selected||statuses[id]?.state!=="ready")return;setCapabilityId(id);if(isImageCapability(selected))setImageDraft(defaultImageDraft(selected));setVideoMode(videoWorkflowMode(selected));location.hash=nativeWorkflowHash(selected);};
  /** A workflow picked on the video screen takes its place in the address, so reload and back keep it. */
  const chooseWorkflow=(id:string)=>{setCapabilityId(id);if(route==="video"&&(videoMode==="create"||videoMode==="workflow"))location.hash=videoWorkflowHash(id);};
  /** An All tools card opens its screen: a task that names one workflow selects it, every other card starts from that screen's default. */
  const openStartTask=(task:StartTask)=>{const target=task.workflow?routeFor(task.workflow):undefined;setCapabilityId(target?.manifest.id??"");location.hash=task.href.slice(1);};
  async function useImageInVideo(assetId:string){
    if(!project||!canCreate)return;
    const selected=routeImageToVideoDraft(readyManifests.filter(isCreateVideoWorkflow),catalogue.filter(m=>m.coverage.local==="implemented"&&isCreateVideoWorkflow(m))),target=selected?.pack;
    if(!target||!selected){setError("An image-to-video workflow is required to use this image.");return;}
    setError("");
    try{
      const asset=await call<Asset>(workspacePath(workspace.id,`assets/${assetId}`));
      if(asset.project_id!==project.id||asset.media_type!=="image"||!asset.content_type.startsWith("image/"))throw new Error("Choose a generated image in this project.");
      const key=draftKey(user.id,workspace.id,project.id,target.id);
      if(sessionStorage.getItem(`${key}:intent`)||localStorage.getItem(`${key}:intent`))throw new Error("Resolve the pending video submission before changing its source image.");
      const draft=restoreDraft(target,JSON.parse(localStorage.getItem(key)??"null"));
      draft.inputs[selected.inputId]=assetId;delete draft.elementInputs[selected.inputId];
      if(!String(draft.controls.prompt??"").trim())draft.controls.prompt="Animate this shot with subtle natural movement.";
      localStorage.setItem(key,JSON.stringify(draft));setCapabilityId(target.id);setVideoMode("create");location.hash="video";
    }catch(e){setError((e as Error).message);}
  }
  async function useAudioInLipSync(assetId:string,imageAssetId?:string){
    if(!project||!canCreate)return;
    const target=readyManifests.find(m=>!!m.voiceContract);
    if(!target){setError("A ready local lip-sync workflow is required.");return;}
    setError("");
    try{
      const asset=await call<Asset>(workspacePath(workspace.id,`assets/${assetId}`));
      if(asset.project_id!==project.id||asset.media_type!=="audio")throw new Error("Choose an audio take in this project.");
      if(!["audio/wav","audio/x-wav"].includes(asset.content_type))throw new Error("Use a saved microphone take or mono PCM16 WAV for local lip sync.");
      let imageInput="";
      if(imageAssetId){const image=await call<Asset>(workspacePath(workspace.id,`assets/${imageAssetId}`));if(image.project_id!==project.id||image.media_type!=="image"||!image.content_type.startsWith("image/"))throw new Error("Choose a portrait image in this project.");imageInput=target.inputs.find(input=>input.type==="image"&&input.required)?.id??"";if(!imageInput)throw new Error("The local lip-sync workflow does not accept a portrait image.");}
      const key=draftKey(user.id,workspace.id,project.id,target.id);
      if(sessionStorage.getItem(`${key}:intent`)||localStorage.getItem(`${key}:intent`))throw new Error("Resolve the pending lip-sync submission before changing its audio.");
      const draft=defaultDraft(target);draft.inputs[target.voiceContract!.audioInput]=assetId;if(imageInput)draft.inputs[imageInput]=imageAssetId!;
      localStorage.setItem(key,JSON.stringify(draft));setCapabilityId(target.id);setVideoMode("create");location.hash="video";
    }catch(e){setError((e as Error).message);}
  }
  function prefillComposer(target:Catalogue[number],text:string){
    if(!project||!target.controls.some(c=>c.id==="prompt"))return;
    const draft=defaultDraft(target);draft.controls.prompt=text;
    try{localStorage.setItem(draftKey(user.id,workspace.id,project.id,target.id),JSON.stringify(draft));}catch{}
  }
  useEffect(()=>{invalidateOperation(intentReferenceGate.current);setIntentUploading(false);setIntentReference(null);setIntentReferenceError("");},[workspace.id,project?.id]);
  function acceptIntentReference(asset:Asset){
    if(!project||asset.media_type!=="image"||!asset.content_type.startsWith("image/")||(asset.project_id!==null&&asset.project_id!==project.id))throw new Error("Choose an image from this project.");
    setIntentReference(asset);setIntentReferenceError("");
  }
  function clearIntentReference(){invalidateOperation(intentReferenceGate.current);setIntentUploading(false);setIntentReference(null);setIntentReferenceError("");}
  async function intentAsset(id:string){if(!project)return;const scope=intentScope.current,epoch=beginOperation(intentReferenceGate.current,"reference");setIntentUploading(true);setIntentReferenceError("");try{const asset=await call<Asset>(workspacePath(workspace.id,`assets/${encodeURIComponent(id)}`));if(currentIntentReference(intentReferenceGate.current,epoch,scope,intentScope.current))acceptIntentReference(asset);}catch(e){if(currentIntentReference(intentReferenceGate.current,epoch,scope,intentScope.current))setIntentReferenceError((e as Error).message);}finally{if(finishOperation(intentReferenceGate.current,epoch))setIntentUploading(false);}}
  async function intentFile(file:File){if(!project||!canCreate)return;const scope=intentScope.current,epoch=beginOperation(intentReferenceGate.current,"reference");setIntentUploading(true);setIntentReferenceError("");try{if(!["image/png","image/jpeg","image/webp"].includes(file.type))throw new Error("Choose a PNG, JPEG or WebP image.");const form=new FormData();form.append("file",file);const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${project.id}`),"POST",form);if(currentIntentReference(intentReferenceGate.current,epoch,scope,intentScope.current))acceptIntentReference(asset);}catch(e){if(currentIntentReference(intentReferenceGate.current,epoch,scope,intentScope.current))setIntentReferenceError((e as Error).message);}finally{if(finishOperation(intentReferenceGate.current,epoch))setIntentUploading(false);}}
  function runIntent(target:Exclude<IntentTarget,"unknown">){
    const text=intentText.trim();if(!text)return;
    if(target==="storyboard"){
      if(!project||!canCreate)return;
      if(text.length>4000){setIntentReferenceError("Keep the storyboard idea under 4,000 characters.");return;}
      if(storyboardIdea||storyboardImage){setIntentReferenceError("Finish the pending storyboard handoff first.");return;}
      if(intentReference&&(intentReference.project_id!==project.id||intentReference.media_type!=="image"||!intentReference.content_type.startsWith("image/"))){setIntentReferenceError("Choose an image from this project.");return;}
      setStoryboardIdea({workspaceId:workspace.id,projectId:project.id,text});
      if(intentReference)setStoryboardImage({workspaceId:workspace.id,projectId:project.id,assetId:intentReference.id});
      setVideoMode("storyboard");location.hash="video/storyboard";setIntentReference(null);setIntentReferenceError("");return;
    }
    if(intentReference){
      if(!project||!canCreate)return;
      try{
        if(target==="image"){
          if(imageIntentKey||imageBusy)throw new Error("Resolve the pending image request first.");
          const selected=intentImageReferenceTarget(readyImages,manifest?.id);
          const port=selected?.inputs.find(p=>p.id==="source_image"&&assetMatchesPort(intentReference,p));
          if(!selected||!port)throw new Error("A ready compatible image edit model is needed.");
          const draft=imageDraftMemory.current[selected.id]??defaultImageDraft(selected);
          const next=intentReferenceDraft(draft,port.id,intentReference.id,text,String(defaultImageDraft(selected).controls.prompt??""));
          imageDraftMemory.current[selected.id]=next;setImageDraft(next);setImageIntentKey("");setRunOn("local");setCapabilityId(selected.id);location.hash=nativeWorkflowHash(selected);setIntentReference(null);setIntentReferenceError("");return;
        }
        if(target==="video"){
          const active=manifest&&isCreateVideoWorkflow(manifest)&&statuses[manifest.id]?.state==="ready"?routeImageToVideo([manifest]):undefined;
          const selected=active??routeImageToVideo(readyManifests.filter(isCreateVideoWorkflow));
          if(!selected)throw new Error("A ready image-to-video workflow is needed.");
          const port=selected.pack.inputs.find(p=>p.id===selected.inputId);
          if(!port||!assetMatchesPort(intentReference,port))throw new Error("The reference is incompatible with this video model.");
          const key=draftKey(user.id,workspace.id,project.id,selected.pack.id);
          if(sessionStorage.getItem(`${key}:intent`)||localStorage.getItem(`${key}:intent`))throw new Error("Resolve the pending video request first.");
          const draft=restoreDraft(selected.pack,JSON.parse(localStorage.getItem(key)??"null"));
          const next=intentReferenceDraft(draft,port.id,intentReference.id,text,String(defaultDraft(selected.pack).controls.prompt??""));
          localStorage.setItem(key,JSON.stringify(next));setRunOn("local");setCapabilityId(selected.pack.id);setVideoMode("create");location.hash="video";setIntentReference(null);setIntentReferenceError("");return;
        }
        throw new Error("Choose Image or Video to use this image reference.");
      }catch(e){setIntentReferenceError((e as Error).message);return;}
    }
    if(target==="image-edit"){
      if(imageIntentKey||imageBusy){setIntentReferenceError("Resolve the pending image request first.");return;}
      const selected=intentImageReferenceTarget(readyImages,manifest?.id);if(!selected)return;
      try{
        const draft=imageDraftMemory.current[selected.id]??defaultImageDraft(selected),next=intentPromptDraft(draft,text,String(defaultImageDraft(selected).controls.prompt??""));
        imageDraftMemory.current[selected.id]=next;setImageDraft(next);setImageIntentKey("");setRunOn("local");setCapabilityId(selected.id);location.hash=nativeWorkflowHash(selected);setIntentReferenceError("");
      }catch(e){setIntentReferenceError((e as Error).message);}return;
    }
    if(target==="image"&&intentImage){const draft=defaultImageDraft(intentImage);draft.controls.prompt=text;setCapabilityId(intentImage.id);setImageDraft(draft);setImageIntentKey("");location.hash="image";void queueImage(intentImage,draft);return;}
    if(target==="video"&&intentVideo){prefillComposer(intentVideo,text);setCapabilityId(intentVideo.id);setVideoMode("create");location.hash="video";return;}
    if(target==="motion"&&intentMotion){prefillComposer(intentMotion,text);setCapabilityId(intentMotion.id);location.hash="motion";return;}
    if(target==="edit"){const masked=readyManifests.find(isMaskedEdit);if(masked)prefillComposer(masked,text);setVideoMode("edit");location.hash="video/edit";return;}
    if(target==="trim"&&trimReady){setVideoMode("trim");location.hash="video";return;}
    if(target==="audio"&&audioReady){location.hash="audio";}
  }
  const recheck=useCallback(async()=>{setChecking(true);setError("");try{
    const result=await refreshWorkerInventory(workers,workspace.role==="admin",w=>call(workspacePath(workspace.id,`workers/${w.id}/probe`),"POST"),()=>call<Worker[]>(workspacePath(workspace.id,"workers")));
    setWorkers(result.workers);if(result.probeError)setError((result.probeError as Error).message);
  }catch(e){setWorkers([]);setError((e as Error).message);}finally{setChecking(false);}},[workers,call,workspace.id,workspace.role]);
  const videoMenu={
    features:[
      {id:"openjutsu",icon:<Sparkles size={18}/>,title:"OpenJutsu · H3 API",text:"Experimental character/reference video generation through Comfy Router",onSelect:()=>{location.hash="openjutsu";}},
      {id:"create",icon:<Video size={18}/>,title:"Create Video",text:"Generate video from text or images",onSelect:()=>{setVideoMode("create");setCapabilityId("");location.hash="video";}},
      ...(trimReady?[{id:"trim",icon:<Scissors size={18}/>,title:"Trim Video",text:"Cut an exact decoded frame range locally",onSelect:()=>{setVideoMode("trim");location.hash="video";}}]:[]),
      ...(swapMaskRoute&&swapEditRoute?[{id:"edit",icon:<Sparkles size={18}/>,title:"Edit Area",text:"Edit a selected area of your video",onSelect:()=>{setVideoMode("edit");location.hash="video/edit";}}]:[]),
      {id:"storyboard",icon:<Clapperboard size={18}/>,title:"Storyboard",text:"Plan shots and assemble them into one video",onSelect:()=>{setVideoMode("storyboard");location.hash="video";}},
      {id:"transform",icon:<Sparkles size={18}/>,title:"Transform Video",text:"Transfer motion, swap objects or restyle a video",onSelect:()=>{setVideoMode("transform");location.hash="video";}},
      ...(readyMotion?[{id:"motion",icon:<Move size={18}/>,title:"Motion Control",text:"Transfer motion from a video to a character",onSelect:()=>{location.hash="motion";}}]:[]),
      ...(readyEnhance?[{id:"enhance",icon:<Maximize2 size={18}/>,title:"Video Upscale",text:"Enhance video quality",onSelect:()=>{setVideoMode("create");setCapabilityId(readyManifests.find(m=>m.category==="enhance")?.id??"");location.hash="video";}}]:[]),
    ],
    models:readyManifests.filter(m=>isVideoWorkflow(m)&&(capabilitySurface(m)!=="video-create"||isSelectedVideoCreate(m.id))).map(m=>({id:m.id,icon:<Sparkles size={18}/>,title:m.title.split(" (")[0],text:capabilityPurpose(m),onSelect:()=>choose(m.id)})),
  };
  const threeDMenu={features:NATIVE_THREE_D_TOOLS.map(tool=>({id:tool.id,icon:<Box size={18}/>,title:tool.title,text:tool.text,onSelect:()=>{location.hash=`3d/${tool.id}`;}})),models:[]};
  /* The Image menu lists what exists, not only what the worker answers for right now: the page itself says when ComfyUI is offline. Editing lives in FotoField. */
  const menuImages=catalogue.filter(m=>m.coverage.local==="implemented"&&isImageCapability(m)),menuCreate=imageTabTarget("create",menuImages);
  const imageMenu={
    features:[...(menuCreate?[{id:"create-image",icon:<ImageIcon size={18}/>,title:"Create Image",text:"Generate a durable image with local ComfyUI",onSelect:()=>{setCapabilityId(menuCreate.id);location.hash="image";}}]:[]),...menuImages.filter(m=>["flux2-klein-angles","flux2-klein-relight"].includes(m.id)).map(m=>({id:m.id,icon:<ImageIcon size={18}/>,title:m.id.endsWith("angles")?"Camera angles":"Relight",text:m.id.endsWith("angles")?"Explore another view of your image":"Change light and atmosphere",onSelect:()=>choose(m.id)}))],
    models:menuImages.map(m=>({id:m.id,icon:<Sparkles size={18}/>,title:m.title.split(" (")[0],text:capabilityPurpose(m),onSelect:()=>choose(m.id)})),
  };
  /* All tools lists every tool the app has a workflow for, not only those this computer answers for right now: the page of a tool says when ComfyUI is offline. */
  const implemented=catalogue.filter(m=>m.coverage.local==="implemented");
  const listedTools={remiximage:readyManifests.some(remixImageModel),adimage:readyManifests.some(adImageModel),h3effects:readyEffects,replace:implemented.some(m=>m.id==="scail2-character-replace"),motion:implemented.some(m=>m.category==="motion"),effects:implemented.some(m=>capabilitySurface(m)==="video-effect"),edit:implemented.some(isMaskedEdit),vfx:implemented.some(m=>m.id==="nvidia-vfx-upscale"),video:implemented.some(m=>isCreateVideoWorkflow(m)),image:shownImages.length>0,audio:implemented.some(m=>m.category==="audio"||/chatterbox|lip-?sync|speech/.test(m.id))};
  const section=sectionOf(route);
  /* List-only areas keep a page hero. Production tools own their hero inside the shared right column. */
  const pageHeroKind:HeroKind|undefined=route==="library"?"library":route==="characters"?"cast":route==="influencer"?"scenes":undefined;
  useDensity();
  /* One answer for a hash that names no screen or a screen this computer cannot run yet. */
  const fallback=routeState({
    section:route,mode:videoMode,hash:routeHash,workflowIds:catalogue.filter(m=>route==="video"?isVideoWorkflow(m):route==="image"?isImageCapability(m):true).map(m=>m.id),canCreate,
    catalogueKnown:offline||!authorized||catalogue.length>0,
    video:catalogue.some(m=>m.coverage.local==="implemented"&&(isCreateVideoWorkflow(m)||capabilitySurface(m)==="video-enhance")),motion:catalogue.some(m=>m.coverage.local==="implemented"&&m.category==="motion"),image:catalogue.some(m=>m.coverage.local==="implemented"&&(route==="remix"?remixImageModel(m):route==="marketing"?adImageModel(m):isImageCapability(m))),
    audioKnown:!authorized||!!audioRequirements,audio:audioReady,
    trimKnown:!authorized||!!videoEditRequirements,trim:trimReady,
  });
  /* While the server is away the problem bar already states the cause, so the body waits quietly. */
  const waiting=offline||!authorized||(!!error&&!catalogue.length);
  const fallbackNext=fallback.kind==="missing"&&!waiting?fallback.next:undefined;
  const fallbackTitle=waiting?"Waiting for the team server":fallback.kind==="missing"?fallback.title:"Checking what this computer can run";
  const fallbackText=fallback.kind==="missing"&&!waiting?fallback.text:undefined;
  const studioPages=["characters"];
  const topCurrent=modelsOpen?"#catalogue":studioPages.includes(section)?"#studios":`#${route==="openjutsu"?"video":route}`;
  async function savePreviewCrop(file:File){
    if(!canCreate||!project)throw new Error("Choose a project with creator access to save a crop.");
    const form=new FormData();form.append("file",file);
    const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${project.id}`),"POST",form);
    refresh();return {src:`/api/v1${workspacePath(workspace.id,`assets/${asset.id}/content`)}`,name:asset.name};
  }
  /* Change a video is one screen: the panel and the results pane beside it stay, only the tool body swaps
     inside them, and the pane keeps showing the runs of the tool that is open. */
  const changeScreen=(target:Project,tool:"person"|"swap"|"edit",body:ReactNode)=>
    <div className="cf-production"><Panel>{body}</Panel><ProductionContent><TeamRuns examples="video" workspace={workspace} project={target} call={call} canEdit={canCreate} authorized={authorized} version={version} user={user} hero={latest=><ToolHero latest={latest} kind={tool==="person"?"replace":tool} workflowId={tool==="person"?replaceRoute?.manifest.id:swapEditRoute?.manifest.id}/>} titles={catalogueTitles(catalogue)} capabilityId={tool==="person"?["scail2-character-replace","local-jutsu-replace","openjutsu-h3-swap",...CLOUD_REPLACE_MODELS]:[swapEditRoute?.manifest.id??"","wan21-vace-masked-edit-reference"]} feed={feedScope(catalogue,"video",tool==="person"?["scail2-character-replace","local-jutsu-replace","openjutsu-h3-swap",...CLOUD_REPLACE_MODELS]:[swapEditRoute?.manifest.id??"","wan21-vace-masked-edit-reference"])}/></ProductionContent></div>;
  /** The project asset behind a preview. A preview that is not in the project yet is imported first. */
  async function mediaAssetId(source:{src:string;name:string}):Promise<string>{
    if(!canCreate||!project)throw new Error("Choose a project with creator access to use media.");
    const url=new URL(source.src,location.href),prefix=`/api/v1${workspacePath(workspace.id,"assets/")}`;
    const known=url.origin===location.origin&&url.pathname.startsWith(prefix)?url.pathname.slice(prefix.length).match(/^([^/]+)\/content$/)?.[1]:undefined;
    if(known)return known;
    if(url.origin!==location.origin&&url.protocol!=="blob:")throw new Error("Import this media into the project before using it.");
    const response=await fetch(source.src);if(!response.ok)throw new Error("Could not read this preview.");
    const blob=await response.blob(),form=new FormData();form.append("file",new File([blob],source.name,{type:blob.type}));
    const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${project.id}`),"POST",form);refresh();return asset.id;
  }
  async function editPreview(source:MediaEditSource){
    try{
      const id=await mediaAssetId(source);
      if(source.mediaType==="video"){setVideoMode("trim");location.hash=`video/trim/${id}`;}
      else {
        if(source.intent==="annotate")sessionStorage.setItem(annotationStorageKey(workspace.id,id),JSON.stringify(imageAnnotationsSchema.parse(source.annotations)));
        location.hash=`imageedit/${id}${source.intent==="annotate"?"/annotate":source.intent==="modify"?"/modify":""}`;
      }
    }catch(cause){setError((cause as Error).message);throw cause;}
  }
  /** Fills a tool's draft with a picture or clip and tells an open composer to take it; the tool's screen then shows it. */
  function presetTool(target:Catalogue[number],inputs:Record<string,string>,controls:Record<string,string|number|boolean>={}){
    if(!project)throw new Error("Choose a project first.");
    const key=draftKey(user.id,workspace.id,project.id,target.id);
    if(sessionStorage.getItem(`${key}:intent`)||localStorage.getItem(`${key}:intent`))throw new Error("Finish or resolve the pending request in that tool first.");
    const draft=restoreDraft(target,JSON.parse(localStorage.getItem(key)??"null"));
    Object.assign(draft.inputs,inputs);for(const port of Object.keys(inputs))delete draft.elementInputs[port];Object.assign(draft.controls,controls);
    localStorage.setItem(key,JSON.stringify(draft));window.dispatchEvent(new CustomEvent("cf-draft-preset",{detail:key}));
  }
  /* Where a picture or clip can go from the full view. A tool that is not ready here is never offered (rule 26). */
  const mediaTools=(media:{src:string;name:string;mediaType:"image"|"video"}):MediaToolSet|undefined=>{
    if(!project)return undefined;
    const image=media.mediaType==="image";
    const animateTarget=canCreate&&image?routeImageToVideo(readyManifests.filter(isCreateVideoWorkflow)):undefined;
    const motionTarget=selectTransformManifest(catalogue,statuses,"motion"),restyleTarget=selectTransformManifest(catalogue,statuses,"restyle");
    const motionReady=canCreate&&!!motionTarget&&statuses[motionTarget.id]?.state==="ready"&&motionTarget.category==="motion",restyleReady=canCreate&&!!restyleTarget&&statuses[restyleTarget.id]?.state==="ready"&&capabilitySurface(restyleTarget)==="video-effect";
    const send=(target:Catalogue[number],port:string,hash:string,mode?:typeof videoMode)=>async()=>{
      const id=await mediaAssetId(media);presetTool(target,{[port]:id});setCapabilityId(target.id);if(mode)setVideoMode(mode);location.hash=hash;
    };
    const animate=animateTarget?send(animateTarget.pack,animateTarget.inputId,videoWorkflowHash(animateTarget.pack.id),"create"):undefined;
    const toMotion=motionReady?send(motionTarget!,image?"start_image":"motion_video","video/transform/motion","transform"):undefined;
    const openIn:NonNullable<MediaToolSet["openIn"]>=[
      ...(animate&&animateTarget?[{id:"animate",label:"Make a video",note:"Image to video",icon:<Video size={16}/>,run:animate}]:[]),
      ...(toMotion?[{id:"motion",label:"Motion transfer",note:image?"As the character picture":"As the driving video",icon:<Footprints size={16}/>,run:toMotion}]:[]),
      ...(!image&&restyleReady?[{id:"restyle",label:"Restyle",note:"As the source clip",icon:<Palette size={16}/>,run:send(restyleTarget!,"source_video","video/transform/restyle","transform")}]:[]),
    ];
    const upscaleTarget=canCreate&&!image&&vfxRoute?vfxRoute.manifest:undefined;
    const known=(()=>{try{const url=new URL(media.src,location.href);return url.origin===location.origin&&url.pathname.startsWith(`/api/v1${workspacePath(workspace.id,"assets/")}`)?url.pathname.slice(`/api/v1${workspacePath(workspace.id,"assets/")}`.length).match(/^([^/]+)\/content$/)?.[1]:undefined;}catch{return undefined;}})();
    return {
      ...(animate?{animate}:{}),
      ...(openIn.length?{openIn}:{}),
      ...(image&&toMotion?{reference:[{id:"motion",label:"Motion transfer",note:"As the character picture",icon:<Footprints size={16}/>,run:toMotion}]}:{}),
      ...(upscaleTarget?{upscale:send(upscaleTarget,"source_video","video/create","create")}:{}),
      ...(known?{downloadHref:assetUrl(workspace.id,known,true)}:{}),
      ...(known?{generation:async()=>{
        const asset=await call<Asset>(workspacePath(workspace.id,`assets/${encodeURIComponent(known)}`));
        const generated=asset.metadata?.generatedBy as {producerRunId?:unknown;runId?:unknown}|undefined;
        let runId=generated?.producerRunId??generated?.runId;
        if(typeof runId!=="string"){
          const runs=await call<Run[]>(workspacePath(workspace.id,`runs?projectId=${encodeURIComponent(project.id)}`));
          runId=runs.find(item=>item.output_ids.includes(known))?.id;
        }
        if(typeof runId!=="string")return undefined;
        const run=await call<Run>(workspacePath(workspace.id,`runs/${encodeURIComponent(runId)}`));
        if(!run.output_ids.includes(known))return undefined;
        const manifest=catalogue.find(item=>item.id===run.capability_id),model=manifest?.title??run.capability_id;
        const controls=run.invocation?.controls??{};
        const facts=[
          ...(typeof controls.width==="number"&&typeof controls.height==="number"?[{label:"Quality",value:`${controls.width} × ${controls.height}`}]:controls.megapixels!==undefined?[{label:"Quality",value:`${controls.megapixels} MP`}]:controls.resolution!==undefined?[{label:"Quality",value:String(controls.resolution)}]:[]),
          ...(controls.aspect_ratio!==undefined?[{label:"Format",value:String(controls.aspect_ratio).replace(/ \(.*\)$/ ,"")}]:[]),
          ...(controls.length!==undefined?[{label:"Length",value:`${controls.length} s`}]:[]),
          ...(controls.seed!==undefined?[{label:"Seed",value:String(controls.seed)}]:[]),
          {label:"Ran on",value:runLocation(run.transport,!!workers.find(worker=>worker.id===run.worker_id&&isCloudWorker(worker)))},
        ];
        const inputs=Object.entries(run.invocation?.inputs??{}).filter((entry):entry is [string,string]=>typeof entry[1]==="string"&&!!entry[1]).map(([port,id])=>({src:assetUrl(workspace.id,id),label:port.replaceAll("_"," "),video:/video|clip/i.test(port)}));
        return {model,mode:manifest?feedMode(manifest):undefined,prompt:typeof controls.prompt==="string"?controls.prompt:undefined,facts,inputs,date:new Date(run.created_at).toLocaleString(),recreate:canCreate?recreate(run):undefined};
      }}:{}),
    };
  };
  /* Restore a finished run's recorded inputs and settings in its original tool.
     Multi-step tools without a complete draft mapping offer no recreate action. */
  const recreatePlace=(m:Catalogue[number])=>{
    if(m.id==="openjutsu-h3-swap")return {hash:"openjutsu",mode:"transform" as const};
    if(m.category==="motion")return {hash:"video/transform/motion",mode:"transform" as const};
    if(isMaskedEdit(m))return swapMaskRoute&&swapEditRoute?{hash:"video/edit",mode:"edit" as const}:undefined;
    const surface=capabilitySurface(m);
    if(surface==="video-effect")return {hash:"video/transform/restyle",mode:"transform" as const};
    if(isCreateVideoWorkflow(m)||surface==="video-enhance")return {hash:videoWorkflowHash(m.id),mode:"create" as const};
    /* Every other workflow has its own setup page, which reads the same draft. */
    return {hash:`workflow/${m.id}`,mode:undefined};
  };
  const recreate:RecreateRun=run=>{
    if(!canCreate||!project||run.state!=="succeeded"||!run.invocation)return undefined;
    const target=catalogue.find(m=>m.id===run.capability_id);
    /* Opening the setup needs no ready worker: the tool itself says what is missing before it can run. */
    if(!target)return undefined;
    if(run.project_id!==project.id)return undefined;
    if(isImageCapability(target))return ()=>{
      const recorded=Object.fromEntries(Object.entries(run.invocation!.controls).filter(([id,value])=>["string","number","boolean"].includes(typeof value)&&target.controls.some(control=>control.id===id))) as ImageDraft["controls"];
      const inputs=Object.fromEntries(Object.entries(run.invocation!.inputs).filter(([id,value])=>typeof value==="string"&&value&&target.inputs.some(port=>port.id===id)));
      const presetId=(run.invocation as typeof run.invocation & {presetId?:string}).presetId;
      const draft={...defaultImageDraft(target),controls:{...defaultImageDraft(target).controls,...recorded},inputs,...(presetId&&target.presets.some(preset=>preset.id===presetId)?{presetId}:{})};
      imageDraftMemory.current[target.id]=draft;setImageDraft(draft);setImageIntentKey("");setCapabilityId(target.id);location.hash=nativeWorkflowHash(target);
    };
    const place=recreatePlace(target),invocation=run.invocation;
    if(!place)return undefined;
    return ()=>{
      const inputs=Object.fromEntries(Object.entries(invocation.inputs).filter(([port,id])=>typeof id==="string"&&id&&target.inputs.some(item=>item.id===port)));
      const controls=Object.fromEntries(Object.entries(invocation.controls).filter(([id,value])=>["string","number","boolean"].includes(typeof value)&&target.controls.some(control=>control.id===id))) as Record<string,string|number|boolean>;
      try{presetTool(target,inputs,controls);}catch(cause){setError((cause as Error).message);return;}
      setCapabilityId(target.id);if(place.mode)setVideoMode(place.mode);location.hash=place.hash;
    };
  };
  const recreateMedia:RecreateMedia=request=>{
    let setup:Exclude<typeof request,{example:unknown}>|undefined;
    if("example" in request){
      const {example}=request,implemented=(m:Catalogue[number])=>m.coverage.local==="implemented";
      const target=example.kind==="image"?["qwen-image-21-edit","fibo2-edit","flux2-klein-edit"].map(id=>catalogue.find(m=>m.id===id&&implemented(m))).find(m=>!!m&&isImageCapability(m)):selectTransformManifest(catalogue,statuses,"restyle");
      const port=target?.inputs.find(item=>item.type===example.kind)?.id;
      if(target&&port)setup={capabilityId:target.id,inputs:{[port]:{src:example.src,name:example.name}}};
    }else setup=request;
    const target=setup&&catalogue.find(m=>m.id===setup.capabilityId);
    if(!canCreate||!project||!setup||!target)return undefined;
    const image=isImageCapability(target),place=image?undefined:recreatePlace(target),files=setup.inputs,controls=setup.controls??{};
    if(!image&&!place)return undefined;
    return async()=>{
      const inputs:Record<string,string>={};
      for(const [port,media] of Object.entries(files))if(target.inputs.some(item=>item.id===port))inputs[port]=await mediaAssetId(media);
      if(image){
        const base=defaultImageDraft(target),draft={...base,controls:{...base.controls,...Object.fromEntries(Object.entries(controls).filter(([id])=>target.controls.some(control=>control.id===id)))} as ImageDraft["controls"],inputs};
        imageDraftMemory.current[target.id]=draft;setImageDraft(draft);setImageIntentKey("");setCapabilityId(target.id);location.hash=nativeWorkflowHash(target);return;
      }
      presetTool(target,inputs,controls);setCapabilityId(target.id);if(place!.mode)setVideoMode(place!.mode);location.hash=place!.hash;
    };
  };
  /* A screen whose content fills the work area declares it on its page, and the WorkspaceBar reads only that
     declaration (rule 35), so no DS rule keeps a list of screen names. Reading pages stay capped. */
  const fillPage=route==="workflow"||route==="block"||route==="imageedit"||((route==="image"||route==="marketing"||route==="remix")&&!!manifest)
    ||(route==="video"&&(videoMode==="storyboard"||videoMode==="keyframes"||videoMode==="transform"||videoMode==="replace"||videoMode==="edit"))
    ||((route==="video"||route==="motion")&&!!manifest);
  return <div className="cf-team">
    <Welcome tools={startTasks(listedTools)} onOpen={openStartTask} onCloud={user.guest&&!account?.connected?()=>setCloudSignIn(true):undefined}/>
    {guide&&<Guide hosted={!!user.guest} cloudConnected={!!account?.connected} onClose={()=>setGuide(false)} onCloudSignIn={user.guest?()=>{setGuide(false);setCloudSignIn(true);}:undefined} onOpenWorkers={user.guest||workspace.role!=="admin"?undefined:()=>{setGuide(false);openWorkerSettings();}}/>}
    {cloudSignIn&&<CloudSignIn workspaceId={workspace.id} call={call} onClose={()=>setCloudSignIn(false)} onSignedIn={signedInCloud}/>}
    <ScrollFades/><Reveal/>
    <TopBar brand={<img className="ds-topbar__brand-image" src={logo} alt="CreativeField"/>} current={topCurrent} items={[{label:"Video",href:"#video",menu:videoMenu},{label:"Image",href:"#image",menu:imageMenu},{label:"FotoField",href:"#imageedit",featured:true},{label:"3D",href:"#3d",menu:canCreate?threeDMenu:undefined},{label:"Audio",href:"#audio"},{label:"All tools",href:"#make"},{label:"Models",href:"#catalogue",onSelect:openModels},{label:"Nodes",href:"#nodes"}]} secondary={[{label:"Library",href:"#library"},{label:"Projects",href:"#projects",suffix:project?.name,dropdown:{items:projects.map(p=>({id:p.id,title:p.name,onSelect:()=>setProjectId(p.id)})),selectedId:projectId,footer:{id:"add",icon:<Plus size={14}/>,title:"Add project",onSelect:()=>setCreatingProject(true)}}}]} end={<>{route!=="openjutsu"&&<ExpandToggle icon={<Sparkles size={16}/>} label="Free input" on={intentMode} onChange={setIntentMode}/>} {canCreate&&runChoices&&!(user.guest&&route==="openjutsu")&&<TeamChoice label="Run on" variant="pill" display={route==="openjutsu"?(openjutsuUsesLocal?"This computer":"Comfy Router"):runOn==="chatgpt"?"ChatGPT":runOn==="router"?"Comfy Router":runOn==="cloud"||user.guest?"Comfy Cloud":"This computer"} value={route==="openjutsu"?(openjutsuUsesLocal?"local":"router"):runOn} onChange={route==="openjutsu"?value=>{if(value==="local"&&openjutsuLocal){setRunOn("local");location.hash="openjutsu";}else if(value==="router"){setRunOn("router");location.hash="openjutsu/cloud";}}:pickRunOn} options={route==="openjutsu"?runChoices.filter(c=>c.value==="router"||c.value==="local"&&!!openjutsuLocal):runChoices}/>} {workspaces.length>1&&<div className="cf-workspace-picker"><TeamChoice label="Workspace" variant="pill" display={workspace.name} value={workspace.id} onChange={onWorkspace} options={workspaces.map(w=>({value:w.id,label:w.name,note:w.role}))}/></div>}<IconButton label="How it works" onClick={()=>setGuide(true)}><CircleHelp size={16}/></IconButton><JobQueueIndicator version={version} workspace={workspace} call={call} authorized={authorized} titles={catalogueTitles(catalogue)} onOpenRun={run=>{setProjectId(run.project_id);location.hash=`library/runs/${run.id}`;}}/><UserMenu initials={(account?.name??user.email).slice(0,1).toUpperCase()} name={account?.name??user.email} meta={account?.connected?<><Meta>{account.email}</Meta><Meta>{account.workspace}</Meta></>:<Meta parts={workspaceFacts(audienceOf(user),workspace)}/>} extra={account?.connected?<>
      {typeof account.credits==="number"&&<span className="ds-usermenu__row"><Meta>{`${account.credits.toLocaleString()} credits`}</Meta>{account.addCreditsUrl&&<LinkButton variant="ghost" href={account.addCreditsUrl} target="_blank" rel="noreferrer">{account.canSubmit===false?"Upgrade plan":"Add credits"}</LinkButton>}</span>}
      {account.canSubmit===false&&<Meta>{CLOUD_PLAN_LINE}</Meta>}
      {user.guest&&<Meta>Your Comfy Cloud key is saved in this browser only. CreativeField never stores it.</Meta>}
    </>:undefined} items={[{id:"guide",label:"How it works",icon:<CircleHelp size={14}/>,onSelect:()=>setGuide(true)},{id:"settings",label:settingsLabel(audienceOf(user)),icon:<Settings size={14}/>,onSelect:()=>setSettings(true)},...(user.guest?[account?.connected?{id:"cloud-out",label:"Sign out of Comfy Cloud",icon:<LogOut size={14}/>,onSelect:()=>void signOutCloud()}:{id:"cloud-in",label:"Sign in to Comfy Cloud",icon:<Cloud size={14}/>,onSelect:()=>setCloudSignIn(true)}]:[]),...(user.localSingleUser||user.guest?[]:[{id:"out",label:"Sign out",icon:<LogOut size={14}/>,onSelect:()=>void onSignOut()}])]}/></>}/>
    <WorkflowInfoProvider><MediaEditProvider canAnnotate={!!editRoute} onEdit={canCreate?editPreview:undefined} saveCrop={canCreate?savePreviewCrop:undefined} tools={mediaTools}><RecreateProvider value={recreate}><RecreateMediaProvider value={recreateMedia}><AmbientReelProvider src={reelForSection(section)}>
    <div className="cf-team__body">
    <div className="cf-team__main ds-canvas">
    {section!=="catalogue"&&section!=="nodes"&&section!=="3d"&&<WorkspaceBar density={route!=="imageedit"}
      tabs={section==="video"&&project?{label:"Video workspace",value:route==="openjutsu"?"openjutsu":videoMode==="workflow"&&previsTarget&&capabilityId===previsTarget.id?"makereal":(videoMode==="replace"?"transform":videoMode) as string,onChange:(id:string)=>{if(id==="openjutsu"){location.hash="openjutsu";return;}if(id==="makereal"&&previsTarget){setCapabilityId(previsTarget.id);setVideoMode("workflow");location.hash=videoWorkflowHash(previsTarget.id);return;}setVideoMode(id as typeof videoMode);if(id!=="workflow")location.hash=id==="create"?"video":`video/${id}`;},items:[...(videoMode==="workflow"&&!(previsTarget&&capabilityId===previsTarget.id)?[{id:"workflow" as const,label:"Workflow"}]:[]),{id:"storyboard" as const,label:"Storyboard"},{id:"keyframes" as const,label:"Keyframes"},{id:"create" as const,label:"Create Video"},...(swapMaskRoute&&swapEditRoute?[{id:"edit" as const,label:"Edit Area"}]:[]),{id:"transform" as const,label:"Transform Video"},{id:"openjutsu" as const,label:"OpenJutsu"},...(previsTarget?[{id:"makereal" as const,label:"Make it real"}]:[]),...(readyEffects?[{id:"effects" as const,label:"Effects"}]:[]),...(trimReady?[{id:"trim" as const,label:"Trim"}]:[])]}
        :section==="characters"&&project?{label:"Character workspace",value:route==="influencer"?"scenes":characterMode,onChange:(id:string)=>setCharacterMode(id as CharacterMode),items:[{id:"characters",label:"Cast"},{id:"scenes",label:"Scenes"}]}
        :section==="image"&&project?{label:"Image workspace",value:runOn==="router"||runOn==="chatgpt"?(route==="imageedit"?"edit":routerImageTab):imageTab,onChange:(id:string)=>{
          if(runOn==="router"||runOn==="chatgpt"){setRouterImageTab(id as ImageTab);location.hash=id==="edit"?"imageedit":"image";return;}
          if(id===wantedImageTab)return;
          if(id==="edit"){location.hash="imageedit";return;}
          const target=imageTabTarget(id as ImageTab,shownImages);
          if(target){setImageDraft(imageDraftForTab(target,imageDraftMemory.current,imageDraft));setCapabilityId(target.id);}
          location.hash=target?nativeWorkflowHash(target):"image";
        },items:imageTabItems}
        :undefined}
      end={<><ProblemBar/>{route==="make"&&<GettingStarted userId={user.id} workspaceId={workspace.id} admin={workspace.role==="admin"} audience={audienceOf(user)} workers={workers} onModels={openModels} onSettings={()=>{setSettingsSection("workers");setSettings(true);}}/>}</>}
      info={<WorkflowInfoButton/>}
      />}
    {askCloud&&<CloudRunConsent onUse={useCloud} onKeep={keepLocal}/>}
    {(section==="catalogue"||section==="nodes")&&<ProblemBar/>}
    {offline&&<Notice priority={100} title="Team server unavailable" actions={<Button variant="secondary" onClick={refresh}>Retry connection</Button>}>Drafts remain available. No execution route will be switched.</Notice>}
    {!authorized&&!offline&&<Notice priority={90} title="Reconnect to continue" actions={<Button variant="secondary" onClick={onReconnect}>Reconnect</Button>}>Your draft is preserved.</Notice>}
    {error&&!offline&&authorized&&failure&&<Notice priority={50} title={failure.title||undefined} actions={<Button variant="secondary" onClick={refresh}>Try again</Button>} details={error}>{failure.text}</Notice>}
    {route==="openjutsu"&&project?<section className="cf-team__content ds-page ds-page--fill">{/* The real swap runs on this computer when the local H3 pack is installed; #openjutsu/cloud keeps the H3 API panel. */}{routeHash.startsWith("#openjutsu/advanced")&&openjutsuAdvanced?<TeamComposer top={<TeamChoice label="Workflow" display="Multiple characters · MiniMax H3" value="advanced" options={[{value:"h3",label:"One character · MiniMax H3"},{value:"advanced",label:"Multiple characters · MiniMax H3"},...(replaceRoute?[{value:"multi",label:"Multiple characters · SCAIL-2",note:"Experimental; results need review"}]:[])]} onChange={value=>{location.hash=value==="advanced"?"openjutsu/advanced":value==="multi"?"openjutsu/multi":"openjutsu";}}/>} key={`${project.id}:openjutsu-advanced`} manifest={openjutsuAdvanced} catalogue={catalogue} onCapability={choose} user={user} workspace={workspace} project={project} workers={targetWorkers(workers,"local")} call={call} canQueue={canCreate} authorized={authorized} onQueued={refresh} onWorkerSettings={openWorkerSettings} onModels={openModels} onRunLocal={()=>setRunOn("local")}/>:routeHash.startsWith("#openjutsu/multi")?(replaceRoute?changeScreen(project,"person",<ReferenceReplacePanel key={`${project.id}:multi-character`} top={<TeamChoice label="Workflow" display="Multiple characters · SCAIL-2" value="multi" options={[{value:"h3",label:"One character · MiniMax H3"},{value:"multi",label:"Multiple characters · SCAIL-2",note:"Experimental; results need review"}]} onChange={value=>{location.hash=value==="multi"?"openjutsu/multi":"openjutsu";}}/>} workspace={workspace} project={project} workerId={replaceRoute.workerId} call={call} canEdit={canCreate} onChanged={refresh}/>):<Page narrow><EmptyState title="Multiple-character workflow is not ready" text="Check SCAIL-2 and its required models on this computer." action={<Button variant="secondary" onClick={()=>{location.hash="openjutsu";}}>Back to OpenJutsu</Button>}/></Page>):openjutsuUsesLocal&&openjutsuLocal?<TeamComposer top={openjutsuAdvanced||replaceRoute?<TeamChoice label="Workflow" display="One character · MiniMax H3" value="h3" options={[{value:"h3",label:"One character · MiniMax H3"},...(openjutsuAdvanced?[{value:"advanced",label:"Multiple characters · MiniMax H3"}]:[]),...(replaceRoute?[{value:"multi",label:"Multiple characters · SCAIL-2",note:"Experimental; results need review"}]:[])]} onChange={value=>{if(value==="advanced")location.hash="openjutsu/advanced";else if(value==="multi")location.hash="openjutsu/multi";}}/>:undefined} key={`${project.id}:openjutsu-local`} manifest={openjutsuLocal} catalogue={catalogue} onCapability={choose} user={user} workspace={workspace} project={project} workers={targetWorkers(workers,"local")} call={call} canQueue={canCreate} authorized={authorized} onQueued={refresh} onWorkerSettings={openWorkerSettings} onModels={openModels} onRunLocal={()=>setRunOn("local")}/>:<CloudRenderStudio key={`${workspace.id}:${project.id}:openjutsu`} feature="openjutsu" workspace={workspace} project={project} user={user} call={call} version={version} canEdit={canCreate} onQueued={refresh} onSettings={()=>user.guest?setCloudSignIn(true):setSettings(true)} onLocal={()=>{setRunOn("local");location.hash="video";}}/>}</section>:chatgptUnsupported&&project?<section className="cf-team__content"><Page narrow><EmptyState title="ChatGPT edits images here" text="This feature uses a different renderer. Choose this computer to continue here, or open the image editor for ChatGPT." action={<Button variant="secondary" onClick={()=>setRunOn("local")}>Use this computer</Button>}/></Page></section>:chatgptPage&&project?<section className="cf-team__content"><ChatgptImageStudio key={`${user.id}:${workspace.id}:${project.id}:${location.hash}:${routerImageTab}`} feature={route==="imageedit"?"image-edit":routerImageTab==="angles"?"image-angles":routerImageTab==="relight"?"image-relight":"image-edit"} incoming={route==="imageedit"&&/^[a-f0-9-]{36}$/i.test(location.hash.split("/")[1]??"")?{inputs:{source_image:location.hash.split("/")[1]},prompt:""}:routerIncoming?.workspaceId===workspace.id&&routerIncoming.projectId===project.id?routerIncoming:undefined} workspace={workspace} project={project} user={user} call={call} version={version} canEdit={canCreate} onQueued={refresh}/></section>:routerPage&&project?<section className="cf-team__content"><CloudRenderStudio key={`${workspace.id}:${project.id}:${route}:${videoMode}:${routerImageTab}:${changeChoiceFromHash(location.hash)}`} incoming={routerIncoming?.workspaceId===workspace.id&&routerIncoming.projectId===project.id?routerIncoming:undefined} feature={cloudFeature(route,videoMode,routerImageTab,changeChoiceFromHash(location.hash))} workspace={workspace} project={project} user={user} call={call} version={version} canEdit={canCreate} onQueued={refresh} onSettings={()=>user.guest?setCloudSignIn(true):setSettings(true)} onLocal={()=>setRunOn("local")} onFeature={f=>{location.hash=`video/transform/${f==="replace-character"?"person":f==="motion-transfer"?"motion":f==="object-swap"?"swap":"restyle"}`;}}/></section>:route==="3d"?<section className="cf-team__content cf-nodes-page"><ThreeDStudio textPanel={project?<TextTo3DPanel key={`${project.id}:text`} catalogue={catalogue} user={user} workspace={workspace} project={project} workers={runWorkers} call={call} canEdit={canCreate} authorized={authorized} onQueued={refresh}/>:undefined} meshPanel={project?<ModelToolsPanel key={`${project.id}:mesh:${routeHash.split("/")[2]??""}`} mode="mesh" workspace={workspace} project={project} call={call} canEdit={canCreate} onChanged={refresh}/>:undefined} texturePanel={project?<ModelToolsPanel key={`${project.id}:texture:${routeHash.split("/")[2]??""}`} mode="texture" workspace={workspace} project={project} call={call} canEdit={canCreate} onChanged={refresh}/>:undefined} viewerPanel={project?<ModelToolsPanel key={`${project.id}:viewer:${routeHash.split("/")[2]??""}`} mode="viewer" workspace={workspace} project={project} call={call} canEdit={canCreate} onChanged={refresh}/>:undefined} imagePanel={project?<ImageTo3DPanel key={routeHash} initialWorkflow={routeHash.split("/")[2]==="auto"?undefined:routeHash.split("/")[2]} initialAssetId={routeHash.split("/")[3]} user={user} workspace={workspace} project={project} catalogue={catalogue} workers={runWorkers} call={call} canEdit={canCreate} authorized={authorized} onQueued={refresh} onOpenModels={openModels}/>:undefined} workspace={workspace} workers={runWorkers} canEdit={canCreate} status={<ProblemBar/>}/></section>:route==="nodes"?<section className="cf-team__content cf-nodes-page"><ComfyNodes workspace={workspace} workers={targetWorkers(workers,"local")} catalogue={readyManifests} canEdit={canCreate} serverOffline={offline} onChanged={refresh} onWorkerSettings={openWorkerSettings}/></section>:route==="catalogue"?<CapabilityCatalogue manifests={catalogue.filter(m=>!m.mediaContract?.additionalMaskInputs?.length)} statuses={statuses} checking={checking} recheckLabel={workspace.role==="admin"?"Probe workers and recheck":"Refresh status"} onRecheck={()=>void recheck()} onChoose={choose} library={controls=><ComfyLibraryPanel workspace={workspace} workers={workers} call={call} controls={controls} onWorkerSettings={()=>setSettings(true)}/>} onLibrary={()=>{const enhancer=readyManifests.find(m=>m.category==="enhance");if(!enhancer)return;setVideoMode("create");setCapabilityId(enhancer.id);location.hash="video";}}/>:<div className="cf-team__body">
      {(route==="projects"||!project)&&<section className="cf-team__content"><Page narrow><TeamProjects projects={projects} projectId={projectId} canCreate={canCreate} onCreate={createProject} onOpen={id=>{setProjectId(id);location.hash="library";}}/></Page></section>}
      {!routerPage&&project&&route!=="projects"&&route!=="openjutsu"&&fallback.kind!=="screen"&&<section className="cf-team__content"><Page narrow><EmptyState stage title={fallbackTitle} text={fallbackText} action={fallbackNext?<Button variant="secondary" onClick={()=>{location.hash=fallbackNext.href;}}>{fallbackNext.label}</Button>:undefined}/></Page></section>}
      {!routerPage&&project&&route!=="projects"&&route!=="openjutsu"&&fallback.kind==="screen"&&<section className={`cf-team__content ds-page${route==="imageedit"?" ds-page--workspace":fillPage?" ds-page--fill":""}`}>
        {pageHeroKind&&<div className="cf-team__pagehero"><ToolHero kind={pageHeroKind}/></div>}
        {route==="block"&&<BlockShot key={`${workspace.id}:${project.id}`} workspace={workspace} project={project} call={call} workers={runWorkers} catalogue={catalogue} canCreate={canCreate} onQueued={refresh} makeReal={previsTarget&&canCreate?layoutId=>{try{presetTool(previsTarget,{source_video:layoutId});setCapabilityId(previsTarget.id);setVideoMode("create");location.hash=videoWorkflowHash(previsTarget.id);}catch(e){setError((e as Error).message);}}:undefined}/>}
        {route==="workflow"&&catalogue.find(m=>m.id===routeHash.split("/")[1])?<TeamComposer key={`${project.id}:${routeHash}`} manifest={catalogue.find(m=>m.id===routeHash.split("/")[1])!} catalogue={catalogue} onCapability={choose} user={user} workspace={workspace} project={project} workers={runWorkers} call={call} canQueue={canCreate} authorized={authorized} onQueued={refresh} onWorkerSettings={openWorkerSettings} onModels={openModels} onRunLocal={()=>setRunOn("local")}/>:route==="make"?<StartScreen ready={listedTools} onOpen={openStartTask}/>:route==="imageedit"?<ImageEditor userId={user.id} freeInput={intentMode} key={`${user.id}:${workspace.id}:${project.id}:${location.hash.split("/")[1]??""}`} openAssetId={location.hash.split("/")[1]} workspace={workspace} project={project} call={call} canEdit={canCreate} authorized={authorized} inpaint={inpaintRoute} edit={editRoute} editOptions={editRoutes} segment={routeFor("sam3-image-segment")} precision={routeFor("flux2-klein-preserve-edit")} maskedEdit={routeFor("qwen-image-21-masked-edit")} upscale={routeFor("upscale-image-esrgan")} onOpenModels={openModels}/>:(route==="characters"||route==="influencer")?<CharacterWorkspace mode={route==="influencer"?"scenes":characterMode} user={user} workspace={workspace} project={project} catalogue={catalogue} workers={runWorkers} call={call} authorized={authorized} canEdit={canCreate} onCount={setCharacterCount} onOpenStoryboard={boardId=>{setVideoMode("storyboard");location.hash=`video/storyboard/${encodeURIComponent(boardId)}`;}} onOpenCharacters={()=>setCharacterMode("characters")} onOpenImages={record=>{const target=readyImages.find(m=>m.id==="fibo2-edit")??readyImages.find(m=>m.id==="qwen-image-21-edit");if(!target)return "No compatible image edit model is ready.";try{const current=imageDraftMemory.current[target.id]??defaultImageDraft(target),next=addCharacterReferences(target,current,record,project.id);imageDraftMemory.current[target.id]=next;setImageDraft(next);setImageIntentKey("");setRunOn("local");setCapabilityId(target.id);location.hash=nativeWorkflowHash(target);return undefined;}catch(error){return (error as Error).message;}}}/>:route==="audio"&&audioReady&&audioRequirements?<AudioStudio userId={user.id} key={`${workspace.id}:${project.id}`} workspace={workspace} project={project} call={call} requirements={audioRequirements} onChanged={refresh} onLipSync={canCreate&&readyManifests.some(m=>!!m.voiceContract)?(assetId,imageAssetId)=>void useAudioInLipSync(assetId,imageAssetId):undefined}/>:route==="video"&&videoMode==="edit"?changeScreen(project,"edit",swapMaskRoute&&swapEditRoute?<SwapThingPanel promptOnly modelTitle={swapEditRoute.manifest.title} key={`edit:${project.id}:${location.hash.split("/")[2]??""}`} initialVideo={location.hash.split("/")[2]} workspace={workspace} project={project} workerId={swapEditRoute.workerId} call={call} canEdit={canCreate} onChanged={refresh}/>:<EmptyState title="Video editing is not ready" text="Check the required local workflows in Models." action={<Button variant="secondary" onClick={openModels}>Open Models</Button>}/>):route==="video"&&videoMode==="trim"&&trimReady&&videoEditRequirements?<VideoEditStudio canEdit={canCreate} maxGenerationFrames={routeFor("video-edit")?.manifest.controls.find(c=>c.id==="generation_frames")?.max??13} userId={user.id} extensionWorkerId={canCreate?routeFor("video-edit")?.workerId:undefined} initialAssetId={location.hash.split("/")[2]} key={`${workspace.id}:${project.id}`} workspace={workspace} project={project} call={call} requirements={videoEditRequirements} onChanged={refresh}/>:route==="video"&&(videoMode==="transform"||videoMode==="replace")?<TransformVideo manifests={catalogue} statuses={statuses} user={user} workspace={workspace} project={project} workers={runWorkers} call={call} canQueue={canCreate} authorized={authorized} onCapability={setCapabilityId} onQueued={refresh} onModels={openModels} initial={videoMode==="replace"?"person":changeChoiceFromHash(routeHash)} swapThing={objectSwapLocal?top=>(<TeamComposer key={`${project.id}:swap-h3`} top={top} manifest={objectSwapLocal} catalogue={catalogue} onCapability={choose} user={user} workspace={workspace} project={project} workers={runWorkers} call={call} canQueue={canCreate} authorized={authorized} onQueued={refresh} onWorkerSettings={openWorkerSettings} onModels={openModels} onRunLocal={()=>setRunOn("local")}/>):swapMaskRoute&&swapEditRoute?top=>changeScreen(project,"swap",<SwapThingPanel key={project.id} top={top} workspace={workspace} project={project} workerId={swapEditRoute.workerId} call={call} canEdit={canCreate} onChanged={refresh}/>):undefined}/>:(route==="image"||route==="marketing"||route==="remix")&&manifest&&isImageCapability(manifest)?<ImageStudio sharedFeed={<TeamRuns workspace={workspace} project={project} user={user} call={call} canEdit={canCreate} authorized={authorized} version={version} titles={catalogueTitles(catalogue)} feed={feedScope(catalogue,"image",[manifest.id])} examples="image" outputAction={run=>run.output_ids[0]?<><LinkButton variant="secondary" href={`#imageedit/${encodeURIComponent(run.output_ids[0])}`}>Edit image</LinkButton>{canCreate&&<Button variant="secondary" onClick={()=>void useImageInVideo(run.output_ids[0])}>Use in video</Button>}{canCreate&&route==="marketing"&&<Button variant="secondary" onClick={()=>{setStoryboardImage({workspaceId:workspace.id,projectId:project.id,assetId:run.output_ids[0]});setVideoMode("storyboard");location.hash="video/storyboard";}}>Add to storyboard</Button>}</>:null} hero={()=> <ToolHero kind="picture"/>}/>} adStudio={route==="marketing"} remixStudio={route==="remix"} modelOptions={(route==="remix"?shownImages.filter(remixImageModel):route==="marketing"?shownImages.filter(adImageModel):imageModelsForTab(shownImages,imageTab)).map(m=>({value:m.id,label:m.title.split(" (")[0],note:capabilityPurpose(m)}))} onModel={(id,inputs)=>{const selected=catalogue.find(m=>m.id===id);if(!selected)return;setCapabilityId(id);const next=defaultImageDraft(selected),nextDraft=inputs?imageDraftWithReferences(selected,imageDraft,inputs):route==="image"&&imageTabFor(manifest.id,route)==="create"&&imageTabFor(selected.id,route)==="create"?carryCreateDraft(selected,imageDraft):next;imageDraftMemory.current[selected.id]=nextDraft;setImageDraft(nextDraft);location.hash=route==="remix"?`remix/${selected.id}`:route==="marketing"?`marketing/${selected.id}`:nativeWorkflowHash(selected);}} key={`${project.id}:${manifest.id}`} workspace={workspace} project={project} manifest={manifest} readiness={canCreate?(statuses[manifest.id]??{state:"offline",reasons:["Image readiness has not been checked."],missing:[]}):{state:"unsupported",reasons:[workspace.role==="viewer"?"Viewer access is read-only.":"Sign in to generate images."],missing:[]}} workerName={imageWorker?.name} onUseInVideo={canCreate?assetId=>void useImageInVideo(assetId):undefined} onUseInStoryboard={canCreate&&route==="marketing"?assetId=>{setStoryboardImage({workspaceId:workspace.id,projectId:project.id,assetId});setVideoMode("storyboard");location.hash="video/storyboard";}:undefined} batchContext={{userId:user.id,workerId:imageWorker?.id??"",call,onChanged:refresh,photosetAllowed:identityPhotosetWorkerAllowed(user.localSingleUser,imageWorker?.origin)}} assets={imageAssets} runs={imageRuns} sharedCreate={route==="image"&&imageTab==="create"} createModelIds={shownImages.filter(m=>imageTabFor(m.id,"image")==="create").map(m=>m.id)} draft={imageDraft} busy={imageBusy} onDraftChange={draft=>{setImageDraft(draft);imageDraftMemory.current[manifest.id]=draft;setImageIntentKey("");}} onGenerate={draft=>void generateImage(draft)} onCancel={canCreate?cancelImageRun:undefined} canCancelRun={run=>workspace.role==="admin"||run.created_by===user.id} onRetake={canCreate&&!imageIntentKey&&!imageBusy?retakeImage:undefined}/>:route==="video"&&videoMode==="keyframes"?<KeyframeStudio key={`${workspace.id}:${project.id}`} workspace={workspace} project={project} user={user} catalogue={catalogue} workers={runWorkers} call={call} authorized={authorized} canEdit={canCreate&&runOn==="local"} localEnabled={runOn==="local"} onChanged={refresh}/>:route==="video"&&videoMode==="storyboard"?<TeamStoryboard key={project.id} initialBoardId={routeHash.split("/")[2]} incomingPremise={storyboardIdea?.projectId===project.id&&storyboardIdea.workspaceId===workspace.id?storyboardIdea.text:undefined} onPremiseConsumed={()=>setStoryboardIdea(null)} incomingAssetId={storyboardImage?.projectId===project.id&&storyboardImage.workspaceId===workspace.id?storyboardImage.assetId:undefined} onIncomingConsumed={()=>setStoryboardImage(null)} user={user} workspace={workspace} project={project} catalogue={catalogue} workers={runWorkers} call={call} authorized={authorized} canEdit={canCreate}/>: (route==="video"||route==="motion")&&manifest?<TeamComposer key={`${project.id}:${manifest.id}`} manifest={manifest} catalogue={catalogue} workflowIds={videoMode==="effects"?["h3-effects"]:undefined} onCapability={chooseWorkflow} user={user} workspace={workspace} project={project} workers={runWorkers} call={call} canQueue={canCreate} authorized={authorized} onQueued={refresh} onWorkerSettings={openWorkerSettings} onModels={openModels} onRunLocal={()=>setRunOn("local")}/>:route==="library"?<TeamLibrary titles={catalogueTitles(catalogue)} key={project.id} workspace={workspace} project={project} call={call} canEdit={canCreate} authorized={authorized} version={version} user={user} videoEditReady={trimReady} onEditVideo={asset=>{setVideoMode("trim");location.hash=`video/trim/${asset.id}`;}}/>:null}
      </section>}
    </div>}
    {intentMode&&route!=="openjutsu"&&route!=="imageedit"&&section!=="catalogue"&&section!=="nodes"&&section!=="3d"&&project&&<IntentDock imageWorkspace={["image","remix","marketing"].includes(route)} videoWorkspace={route==="video"||route==="motion"} value={intentText} onChange={setIntentText} onSubmit={runIntent} available={intentAvailable} busy={imageBusy||intentUploading} reference={intentReference?{name:intentReference.name,src:assetUrl(workspace.id,intentReference.id)}:undefined} referenceError={intentReferenceError} onReferenceAsset={id=>void intentAsset(id)} onReferenceFile={file=>void intentFile(file)} onRemoveReference={clearIntentReference}/>}
    </div>
    </div>
    </AmbientReelProvider></RecreateMediaProvider></RecreateProvider></MediaEditProvider></WorkflowInfoProvider>
    <Dialog wide className="cf-models-dialog" open={modelsOpen&&authorized} title="Models" onClose={closeModels}>
      <CapabilityCatalogue embedded manifests={catalogue.filter(m=>!m.mediaContract?.additionalMaskInputs?.length)} statuses={statuses} checking={checking} recheckLabel={workspace.role==="admin"?"Probe workers and recheck":"Refresh status"} onRecheck={()=>void recheck()} onChoose={id=>{setModelsOpen(false);choose(id);}} library={controls=><ComfyLibraryPanel workspace={workspace} workers={workers} call={call} controls={controls} onWorkerSettings={()=>setSettings(true)}/>} onLibrary={()=>{const enhancer=readyManifests.find(m=>m.category==="enhance");if(!enhancer)return;setModelsOpen(false);setVideoMode("create");setCapabilityId(enhancer.id);location.hash="video";}}/>
    </Dialog>
    <ProjectCreateDialog open={creatingProject} onClose={()=>setCreatingProject(false)} onCreate={createProject}/>
    <TeamSettings initialSection={settingsSection} open={settings&&authorized} onClose={closeSettings} workspace={workspace} user={user} workers={workers} call={call} onChanged={refresh} onSignOut={onSignOut}/>
  </div>;
}


