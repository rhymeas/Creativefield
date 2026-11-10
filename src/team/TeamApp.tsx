import {Box,CircleHelp,Github,Clapperboard,Footprints,Image as ImageIcon,LayoutGrid,Library as LibraryIcon,LogOut,Maximize2,Move,Palette,Plus,Scissors,Settings,Sparkles,Video} from "lucide-react";
import {annotationStorageKey,imageAnnotationsSchema} from "../image/annotations";
import {enableBrowserLibrary} from "./browser-library";
import {StartScreen} from "./StartScreen";
import {GettingStarted} from "./GettingStarted";
import {Welcome} from "./Welcome";
import {CloudSignIn,reopenCloudSignIn,type CloudAccountFacts} from "./CloudSignIn";
import {Guide} from "./Guide";
import {SwapThingPanel} from "./SwapThingPanel";
import {ReferenceReplacePanel} from "./ReferenceReplacePanel";
import {changeChoiceFromHash,type StartTask} from "./start-tasks";
import {ProjectCreateDialog,TeamProjects,useProjectSelection} from "./TeamProjects";
import {useCallback,useEffect,useRef,useState,type ReactNode} from "react";
import {usePhone,IconButton,IconLink,type NavItem,Panel,Reveal,ExpandToggle,AmbientReelProvider,MediaEditProvider,type MediaEditSource,type MediaToolSet,ScrollFades,useDensity,Button,EmptyState,Page,ShimmerText,ToastHost,UserMenu,type UserMenuItem,ProblemBar,ProblemHost,Dialog,Meta,Notice,TopBar,WorkspaceBar,LinkButton} from "../ds";
import {AuthPanel} from "./AuthPanel";
import {ApiError,storeCloudKey,assetUrl,composerAssets,composerResultAssets,mergeAssets,request,workspacePath,type Asset,type Call,type RequestOptions,type Run,type User,type Workspace,type Project,type Worker,type Catalogue,type CharacterRecord} from "./api";
import {TeamComposer} from "./TeamComposer";
import {VIDEO_REFRAME_HASH,VIDEO_REFRAME_ID} from "../capabilities/video-reframe";
import {TeamLibrary,TeamRuns} from "./TeamLibrary";
import {renderTime} from "./RunDevelop";
import {feedMode,feedScope} from "./media-feed";
import {groupMenu} from "./menu-groups";
import {runLocation} from "./job-queue";
import {JobQueueIndicator} from "./JobQueueIndicator";
import {TeamChoice} from "./TeamChoice";
import {CapabilityCatalogue} from "../ui/CapabilityCatalogue";
import {bestWorkerReadiness,defaultDraft,draftKey,restoreDraft,refreshWorkerInventory,workerReadiness} from "./state";
import {plainProblem} from "./problems";
import {audienceOf,noWorkspaceText,settingsLabel,workspaceFacts} from "./audience";
import type {CapabilityManifestV2,Readiness} from "../capabilities/types";
import "./team.css";
import {isMaskedEdit} from "./masked-state";
import {WorkflowInfoProvider,WorkflowInfoButton} from "./workflow-info";
import {BlockWorkspace,filmStudioInstalled} from "./BlockShot";
import {reelForSection} from "./reels";
import {capabilityPurpose,capabilitySurface,isCreateVideoWorkflow,isImageWorkflow,isVideoWorkflow} from "../capabilities/surfaces";
import {isSelectedImageModel} from "../capabilities/image-model-selection";
import {identityPhotosetWorkerAllowed} from "../image/identity-photoset";
import {addCharacterReferences,defaultImageDraft,imageDraftWithReferences,imageRunBody,restoreImageRetakeDraft,type ImageDraft} from "../image/image-state";
import {isEffectClips,isFlashVideoCreate,isOpenJutsuSingleSwap,routeImageToVideo,routeImageToVideoDraft,routeTask} from "../capabilities/tasks";
import type {AudioRequirements} from "./audio/state";
import {videoModeFromHash,type VideoEditRequirements} from "./video-edit/state";
import {AudioStudio,CharacterWorkspace,ChatgptImageStudio,CloudRenderStudio,ComfyNodes,ImageEditor,ImageStudio,ImageTo3DPanel,KeyframeStudio,ModelToolsPanel,TeamSettings,TeamStoryboard,TextTo3DPanel,ThreeDStudio,TransformVideo,VideoEditStudio} from "./lazy-screens";
import {ComfyLibraryPanel} from "./ComfyLibrary";
import {IntentDock} from "./intent/IntentDock";
import {assetMatchesPort} from "../capabilities/assets";
import {currentIntentReference,intentImageReferenceTarget,intentPromptDraft,intentReferenceDraft} from "./intent/reference";
import {beginOperation,finishOperation,invalidateOperation,operationGate} from "./operation-gate";
import type {IntentTarget} from "./intent/router";
import {nativeWorkflowHash,videoWorkflowMode,type VideoWorkspaceMode} from "./workflow-navigation";
import {isOpenJutsuAdvanced} from "../capabilities/openjutsu-advanced";
import {imageTabFor,imageTabTarget,resolveScreen,type AccountAction,type ImageTab,type ResolvedScreen,type VideoMenuId} from "./navigation";
export {imageTabFor,imageTabTarget,imageTabs} from "./navigation";
export type {ImageTab} from "./navigation";
import {sectionFromHash} from "./route-state";
import {videoHashPart,videoWorkflowHash} from "../ui/studio-route";
import {isMotionTransfer,selectTransformManifest} from "./transform-video-state";
import {catalogueTitles} from "./job-queue";
import {ToolHero,type HeroKind} from "./heroes";
import {ProductionContent} from "./ProductionWorkspace";
import logo from "../assets/creativefield-logo-trim.png";
import {RecreateMediaProvider,RecreateProvider,type RecreateMedia,type RecreateRun} from "./recreate";

/** A worker's kind comes from the server; the shared Worker type does not carry it yet. */
export {videoWorkflowMode} from "./workflow-navigation";
const VIDEO_MENU_ICONS:Partial<Record<VideoMenuId,typeof Sparkles>>={
  create:Video,trim:Scissors,storyboard:Clapperboard,motion:Move,enhance:Maximize2,
};
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

/** Replace character on Comfy Cloud, in the order the Model row offers them. */
const CLOUD_REPLACE_MODELS=["scail2-character-replace","cloud-h3-character-swap","cloud-kling-omni-edit","cloud-seedance2-reference"];
/** The angle workflow this computer really has ready: the camera-angle tool first, then the 45° angle shots. */
export function angleWorkflow<T extends {id:string}>(ready:T[]):T|undefined{
  return routeTask("image.angles",ready)?.pack;
}
/** The model picker stays within the active Image workspace. */
export function imageModelsForTab<T extends {id:string}>(models:T[],tab:ImageTab):T[]{
  return models.filter(model=>imageTabFor(model.id,"image")===tab);
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
    if(account.guest)await enableBrowserLibrary();
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

const sectionOf=(route:string)=>route==="openjutsu"?"video":route==="influencer"?"characters":route;
/* `#video/camera` names a workflow; `#video/trim` names a mode, and a mode wins. */
const videoWorkflowFromHash=(hash:string)=>videoModeFromHash(hash)?undefined:videoHashPart(hash);
/* Imported workflows are the person's own choice, so they always appear; built-in ones follow the selected models. */
const isImported=(id:string)=>id.startsWith("imported-");
/** What an imported workflow does, read from its inputs and result, so the menu can place it in the right row. */
const importedHint=(m:Catalogue[number])=>{const image=m.inputs.some(p=>p.type==="image"),video=m.inputs.some(p=>p.type==="video"),out=m.outputs[0]?.type;return out==="video"?(video?"video edit":image?"image to video":"text to video"):(image?"image edit":"text to image");};
/** An imported workflow's menu entry: its own title (never empty), its purpose as the hint. */
const menuTitle=(m:Catalogue[number])=>m.title.split(" (")[0]||m.id.replace(/^imported-/,"").replace(/-/g," ");
const isImageCapability=(manifest:Catalogue[number])=>isImageWorkflow(manifest)&&(isSelectedImageModel(manifest.id)||isImported(manifest.id));

function TeamWorkspace({user,workspace,workspaces,onWorkspace,call,authorized,offline,onSignOut,onReconnect}:{user:User;workspace:Workspace;workspaces:Workspace[];onWorkspace:(id:string)=>void;call:Call;authorized:boolean;offline:boolean;onSignOut:()=>Promise<void>;onReconnect:()=>void}){
  /* On a phone the top bar keeps only the job queue and the account; Run on and the rest move into its More sheet. */
  const phone=usePhone();
  const [routeHash,setRouteHash]=useState(location.hash);
  const [route,setRoute]=useState(sectionFromHash(location.hash)),[modelsRequested,setModelsRequested]=useState(false),[creatingProject,setCreatingProject]=useState(false);
  const {projects,projectsLoading,project,projectId,setProjectId,replaceProjects,addProject}=useProjectSelection(user.id,workspace.id);
  const [workers,setWorkers]=useState<Worker[]>([]),[catalogue,setCatalogue]=useState<Catalogue>([]),[capabilityId,setCapabilityId]=useState("");
  const [addressWorkflow,setAddressWorkflow]=useState<string|null>(()=>videoWorkflowFromHash(location.hash)??null);
  const [videoMode,setVideoMode]=useState<VideoWorkspaceMode>(()=>videoModeFromHash(location.hash)??"create");
  const [imageDraft,setImageDraft]=useState<ImageDraft>({controls:{}}),[imageAssets,setImageAssets]=useState<Asset[]>([]),[imageRuns,setImageRuns]=useState<Run[]>([]),[imageBusy,setImageBusy]=useState(false),[imageIntentKey,setImageIntentKey]=useState("");
  const [storyboardImage,setStoryboardImage]=useState<{projectId:string;workspaceId:string;assetId:string}|null>(null);
  const [storyboardIdea,setStoryboardIdea]=useState<{projectId:string;workspaceId:string;text:string}|null>(null);
  /* The draft each image tab was left with, so a tab switch returns to the same picture and preset. */
  const imageDraftMemory=useRef<Record<string,ImageDraft>>({});
  const [intentText,setIntentText]=useState(""),[intentMode,setIntentMode]=useState(()=>{try{return localStorage.getItem("comfyfield.intent-mode")==="1";}catch{return false;}});
  const [intentReference,setIntentReference]=useState<Asset|null>(null),[intentReferenceError,setIntentReferenceError]=useState(""),[intentUploading,setIntentUploading]=useState(false);
  const intentScope=useRef("");
  const intentReferenceGate=useRef(operationGate());
  const [error,setError]=useState(""),[version,setVersion]=useState(0),[checking,setChecking]=useState(false),[audioRequirements,setAudioRequirements]=useState<AudioRequirements|null>(null),[videoEditRequirements,setVideoEditRequirements]=useState<VideoEditRequirements|null>(null);
  const cloudDraftRef=useRef<{workspaceId:string;projectId:string;inputs:Record<string,string>;prompt:string}>();
  const [routerIncoming,setRouterIncoming]=useState<{workspaceId:string;projectId:string;inputs:Record<string,string>;prompt:string}>();
  const [routerImageTab,setRouterImageTab]=useState<ImageTab>("create");
  const [runOn,setRunOn]=useState<RunTarget>("local"),[askCloud,setAskCloud]=useState(false);
  useEffect(()=>{try{localStorage.setItem("comfyfield.intent-mode",intentMode?"1":"0");}catch{}},[intentMode]);
  const [settings,setSettings]=useState<"account"|"workers"|null>(null);
  const modelsReturnHash=useRef(route==="catalogue"?"#make":routeHash);
  const closeSettings=useCallback(()=>setSettings(null),[]);
  const openModels=useCallback(()=>setModelsRequested(true),[]);
  useEffect(()=>{if(!authorized){setSettings(null);setModelsRequested(false);}},[authorized]);
  useEffect(()=>{const update=()=>{const next=sectionFromHash(location.hash);setRouteHash(location.hash);setRoute(next);setModelsRequested(false);if(next!=="catalogue")modelsReturnHash.current=location.hash;const mode=videoModeFromHash(location.hash),workflow=videoWorkflowFromHash(location.hash);if(mode)setVideoMode(mode);else if(workflow)setVideoMode("create");setAddressWorkflow(workflow??null);};addEventListener("hashchange",update);return()=>removeEventListener("hashchange",update);},[]);
  useEffect(()=>{if(routeHash==="#video/transform/edit")location.hash="video/edit";},[routeHash]);
  const refresh=useCallback(()=>setVersion(v=>v+1),[]);
  useEffect(()=>{if(!authorized)return;const timer=setInterval(refresh,60000);return()=>clearInterval(timer);},[authorized,refresh]);
  useEffect(()=>{if(!authorized){setAudioRequirements(null);return;}let current=true;void call<AudioRequirements>(workspacePath(workspace.id,"audio-requirements")).then(result=>{if(current)setAudioRequirements(result);}).catch(()=>{if(current)setAudioRequirements(null);});return()=>{current=false;};},[authorized,workspace.id,call,version]);
  useEffect(()=>{if(!authorized){setVideoEditRequirements(null);return;}let current=true;void call<VideoEditRequirements>(workspacePath(workspace.id,"video-extension-requirements")).then(result=>{if(current)setVideoEditRequirements(result);}).catch(()=>{/* Retain the inspected workspace during a transient outage; call owns the connection notice. */});return()=>{current=false;};},[authorized,workspace.id,call,version]);
  useEffect(()=>{
    if(!authorized)return;let current=true;
    void Promise.all([call<Project[]>(workspacePath(workspace.id,"projects")),call<Worker[]>(workspacePath(workspace.id,"workers")),call<Catalogue>(workspacePath(workspace.id,"catalogue"))]).then(([p,w,c])=>{if(!current)return;replaceProjects(p);setWorkers(w);setCatalogue(c);setError("");}).catch(e=>{if(current)setError((e as Error).message);});
    return()=>{current=false;};
  },[call,workspace.id,version,authorized,replaceProjects]);
  useEffect(()=>{
    if(route!=="video"||["create","edit","transform","effects","workflow"].includes(videoMode))return;
    setCapabilityId(id=>{
      const selected=catalogue.find(m=>m.id===id);
      if(selected&&(isCreateVideoWorkflow(selected)&&isFlashVideoCreate(selected.id)||capabilitySurface(selected)==="video-enhance"))return id;
      const flash=catalogue.filter(m=>m.coverage.local==="implemented"&&isFlashVideoCreate(m.id));
      return routeTask("video.create",flash)?.pack.id??flash.find(m=>m.category==="t2v")?.id??"";
    });
  },[route,catalogue,videoMode]);
  /* Remember a valid named video for the next visit to the bare video address. */
  useEffect(()=>{
    if(!addressWorkflow)return;
    const named=catalogue.find(m=>m.id===addressWorkflow);
    if(!named&&!catalogue.length)return;
    if(named&&route==="video"&&isVideoWorkflow(named)&&(isEffectClips(named.id)||!isCreateVideoWorkflow(named)||isFlashVideoCreate(named.id))){setCapabilityId(named.id);setVideoMode(videoWorkflowMode(named));}
    setAddressWorkflow(null);
  },[addressWorkflow,catalogue,route]);
  intentScope.current=`${workspace.id}:${project?.id??""}`;
  /* The Comfy account behind the cloud key, shown in the user menu. */
  const [account,setAccount]=useState<CloudAccountFacts|null>(null),[cloudSignIn,setCloudSignIn]=useState(reopenCloudSignIn),[guide,setGuide]=useState(false);
  useEffect(()=>{if(!authorized)return;let live=true;void call<NonNullable<typeof account>>(workspacePath(workspace.id,"cloud-account")).then(a=>{if(live)setAccount(a);}).catch(()=>{});return()=>{live=false;};},[authorized,workspace.id,call]);
  const cloudWorker=workers.find(isCloudWorker),runChoices=runTargetOptions(workers,route==="image"||route==="imageedit"||runOn==="chatgpt",user.guest?{signedIn:!!account?.connected,cloudJobs:account?.canSubmit!==false}:undefined),runWorkers=targetWorkers(workers,runOn==="router"?"local":runOn),cloudConsentKey=`comfyfield.cloud-consent:v1:${user.id}:${workspace.id}`;
  useEffect(()=>{if(runOn==="cloud"&&!cloudWorker){setRunOn("local");setAskCloud(false);}},[runOn,cloudWorker]);
  /* A signed-in guest always runs on their Comfy Cloud, also after a reload. */
  /* A guest never runs on this computer: before signing in Run on is Comfy Router, whose panel offers the sign-in. */
  useEffect(()=>{if(!user.guest)return;const cloudJobs=!!account?.connected&&account.canSubmit!==false&&!!cloudWorker;if(runOn==="local"||runOn==="cloud"&&!cloudJobs)setRunOn(cloudJobs?"cloud":"router");},[user.guest,account?.connected,account?.canSubmit,cloudWorker,runOn]);
  const canCreate=workspace.role!=="viewer"&&authorized&&!offline;
  const audioReady=canCreate&&audioRequirements?.state==="ready";
  const trimReady=workspace.role!=="viewer"&&authorized&&videoEditRequirements?.trim.state==="ready";
  const statuses:Record<string,Readiness>=Object.fromEntries(catalogue.map(m=>{
    const readiness=bestWorkerReadiness(m,runWorkers);
    return [m.id,offline?{state:"offline",reasons:["The team server cannot confirm worker readiness."],missing:readiness.missing}:readiness];
  }));
  const routeFor=(id:string,candidates=runWorkers)=>{const m=catalogue.find(x=>x.id===id&&x.coverage.local==="implemented");if(!m||!canCreate)return undefined;const w=candidates.filter(worker=>workerReadiness(m,worker).state==="ready").sort((a,b)=>a.id.localeCompare(b.id))[0],r=m.routes.find(r=>r.execution==="local_comfy"&&r.implementation==="implemented")?.id;return w&&r?{manifest:m,workerId:w.id,routeId:r}:undefined;};
  const objectSwapLocal=routeTask("video.swap-thing",catalogue)?.pack;
  const replaceRoute=routeFor("scail2-character-replace"),swapMaskRoute=routeFor("sam31-video-mask"),swapEditRoute=routeFor("wan21-vace-masked-edit"),vfxRoute=routeFor("nvidia-vfx-upscale");
  const localWorkers=targetWorkers(workers,"local");
  const readyIds=new Set(Object.keys(statuses).filter(id=>statuses[id].state==="ready"));
  const localReady=runOn==="local"||runOn==="router"?readyIds:new Set(offline?[]:
    catalogue.filter(m=>localWorkers.some(w=>workerReadiness(m,w).state==="ready")).map(m=>m.id));
  const workspaceAudience=user.guest?(account?.connected?"signed-in-guest":"guest"):"local";
  const hosted=workspaceAudience!=="local";
  const navigation=resolveScreen({
    hash:routeHash,
    audience:workspaceAudience,
    localSingleUser:user.localSingleUser,
    workspaceAdmin:workspace.role==="admin",
    hasProject:!!project,
    canCreate,
    hasWorkers:workers.length>0,
    access:offline?"offline":authorized?"ready":"reconnect",
    runTarget:runOn,
    cloud:{worker:!!cloudWorker,connected:account?.connected,canSubmit:account?.canSubmit},
    catalogue:offline||!authorized||project||catalogue.length?catalogue:null,
    ready:readyIds,
    localReady,
    requirements:{
      audio:audioRequirements?(audioRequirements.state==="ready"?"ready":"unavailable"):"checking",
      trim:videoEditRequirements?(trimReady?"ready":"unavailable"):"checking",
      editArea:!!(swapMaskRoute&&swapEditRoute),
    },
    openJutsuExperiment:replaceRoute?.manifest.id,filmStudioInstalled,
    models:{open:modelsRequested,returnHash:modelsReturnHash.current},
    selection:{videoMode,workflowId:capabilityId,imageTab:routerImageTab},
  });
  const workspaceMenu=navigation.menu;
  const modelsOverlay=navigation.overlay;
  const closeModels=()=>{
    setModelsRequested(false);
    if(modelsOverlay.closeHash)location.hash=modelsOverlay.closeHash;
  };
  const resolved=navigation.screen;
  const characters=resolved?.kind==="characters"?resolved:undefined;
  const library=resolved?.kind==="library"?resolved:undefined;
  const nodes=resolved?.kind==="nodes"&&resolved;
  const catalogueScreen=resolved?.kind==="catalogue";
  const characterEditor=characters?.imageEditor;
  const block=resolved?.kind==="block"||resolved?.kind==="film-studio"?resolved:undefined;
  const studio=resolved?.kind==="remix"||resolved?.kind==="marketing"?resolved:undefined;
  const motion=resolved?.kind==="motion"?resolved:undefined;
  const threeD=resolved?.kind==="3d"?resolved:undefined;
  const studioRoute=route==="remix"||route==="marketing";
  const manifest=studioRoute?studio?.manifest:route==="image"?navigation?.imageWorkflow:route==="motion"?motion?.manifest:catalogue.find(m=>m.id===capabilityId);
  useEffect(()=>{if((route==="image"||studioRoute||route==="motion")&&manifest)setCapabilityId(manifest.id);},[route,manifest?.id]);
  /* The draft is set from the tab that is opening: its own earlier draft, or the picture already chosen on
     the tab being left. `imageDraft` is read once here on purpose, so it is not a dependency. */
  useEffect(()=>{if((route==="image"||studioRoute)&&manifest&&isImageCapability(manifest)){setImageDraft(imageDraftForTab(manifest,imageDraftMemory.current,imageDraft));setImageIntentKey("");}},[route,manifest?.id,manifest?.version]);
  const selectedImageIds=JSON.stringify(Object.values(imageDraft.inputs??{}).filter(Boolean).sort());
  const imageOutputIds=JSON.stringify(imageRuns.filter(run=>route==="image"&&imageTabFor(manifest?.id,route)==="create" ? imageTabFor(run.capability_id,route)==="create" && catalogue.some(m=>m.id===run.capability_id&&isImageCapability(m)) : run.capability_id===manifest?.id).flatMap(run=>run.output_ids));
  useEffect(()=>{
    if(!authorized||(route!=="image"&&!studioRoute)||!project)return;let current=true;
    void Promise.all([composerAssets(call,workspace.id,project.id,JSON.parse(selectedImageIds) as string[]),composerResultAssets(call,workspace.id,project.id,JSON.parse(imageOutputIds) as string[]).catch(e=>{if(current)setError((e as Error).message);return [] as Asset[];})])
      .then(([assets,outputs])=>{if(current)setImageAssets(mergeAssets(assets.items,outputs).filter(asset=>asset.media_type==="image"));})
      .catch(e=>{if(current)setError((e as Error).message);});
    return()=>{current=false;};
  },[authorized,route,project?.id,workspace.id,call,version,selectedImageIds,imageOutputIds]);
  useEffect(()=>{
    if(!authorized||(route!=="image"&&!studioRoute)||!project)return;let current=true;
    void call<Run[]>(workspacePath(workspace.id,`runs?projectId=${project.id}`))
      .then(runs=>{if(current)setImageRuns(runs);}).catch(e=>{if(current)setError((e as Error).message);});
    return()=>{current=false;};
  },[authorized,route,project?.id,workspace.id,call,version]);
  /* The Generate button follows these runs: while one is still working, ask again every few seconds so it frees up as soon as the result is in. */
  const imageWorking=imageRuns.some(run=>["pending","submitting","submission_unknown","queued","running","cancel_requested"].includes(run.state));
  useEffect(()=>{
    if(!imageWorking||!authorized||!project)return;let current=true;
    const timer=setInterval(()=>{void call<Run[]>(workspacePath(workspace.id,`runs?projectId=${project.id}`)).then(runs=>{if(current)setImageRuns(runs);}).catch(()=>{});},3000);
    return()=>{current=false;clearInterval(timer);};
  },[imageWorking,authorized,project?.id,workspace.id,call]);
  /* A failed request is said in everyday words; the raw text waits behind Details (rule 36). */
  const failure=error?plainProblem(error):null;
  function pickRunOn(value:string){
    if(user.guest&&!account?.connected&&(value==="router"||value==="cloud")){setAskCloud(false);setCloudSignIn(true);return;}
    if(value==="chatgpt"){const incoming=route==="image"?{inputs:imageDraft.inputs??{},prompt:String(imageDraft.controls.prompt??"")}:undefined;setRouterIncoming(incoming&&project?{...incoming,workspaceId:workspace.id,projectId:project.id}:undefined);setRouterImageTab("edit");setRunOn("chatgpt");setAskCloud(false);if(route!=="imageedit")location.hash="imageedit";return;}
    if(value==="router"){let incoming:{inputs:Record<string,string>;prompt:string}|undefined;const local=cloudDraftRef.current;if(project&&local?.workspaceId===workspace.id&&local.projectId===project.id&&(videoMode==="replace"||(videoMode==="transform"&&changeChoiceFromHash(location.hash)==="person")))incoming=local;else if(route==="image")incoming={inputs:imageDraft.inputs??{},prompt:String(imageDraft.controls.prompt??"")};else if(project&&composerManifest&&route!=="audio"&&videoMode==="create"){try{const d=JSON.parse(localStorage.getItem(draftKey(user.id,workspace.id,project.id,composerManifest.id))??"null");if(d?.inputs)incoming={inputs:d.inputs,prompt:String(d.controls?.prompt??"")};}catch{}}setRouterIncoming(incoming&&project?{...incoming,workspaceId:workspace.id,projectId:project.id}:undefined);setRunOn("router");setAskCloud(false);return;}
    if(value!=="cloud"){setRunOn("local");setAskCloud(false);return;}
    /* A hosted guest signs in with their own Comfy Cloud key instead of setting up a worker. */
    if(user.guest&&!account?.connected){setAskCloud(false);setCloudSignIn(true);return;}
    if(!cloudWorker){setAskCloud(false);setSettings("workers");return;}
    let accepted=false;try{accepted=localStorage.getItem(cloudConsentKey)==="yes";}catch{}
    if(accepted){setRunOn("cloud");setAskCloud(false);return;}
    setAskCloud(true);
  }
  /* A hosted guest has no worker to add: their worker is Comfy Cloud, reached by signing in. */
  function openWorkerSettings(){if(hosted){setCloudSignIn(true);return;}setSettings("workers");}
  function useCloud(){try{localStorage.setItem(cloudConsentKey,"yes");}catch{}setAskCloud(false);setRunOn("cloud");}
  function keepLocal(){setAskCloud(false);setRunOn("local");}
  /* Signing in names the credits in its own words, so it is also the yes to running on Comfy Cloud. */
  async function signedInCloud(next:CloudAccountFacts){setAccount(next);setCloudSignIn(false);try{localStorage.setItem(cloudConsentKey,"yes");}catch{}const w=await call<Worker[]>(workspacePath(workspace.id,"workers")).catch(()=>null);if(w)setWorkers(w);setRunOn(next.canSubmit===false?"router":"cloud");}
  async function signOutCloud(){storeCloudKey("");await call(workspacePath(workspace.id,"cloud-key"),"DELETE").catch(()=>undefined);setAccount({connected:false});setRunOn("local");}
  async function createProject(name:string,description:string){setError("");try{const p=await call<Project>(workspacePath(workspace.id,"projects"),"POST",{name,description:description||undefined});addProject(p);refresh();return true;}catch(e){setError((e as Error).message);return false;}}
  const imageWorkers=studio?localWorkers:runWorkers;
  const imageReadiness=manifest&&(studio&&!offline?bestWorkerReadiness(manifest,imageWorkers):statuses[manifest.id]);
  const readyImageWorkers=manifest&&isImageCapability(manifest)?imageWorkers.filter(worker=>workerReadiness(manifest,worker).state==="ready").sort((a,b)=>a.id.localeCompare(b.id)):[];
  const imageWorker=readyImageWorkers[0];
  async function queueImage(target:Catalogue[number],draft:ImageDraft){
    if(!project||!canCreate||!isImageCapability(target))return;
    const runner=routeFor(target.id,imageWorkers);
    if(!runner)return;
    const idempotencyKey=imageIntentKey||crypto.randomUUID();setImageIntentKey(idempotencyKey);setImageBusy(true);setError("");
    try{
      const run=await call<Run>(workspacePath(workspace.id,"runs"),"POST",imageRunBody({projectId:project.id,workerId:runner.workerId,idempotencyKey,routeId:runner.routeId},target,draft));
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
  const openJutsuNav=route==="openjutsu"?navigation:undefined;
  const openJutsuScreen=resolved?.kind==="openjutsu"?resolved:undefined;
  const screenRunChoices=runChoices?.filter(choice=>navigation.runTargets.choices.some(option=>option.target===choice.value));
  const openjutsuCanRunLocal=!!openJutsuNav?.runTargets.choices.some(option=>option.target==="local");
  const video=resolved.kind==="video"?resolved:undefined;
  const storyboard=resolved?.kind==="storyboard"?resolved:undefined;
  const keyframes=resolved?.kind==="keyframes"?resolved:undefined;
  const editArea=resolved?.kind==="edit-area"?resolved:undefined;
  const transform=resolved?.kind==="transform"?resolved:undefined;
  const makeReal=resolved?.kind==="make-real"?resolved.manifest:undefined;
  const effects=resolved?.kind==="effects"?resolved.manifest:undefined;
  const trim=resolved?.kind==="trim"?resolved:undefined;
  const explicitWorkflow=resolved?.kind==="workflow"?resolved.manifest:undefined;
  const trimExtension=trim?routeFor("video-edit"):undefined;
  const composerManifest=makeReal??effects??motion?.manifest??(video&&catalogue.find(m=>m.id===video.workflowId));
  // Prefer the local guided Qwen workflow for FotoField; it follows selected-object
  // replacement instructions on the verified cat-to-pumpkin case. Other models
  // remain available through the model selector and readiness determines fallback.
  const editRoutes=["qwen-image-21-edit","fibo2-edit","flux2-klein-edit","pruna-p-h3-edit"].map(id=>routeFor(id)).filter((route): route is NonNullable<typeof route> => !!route);
  const editScreen=resolved?.kind==="imageedit"||resolved?.kind==="fotofield"?resolved:undefined;
  const openedImageId=editScreen?.assetId;
  const openedImageRun=openedImageId?imageRuns.find(run=>run.output_ids.includes(openedImageId)):undefined;
  const preferPruna=(openedImageRun?.capability_id??capabilityId).startsWith("pruna-p-h3-");
  const editRoute=(preferPruna?editRoutes.find(option=>option.manifest.id==="pruna-p-h3-edit"):undefined)??editRoutes[0];
  const readyManifests=catalogue.filter(m=>statuses[m.id]?.state==="ready"),readyImages=(studio?catalogue.filter(m=>localReady.has(m.id)):readyManifests).filter(isImageCapability),shownImages=catalogue.filter(m=>m.coverage.local==="implemented"&&isImageCapability(m)),readyEdit=readyManifests.some(isMaskedEdit);
  const chatgpt=resolved?.kind==="chatgpt"?resolved:undefined;
  const routerScreen=resolved.kind==="router"?resolved:undefined;
  const linkedImage=chatgpt?.assetId??routerScreen?.assetId;
  const incoming:{inputs:Record<string,string>;prompt:string}|undefined=linkedImage
    ?{inputs:routerScreen?.feature==="image-to-3d"?{image:linkedImage}:{source_image:linkedImage},prompt:""}:
    routerIncoming?.workspaceId===workspace.id&&routerIncoming.projectId===project?.id?routerIncoming:undefined;
  const imageTabs=navigation.imageTabs;
  const imageTab=resolved?.kind==="image"?resolved.tab:imageTabFor(manifest?.id,route);
  const videoTabs=navigation.videoTabs;
  const projectTabs=navigation.projectTabs;
  function openProjectTab(id:string){
    const tab=projectTabs?.items.find(item=>item.id===id);
    if(tab)location.hash=tab.href;
  }
  const intentImage=imageTabTarget("create",readyImages),intentVideo=routeTask("video.create",readyManifests.filter(m=>isFlashVideoCreate(m.id)))?.pack,intentMotion=readyManifests.find(isMotionTransfer);
  const intentAvailable={image:intentReference?!!intentImageReferenceTarget(readyImages):!!intentImage,"image-edit":!!intentImageReferenceTarget(readyImages,manifest?.id),video:intentReference?!!routeImageToVideo(readyManifests.filter(isCreateVideoWorkflow)):!!intentVideo,motion:!!intentMotion,edit:readyEdit,trim:trimReady,storyboard:!!project&&canCreate,audio:audioReady};
  const choose=(id:string)=>{const selected=catalogue.find(m=>m.id===id);if(!selected||statuses[id]?.state!=="ready")return;setCapabilityId(id);if(isImageCapability(selected))setImageDraft(defaultImageDraft(selected));setVideoMode(videoWorkflowMode(selected));location.hash=nativeWorkflowHash(selected);};
  /** A workflow picked on the video screen takes its place in the address, so reload and back keep it. */
  const chooseWorkflow=(id:string)=>{
    setCapabilityId(id);
    if(motion)location.hash="motion/"+id;
    else if(route==="video"&&(videoMode==="create"||videoMode==="effects"||videoMode==="workflow"))location.hash=videoWorkflowHash(id);
  };
  /** An All tools card opens its screen: a task that names one workflow selects it, every other card starts from that screen's default. */
  const openStartTask=(task:StartTask)=>{
    const target=task.workflow?routeFor(task.workflow):undefined;setCapabilityId(target?.manifest.id??"");location.hash=task.href.slice(1);};
  function openCharacterImages(record:CharacterRecord,target:Catalogue[number],projectId:string){
    try{
      const draft=imageDraftMemory.current[target.id]??defaultImageDraft(target);
      const next=addCharacterReferences(target,draft,record,projectId);
      imageDraftMemory.current[target.id]=next;
      setImageDraft(next);
      setImageIntentKey("");
      setRunOn("local");
      setCapabilityId(target.id);
      location.hash=nativeWorkflowHash(target);
    }catch(error){return (error as Error).message;}
  }
  function useImageInStoryboard(target:Project,assetId:string){
    setStoryboardImage({workspaceId:workspace.id,projectId:target.id,assetId});
    setVideoMode("storyboard");
    location.hash="video/storyboard";
  }
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
      localStorage.setItem(key,JSON.stringify(draft));setCapabilityId(target.id);setVideoMode("create");location.hash=videoWorkflowHash(target.id);
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
  const allWorkflows={label:"All workflows",onSelect:()=>{location.hash="catalogue";}};
  const importWorkflows={label:"Add workflows from Comfy",onSelect:()=>{location.hash="nodes";}};
  const menuFooter=(footer:typeof workspaceMenu.videoFooter)=>footer==="catalogue"?allWorkflows:footer==="import"?importWorkflows:undefined;
  const videoMenu:NonNullable<NavItem["menu"]>={
    features:workspaceMenu.video.map(({id,title,text,href})=>{
      const Icon=VIDEO_MENU_ICONS[id]??Sparkles;
      return {id,title,text,icon:<Icon size={18}/>,onSelect:()=>{
        if(id==="create")setCapabilityId("");
        location.hash=href;
      }};
    }),
    models:catalogue.filter(m=>workspaceMenu.videoWorkflows.includes(m.id)).map(m=>({
      id:m.id,icon:<Sparkles size={18}/>,title:menuTitle(m),text:capabilityPurpose(m),
      ...(isImported(m.id)?{hint:importedHint(m)}:{}),onSelect:()=>choose(m.id),
    })),
    footer:menuFooter(workspaceMenu.videoFooter),
  };
  const threeDMenu:NavItem["menu"]=workspaceMenu.threeD.canOpenMenu?{
    features:workspaceMenu.threeD.tools.map(({id,title,text,href})=>({id,icon:<Box size={18}/>,title,text,onSelect:()=>{location.hash=href;}})),
    /* Imported 3D workflows open in the general workflow screen, which runs any app and shows its model. */
    models:workspaceMenu.threeD.workflows.map(({manifest:m,href})=>({id:m.id,icon:<Box size={18}/>,title:menuTitle(m),text:capabilityPurpose(m),
      hint:m.inputs.some(p=>p.type==="image")?"image to 3d":"text to 3d",onSelect:()=>{location.hash=href;}})),
  }:undefined;
  const imageMenu:NonNullable<NavItem["menu"]>={
    features:workspaceMenu.image.map(({id,title,text,action})=>({
      id,title,text,icon:id==="fotofield"?<Palette size={18}/>:<ImageIcon size={18}/>,
      onSelect:()=>{
        switch(action.kind){
          case "open":location.hash=action.href;break;
          case "create":setCapabilityId(action.workflowId);location.hash="image";break;
          case "router":setRouterImageTab(action.tab);location.hash="image";break;
          case "workflow":choose(action.workflowId);break;
        }
      },
    })),
    models:catalogue.filter(m=>workspaceMenu.imageWorkflows.includes(m.id)).map(m=>({
      id:m.id,icon:<Sparkles size={18}/>,title:menuTitle(m),text:capabilityPurpose(m),
      ...(isImported(m.id)?{hint:importedHint(m)}:{}),onSelect:()=>choose(m.id),
    })),
    footer:menuFooter(workspaceMenu.imageFooter),
  };
  /* Both menus show their entries as rows by function (FunctionMenu); "All workflows" opens the full list. */
  videoMenu.groups=groupMenu("video",[...videoMenu.features,...videoMenu.models]);
  if(threeDMenu)threeDMenu.groups=groupMenu("3d",[...threeDMenu.features,...threeDMenu.models]);
  imageMenu.groups=groupMenu("image",[...imageMenu.features,...imageMenu.models]);
  const section=sectionOf(route);
  const workspaceBar=!catalogueScreen&&!nodes&&section!=="3d";
  useDensity();
  /* While the server is away the problem bar already states the cause, so the body waits quietly. */
  const waiting=offline||!authorized||(!!error&&!catalogue.length);
  const fallbackNext=resolved.kind==="missing"&&!waiting?resolved.next:undefined;
  const fallbackTitle=waiting?"Waiting for the team server":resolved.kind==="missing"?resolved.title:"Checking what this computer can run";
  const fallbackText=resolved.kind==="missing"&&!waiting?resolved.text:undefined;
  const topCurrent=modelsOverlay.open?"#catalogue":section==="characters"?"#studios":`#${route==="openjutsu"?"video":route==="imageedit"?"image":route}`;
  async function savePreviewCrop(file:File){
    if(!canCreate||!project)throw new Error("Choose a project with creator access to save a crop.");
    const form=new FormData();form.append("file",file);
    const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${project.id}`),"POST",form);
    refresh();return {src:`/api/v1${workspacePath(workspace.id,`assets/${asset.id}/content`)}`,name:asset.name};
  }
  /* Change a video is one screen: the panel and the results pane beside it stay, only the tool body swaps
     inside them, and the pane keeps showing the runs of the tool that is open. */
  const changeScreen=(target:Project,tool:"person"|"swap"|"edit",body:ReactNode)=>{
    const capabilities=tool==="person"?["scail2-character-replace","local-jutsu-replace","openjutsu-h3-swap",...CLOUD_REPLACE_MODELS]:[swapEditRoute?.manifest.id??"","wan21-vace-masked-edit-reference"];
    return <div className="cf-production"><Panel>{body}</Panel><ProductionContent><TeamRuns examples="video" workspace={workspace} project={target} call={call} canEdit={canCreate} authorized={authorized} version={version} user={user} hero={latest=><ToolHero latest={latest} kind={tool==="person"?"replace":tool} workflowId={tool==="person"?replaceRoute?.manifest.id:swapEditRoute?.manifest.id}/>} titles={catalogueTitles(catalogue)} capabilityId={capabilities} feed={feedScope(catalogue,"video",capabilities)}/></ProductionContent></div>;
  };
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
          ...(renderTime(run)?[{label:"Render time",value:renderTime(run)!}]:[]),
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
    if(m.id===VIDEO_REFRAME_ID)return {hash:VIDEO_REFRAME_HASH,mode:"transform" as const};
    if(isOpenJutsuAdvanced(m.id)||isOpenJutsuSingleSwap(m.id))return {hash:`openjutsu/${m.id}`,mode:"transform" as const};
    if(m.category==="motion")return {hash:"video/transform/motion",mode:"transform" as const};
    if(isMaskedEdit(m))return swapMaskRoute&&swapEditRoute?{hash:"video/edit",mode:"edit" as const}:undefined;
    const surface=capabilitySurface(m);
    if(surface==="video-effect")return {hash:"video/transform/restyle",mode:"transform" as const};
    if(isFlashVideoCreate(m.id)||surface==="video-enhance")return {hash:videoWorkflowHash(m.id),mode:"create" as const};
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
  const composerProps={catalogue,user,workspace,call,canQueue:canCreate,authorized,onQueued:refresh,
    onWorkerSettings:openWorkerSettings,onModels:openModels,onRunLocal:()=>setRunOn("local")};
  function renderOpenJutsu(project:Project,screen:Extract<ResolvedScreen,{kind:"openjutsu"}>["selection"]){
    if(screen.kind==="composer"){
      return <TeamComposer key={`${project.id}:${screen.manifest.id}`} manifest={screen.manifest} {...composerProps}
        modelChoice={{title:"OpenJutsu",subtitle:screen.subtitle,options:screen.options}}
        onCapability={id=>{location.hash=id===replaceRoute?.manifest.id?"openjutsu/multi":`openjutsu/${id}`;}}
        project={project} workers={localWorkers}/>;
    }
    if(screen.kind==="experimental"){
      const back=<LinkButton variant="ghost" href="#openjutsu">Back to OpenJutsu</LinkButton>;
      if(!replaceRoute)return <Page narrow><EmptyState title="Multiple-character workflow is not ready"
        text="Check SCAIL-2 and its required models on this computer." action={back}/></Page>;
      return changeScreen(project,"person",<ReferenceReplacePanel key={`${project.id}:multi-character`} top={back}
        workspace={workspace} project={project} workerId={replaceRoute.workerId}
        call={call} canEdit={canCreate} onChanged={refresh}/>);
    }
    return <CloudRenderStudio key={`${workspace.id}:${project.id}:openjutsu`} feature="openjutsu"
      workspace={workspace} project={project} user={user} call={call} version={version} canEdit={canCreate}
      onQueued={refresh} onSettings={()=>hosted?setCloudSignIn(true):setSettings("account")}
      onLocal={()=>{setRunOn("local");location.hash=openjutsuCanRunLocal?"openjutsu":"video";}}/>;
  }

  /* A screen whose content fills the work area declares it on its page, and the WorkspaceBar reads only that
     declaration (rule 35), so no DS rule keeps a list of screen names. Reading pages stay capped. */
  const activeTarget=navigation?.runTargets.selected??runOn;
  const runOnLabel=activeTarget==="chatgpt"?"ChatGPT":activeTarget==="router"?"Comfy Router":
    activeTarget==="cloud"||!openJutsuNav&&user.guest?"Comfy Cloud":"This computer";
  const runOnControl=canCreate&&!!screenRunChoices?.length&&<TeamChoice label="Run on" variant="pill"
    display={runOnLabel} value={activeTarget} options={screenRunChoices} onChange={value=>{
      if(!openJutsuNav){if(!studioRoute)pickRunOn(value);return;}
      if(value==="local"&&openjutsuCanRunLocal){setRunOn("local");location.hash="openjutsu";}
      else if(value==="router"){setRunOn("router");location.hash="openjutsu/cloud";}
    }}/>;

  const workspaceControl=workspaces.length>1&&<div className="cf-workspace-picker">
    <TeamChoice label="Workspace" variant="pill" display={workspace.name} value={workspace.id} onChange={onWorkspace}
      options={workspaces.map(w=>({value:w.id,label:w.name,note:w.role}))}/>
  </div>;
  const jobs=workspaceMenu.topBar.jobs&&<JobQueueIndicator version={version} workspace={workspace} call={call} authorized={authorized} titles={catalogueTitles(catalogue)} onOpenRun={run=>{setProjectId(run.project_id);location.hash=`library/runs/${run.id}`;}}/>;
  const screenAccess={workspace,call,canEdit:canCreate};
  const studioAccess={...screenAccess,user,authorized};
  const inProject=(render:(project:Project)=>ReactNode)=>()=>project&&render(project);
  const page=(children:ReactNode,layout?:"fill"|"workspace",hero?:HeroKind)=>(
    <div className="cf-team__body">
      <section className={`cf-team__content ds-page${layout?` ds-page--${layout}`:""}`}>
        {hero&&<div className="cf-team__pagehero"><ToolHero kind={hero}/></div>}
        {children}
      </section>
    </div>
  );
  const renderRecovery=inProject(()=><div className="cf-team__body">
    <section className="cf-team__content"><Page narrow><EmptyState stage title={fallbackTitle} text={fallbackText} action={fallbackNext?<Button variant="secondary" onClick={()=>{location.hash=fallbackNext.href;}}>{fallbackNext.label}</Button>:undefined}/></Page></section>
  </div>);
  const renderBlock=inProject(project=>block&&page(<BlockWorkspace screen={block} key={project.id} workspace={workspace} project={project} call={call}
    canCreate={canCreate} onQueued={refresh} depthRoute={id=>routeFor(id,localWorkers)}
    presetTool={presetTool} onTarget={setRunOn}
    onRouter={(id,prompt)=>setRouterIncoming({workspaceId:workspace.id,projectId:project.id,inputs:{source_video:id},prompt})}/>,"fill"));
  const renderEdit=inProject(project=>editScreen&&page(<ImageEditor key={`${user.id}:${workspace.id}:${project.id}:${editScreen.assetId??""}`}
    openAssetId={editScreen.assetId} openEntry={editScreen.entry} userId={user.id} freeInput={intentMode}
    {...screenAccess} project={project} authorized={authorized}
    inpaint={inpaintRoute} edit={editRoute} editOptions={editRoutes} segment={routeFor("sam3-image-segment")}
    precision={routeFor("flux2-klein-preserve-edit")} maskedEdit={routeFor("qwen-image-21-masked-edit")}
    upscale={routeFor("upscale-image-esrgan")} onOpenModels={openModels}
    onExitSubjectRelight={()=>{location.hash=`imageedit/${editScreen.kind==="fotofield"?"layers/":""}${editScreen.assetId??""}/modify`;}}/>,"workspace"));
  const renderImage=inProject(project=>page(manifest&&isImageCapability(manifest)?<ImageStudio
    sharedFeed={<TeamRuns {...studioAccess} project={project} version={version}
      titles={catalogueTitles(catalogue)} feed={feedScope(catalogue,"image",[manifest.id])}
      examples="image" outputAction={run=>run.output_ids[0]?<>
        <LinkButton variant="secondary" href={`#imageedit/${encodeURIComponent(run.output_ids[0])}`}>Edit image</LinkButton>
        {canCreate&&<Button variant="secondary" onClick={()=>void useImageInVideo(run.output_ids[0])}>Use in video</Button>}
        {canCreate&&studio?.kind==="marketing"&&<Button variant="secondary" onClick={()=>useImageInStoryboard(project,run.output_ids[0])}>Add to storyboard</Button>}
      </>:null} hero={()=> <ToolHero kind={studio?.kind==="remix"?"remix":"picture"}/>}/>}
    adStudio={studio?.kind==="marketing"} remixStudio={studio?.kind==="remix"}
    modelOptions={(studio?.choices??imageModelsForTab(shownImages,imageTab)).map(m=>({value:m.id,label:m.title.split(" (")[0],note:capabilityPurpose(m)}))}
    onModel={(id,inputs)=>{
      const selected=(studio?.choices??catalogue).find(m=>m.id===id);
      if(!selected)return;
      const nextDraft=inputs?imageDraftWithReferences(selected,imageDraft,inputs)
        :studio?imageDraftForTab(selected,imageDraftMemory.current,imageDraft)
        :imageTabFor(manifest.id,route)==="create"&&imageTabFor(selected.id,route)==="create"?carryCreateDraft(selected,imageDraft)
        :defaultImageDraft(selected);
      setCapabilityId(id);
      imageDraftMemory.current[id]=nextDraft;
      setImageDraft(nextDraft);
      location.hash=studio?`${studio.kind}/${id}`:nativeWorkflowHash(selected);
    }}
    key={`${project.id}:${manifest.id}`} workspace={workspace} project={project} manifest={manifest}
    readiness={canCreate?(imageReadiness??{state:"offline",reasons:["Image readiness has not been checked."],missing:[]})
      :{state:"unsupported",reasons:[workspace.role==="viewer"?"Viewer access is read-only.":"Sign in to generate images."],missing:[]}}
    workerName={imageWorker?.name} onUseInVideo={canCreate?assetId=>void useImageInVideo(assetId):undefined}
    onUseInStoryboard={canCreate&&studio?.kind==="marketing"?assetId=>useImageInStoryboard(project,assetId):undefined}
    batchContext={{userId:user.id,workerId:imageWorker?.id??"",call,onChanged:refresh,photosetAllowed:identityPhotosetWorkerAllowed(user.localSingleUser,imageWorker?.origin)}}
    assets={imageAssets} runs={imageRuns} sharedCreate={!studio&&imageTab==="create"}
    createModelIds={shownImages.filter(m=>imageTabFor(m.id,"image")==="create").map(m=>m.id)}
    draft={imageDraft} busy={imageBusy} onDraftChange={draft=>{setImageDraft(draft);imageDraftMemory.current[manifest.id]=draft;setImageIntentKey("");}}
    onGenerate={draft=>void generateImage(draft)} onCancel={canCreate?cancelImageRun:undefined}
    canCancelRun={run=>workspace.role==="admin"||run.created_by===user.id} onRetake={canCreate&&!imageIntentKey&&!imageBusy?retakeImage:undefined}/>:null,manifest?"fill":undefined));
  const renderComposer=inProject(project=>page(composerManifest?<TeamComposer key={`${project.id}:${composerManifest.id}`} manifest={composerManifest}
      workflowIds={effects?[effects.id]:motion?.workflowIds} onCapability={chooseWorkflow} {...composerProps} project={project} workers={makeReal?localWorkers:runWorkers}/>:null,composerManifest?"fill":undefined));
  const screenRenderers={
    openjutsu:inProject(project=>openJutsuScreen&&<section className="cf-team__content ds-page ds-page--fill">{renderOpenJutsu(project,openJutsuScreen.selection)}</section>),
    "chatgpt-unavailable":inProject(()=><section className="cf-team__content"><Page narrow><EmptyState title="ChatGPT edits images here" text="This feature uses a different renderer. Choose this computer to continue here, or open the image editor for ChatGPT." action={<Button variant="secondary" onClick={()=>setRunOn("local")}>Use this computer</Button>}/></Page></section>),
    chatgpt:inProject(project=>chatgpt&&<section className="cf-team__content">
        <ChatgptImageStudio key={`${workspace.id}:${project.id}:${routeHash}:${chatgpt.feature}`} feature={chatgpt.feature}
          {...screenAccess} incoming={incoming} project={project} user={user} version={version} onQueued={refresh}/>
      </section>),
    router:inProject(project=>routerScreen&&<section className="cf-team__content"><CloudRenderStudio key={`${workspace.id}:${project.id}:${route}:${videoMode}:${routerImageTab}:${linkedImage??""}:${changeChoiceFromHash(routeHash)}`}
      {...screenAccess} incoming={incoming} feature={routerScreen.feature} project={project} user={user} version={version} onQueued={refresh}
      onSettings={()=>hosted?setCloudSignIn(true):setSettings("account")} onLocal={()=>setRunOn("local")}
      onFeature={f=>{location.hash=`video/transform/${f==="replace-character"?"person":f==="motion-transfer"?"motion":f==="object-swap"?"swap":f==="video-upscale"?"upscale":f==="video-cutout"?"cutout":"restyle"}`;}}/></section>),
    "3d":inProject(project=>threeD&&<section className="cf-team__content cf-nodes-page">
        <ThreeDStudio tool={threeD.tool} navigation={workspaceMenu.threeD} status={<ProblemBar/>}>
      {threeD.tool==="image"?<ImageTo3DPanel manifest={threeD.manifest} workflows={threeD.choices}
        initialAssetId={threeD.assetId} onCapability={id=>{location.hash="3d/image/"+id+(threeD.assetId?"/"+threeD.assetId:"");}}
        {...studioAccess} project={project} workers={targetWorkers(workers,navigation.runTargets.selected)} onQueued={refresh}/>
      :threeD.tool==="text"?<TextTo3DPanel {...studioAccess} key={project.id} catalogue={catalogue}
        project={project} workers={runWorkers} onQueued={refresh}/>
      :threeD.tool==="viewer"||threeD.tool==="mesh"||threeD.tool==="texture"?<ModelToolsPanel
        key={[project.id,threeD.tool,threeD.assetId].join(":")} mode={threeD.tool}
        initialAssetId={threeD.assetId} tools={workspaceMenu.threeD.tools.map(tool=>tool.id)}
        {...screenAccess} project={project} onChanged={refresh}/>:null}
        </ThreeDStudio>
      </section>),
    nodes:()=>nodes&&<section className="cf-team__content cf-nodes-page"><ComfyNodes screen={nodes}
        workspace={workspace} workers={targetWorkers(workers,nodes.target)} catalogue={catalogue.filter(m=>localReady.has(m.id))}
        canEdit={canCreate} serverOffline={offline} onChanged={refresh} onWorkerSettings={openWorkerSettings}/></section>,
    projects:()=><section className="cf-team__content"><Page narrow><TeamProjects
        projects={projects} projectId={projectId} loading={projectsLoading&&!waiting} canCreate={canCreate}
        onCreate={createProject} onOpen={id=>{setProjectId(id);location.hash="library";}}/></Page></section>,
    checking:renderRecovery,
    missing:renderRecovery,
    block:renderBlock,
    "film-studio":renderBlock,
    workflow:inProject(project=>explicitWorkflow&&page(<TeamComposer key={`${project.id}:${routeHash}`} manifest={explicitWorkflow}
      onCapability={choose} {...composerProps} project={project} workers={runWorkers}/>,"fill")),
    make:inProject(()=>page(<StartScreen tools={workspaceMenu.tools} onOpen={openStartTask} hosted={workspaceAudience!=="local"}/>)),
    imageedit:renderEdit,
    fotofield:renderEdit,
    characters:inProject(project=>characters&&page(<CharacterWorkspace {...studioAccess} mode={characters.tab} project={project} catalogue={catalogue}
      onOpenStoryboard={boardId=>{setVideoMode("storyboard");location.hash=`video/storyboard/${encodeURIComponent(boardId)}`;}}
      onOpenCharacters={()=>openProjectTab("characters")}
      onOpenScenes={canCreate?()=>openProjectTab("scenes"):undefined}
      onOpenImages={characterEditor?record=>openCharacterImages(record,characterEditor,project.id):undefined}
        />,undefined,characters.tab==="characters"?"cast":"scenes")),
    audio:inProject(project=>audioRequirements&&page(<AudioStudio userId={user.id} key={`${workspace.id}:${project.id}`} workspace={workspace} project={project} call={call} requirements={audioRequirements} onChanged={refresh} onLipSync={canCreate&&readyManifests.some(m=>!!m.voiceContract)?(assetId,imageAssetId)=>void useAudioInLipSync(assetId,imageAssetId):undefined}/>)),
    "edit-area":inProject(project=>editArea&&page(changeScreen(project,"edit",editArea.ready&&swapEditRoute?
      <SwapThingPanel promptOnly modelTitle={swapEditRoute.manifest.title} key={`edit:${project.id}:${editArea.assetId??""}`}
        {...screenAccess} initialVideo={editArea.assetId} project={project} workerId={swapEditRoute.workerId} onChanged={refresh}/>:
      <EmptyState title="Video editing is not ready" text="Check the required local workflows in Models."
        action={<Button variant="secondary" onClick={openModels}>Open Models</Button>}/>),"fill")),
    trim:inProject(project=>trim&&videoEditRequirements&&page(<VideoEditStudio key={`${workspace.id}:${project.id}`} initialAssetId={trim.assetId}
      {...screenAccess} project={project} requirements={videoEditRequirements} onChanged={refresh}
      userId={user.id} extensionWorkerId={trimExtension?.workerId}
      maxGenerationFrames={trimExtension?.manifest.controls.find(control=>control.id==="generation_frames")?.max??13}/>,"fill")),
    transform:inProject(project=>transform&&page(<TransformVideo manifests={catalogue} statuses={statuses} user={user} workspace={workspace} project={project}
      workers={transform.choice==="reframe"?localWorkers:runWorkers} call={call} canQueue={canCreate} authorized={authorized}
      onCapability={setCapabilityId} onQueued={refresh} onModels={openModels} choice={transform.choice} reframe={transform.reframe}
      swapThing={objectSwapLocal?top=><TeamComposer key={`${project.id}:${objectSwapLocal.id}`} top={top} manifest={objectSwapLocal}
        workflowIds={[objectSwapLocal.id]} onCapability={choose} {...composerProps} project={project} workers={runWorkers}/>
        :swapMaskRoute&&swapEditRoute?top=>changeScreen(project,"swap",<SwapThingPanel {...screenAccess} key={project.id}
          top={top} project={project} workerId={swapEditRoute.workerId} onChanged={refresh}/>):undefined}
        />,"fill")),
    image:renderImage,
    remix:renderImage,
    marketing:renderImage,
    keyframes:inProject(project=>keyframes&&page(<KeyframeStudio {...studioAccess} key={`${workspace.id}:${project.id}`} project={project}
      catalogue={catalogue} workers={runWorkers}
      localEnabled={keyframes.target==="local"} onChanged={refresh}/>,"fill")),
    storyboard:inProject(project=>storyboard&&page(<TeamStoryboard key={`${project.id}:${storyboard.boardId??""}`}
      initialBoardId={storyboard.boardId} runTarget={storyboard.target}
      incomingPremise={storyboardIdea?.projectId===project.id&&storyboardIdea.workspaceId===workspace.id?storyboardIdea.text:undefined}
      incomingAssetId={storyboardImage?.projectId===project.id&&storyboardImage.workspaceId===workspace.id?storyboardImage.assetId:undefined}
      onPremiseConsumed={()=>setStoryboardIdea(null)} onIncomingConsumed={()=>setStoryboardImage(null)}
      {...studioAccess} project={project} catalogue={catalogue} workers={targetWorkers(workers,storyboard.target)}/>,"fill")),
    video:renderComposer,
    motion:renderComposer,
    effects:renderComposer,
    "make-real":renderComposer,
    library:inProject(project=>library&&page(<TeamLibrary {...studioAccess} screen={library} titles={catalogueTitles(catalogue)} key={project.id}
      project={project} version={version} videoEditReady={trimReady} onEditVideo={asset=>{location.hash=`video/trim/${asset.id}`;}}/>,undefined,"library")),
    catalogue:()=>null, // The Models dialog is owned by the shell.
    showcase:()=>null, // Standalone roots are mounted by main.tsx.
    "node-design":()=>null,
  } satisfies Record<ResolvedScreen["kind"],()=>ReactNode>;

  const accountMenu=workspaceMenu.account;
  const accountName=account?.name??user.email;
  const accountAudience=audienceOf(user);
  const accountActions:Record<AccountAction,UserMenuItem>={
    guide:{id:"guide",label:"How it works",icon:<CircleHelp size={14}/>,onSelect:()=>setGuide(true)},
    settings:{id:"settings",label:settingsLabel(accountAudience),icon:<Settings size={14}/>,onSelect:()=>setSettings("account")},
    "sign-out-comfy":{id:"cloud-out",label:"Sign out of Comfy",icon:<LogOut size={14}/>,onSelect:()=>void signOutCloud()},
    "sign-out":{id:"out",label:"Sign out",icon:<LogOut size={14}/>,onSelect:()=>void onSignOut()},
  };
  const accountControl=accountMenu.kind==="sign-in"
    ?<Button variant="primary" onClick={()=>setCloudSignIn(true)}>Sign in</Button>
    :<UserMenu
      initials={accountName.slice(0,1).toUpperCase()}
      name={accountName}
      meta={account?.connected
        ?<><Meta>{account.email}</Meta><Meta>{account.workspace}</Meta></>
        :<Meta parts={workspaceFacts(accountAudience,workspace)}/>}
      extra={account?.connected?<>
        {typeof account.credits==="number"&&<span className="ds-usermenu__row">
          <Meta>{account.credits.toLocaleString()+" credits"}</Meta>
          {account.addCreditsUrl&&<LinkButton variant="ghost" href={account.addCreditsUrl} target="_blank" rel="noreferrer">
            {account.canSubmit===false?"Upgrade plan":"Add credits"}
          </LinkButton>}
        </span>}
        {account.canSubmit===false&&<Meta>{CLOUD_PLAN_LINE}</Meta>}
        {accountMenu.showKeyPrivacy&&<Meta>Your Comfy key is saved in this browser only. CreativeField never stores it.</Meta>}
      </>:undefined}
      items={accountMenu.items.map(action=>accountActions[action])}
    />;
  const runControls=<>
    {workspaceMenu.topBar.freeInput&&<ExpandToggle icon={<Sparkles size={16}/>} label="Free input" on={intentMode} onChange={setIntentMode}/>}
    {runOnControl}
    {workspaceControl}
  </>;
  return <div className="cf-team">
    <Welcome tools={workspaceMenu.tools} onOpen={openStartTask} onCloud={accountMenu.kind==="sign-in"?()=>setCloudSignIn(true):undefined}/>
    {guide&&<Guide
      hosted={hosted} cloudConnected={!!account?.connected} onClose={()=>setGuide(false)}
      onCloudSignIn={hosted?()=>{setGuide(false);setCloudSignIn(true);}:undefined}
      onOpenWorkers={workspaceMenu.settings.workerSetup
        ?()=>{setGuide(false);openWorkerSettings();}:undefined}
    />}
    {cloudSignIn&&<CloudSignIn workspaceId={workspace.id} call={call} onClose={()=>setCloudSignIn(false)} onSignedIn={signedInCloud}/>}
    <ScrollFades/><Reveal/>
    <TopBar
      more={phone?runControls:undefined}
      brand={<img className="ds-topbar__brand-image" src={logo} alt="CreativeField"/>}
      current={topCurrent}
      items={[
        {label:"Video",href:"#video",menu:videoMenu,icon:<Clapperboard size={20}/>},
        {label:"Image",href:"#image",menu:imageMenu,icon:<ImageIcon size={20}/>},
        {label:"3D",href:"#3d",menu:threeDMenu},
        ...(workspaceMenu.sections.includes("audio")?[{label:"Audio",href:"#audio"}]:[]),
        {label:"All tools",href:"#make",icon:<LayoutGrid size={20}/>},
        ...(workspaceMenu.sections.includes("nodes")?[
          {label:"Models",href:"#catalogue",onSelect:openModels},{label:"Nodes",href:"#nodes"},
        ]:[]),
      ]}
      secondary={[
        {label:"Library",href:"#library",icon:<LibraryIcon size={20}/>},
        {label:"Projects",href:"#projects",suffix:project?.name,dropdown:{
          items:projects.map(p=>({id:p.id,title:p.name,onSelect:()=>setProjectId(p.id)})),
          selectedId:projectId,
          footer:canCreate?{id:"add",icon:<Plus size={14}/>,title:"Add project",onSelect:()=>setCreatingProject(true)}:undefined,
        }},
      ]}
      end={<>
        {!phone&&runControls}
        <IconLink label="Source code on GitHub" href="https://github.com/rhymeas/Creativefield"><Github size={phone?18:16}/></IconLink>
        <IconButton label="How it works" onClick={()=>setGuide(true)}><CircleHelp size={phone?18:16}/></IconButton>
        {jobs}
        {accountControl}
      </>}
    />
    <WorkflowInfoProvider><MediaEditProvider canAnnotate={!!editRoute} onEdit={canCreate?editPreview:undefined} saveCrop={canCreate?savePreviewCrop:undefined} tools={mediaTools}><RecreateProvider value={recreate}><RecreateMediaProvider value={recreateMedia}><AmbientReelProvider src={reelForSection(section)}>
    <div className="cf-team__body">
    <div className="cf-team__main ds-canvas">
    {workspaceBar&&<WorkspaceBar density={route!=="imageedit"}
      tabs={videoTabs?{
        label:"Video workspace",value:videoTabs.active,items:videoTabs.items,onChange:id=>{
          const tab=videoTabs.items.find(item=>item.id===id);
          if(tab?.mode)setVideoMode(tab.mode);
          if(tab?.href)location.hash=tab.href;
        },
      }
        :projectTabs?{
          label:projectTabs.label,value:projectTabs.active,items:projectTabs.items,onChange:openProjectTab,
        }
        :imageTabs?{label:"Image workspace",value:imageTabs.active,items:imageTabs.items,onChange:id=>{
          const tab=imageTabs.items.find(item=>item.id===id);
          if(!tab?.action)return;
          const {action}=tab;
          if(action.kind==="provider")setRouterImageTab(tab.id);
          else{
            setImageDraft(imageDraftForTab(action.manifest,imageDraftMemory.current,imageDraft));
            setCapabilityId(action.manifest.id);
          }
          location.hash=action.href;
        }}
        :undefined}
      end={<><ProblemBar/>{navigation.section==="make"&&<GettingStarted userId={user.id} workspaceId={workspace.id} admin={workspace.role==="admin"} audience={audienceOf(user)} workers={workers} onModels={openModels} onSettings={()=>setSettings("workers")}/>}</>}
      info={<WorkflowInfoButton/>}
      />}
    {askCloud&&<CloudRunConsent onUse={useCloud} onKeep={keepLocal}/>}
    {(catalogueScreen||nodes)&&<ProblemBar/>}
    {offline&&<Notice priority={100} title="Team server unavailable" actions={<Button variant="secondary" onClick={refresh}>Retry connection</Button>}>Drafts remain available. No execution route will be switched.</Notice>}
    {!authorized&&!offline&&<Notice priority={90} title="Reconnect to continue" actions={<Button variant="secondary" onClick={onReconnect}>Reconnect</Button>}>Your draft is preserved.</Notice>}
    {error&&!offline&&authorized&&failure&&<Notice priority={50} title={failure.title||undefined} actions={<Button variant="secondary" onClick={refresh}>Try again</Button>} details={error}>{failure.text}</Notice>}
    {screenRenderers[resolved.kind]()}
    {intentMode&&route!=="openjutsu"&&route!=="imageedit"&&workspaceBar&&project&&<IntentDock imageWorkspace={["image","remix","marketing"].includes(route)} videoWorkspace={route==="video"||route==="motion"} value={intentText} onChange={setIntentText} onSubmit={runIntent} available={intentAvailable} busy={imageBusy||intentUploading} reference={intentReference?{name:intentReference.name,src:assetUrl(workspace.id,intentReference.id)}:undefined} referenceError={intentReferenceError} onReferenceAsset={id=>void intentAsset(id)} onReferenceFile={file=>void intentFile(file)} onRemoveReference={clearIntentReference}/>}
    </div>
    </div>
    </AmbientReelProvider></RecreateMediaProvider></RecreateProvider></MediaEditProvider></WorkflowInfoProvider>
    <Dialog wide className="cf-models-dialog" open={modelsOverlay.open&&authorized} title="Models" onClose={closeModels}>
      <CapabilityCatalogue embedded manifests={navigation.catalogueManifests} statuses={statuses} checking={checking}
        recheckLabel={workspace.role==="admin"?"Probe workers and recheck":"Refresh status"}
        onRecheck={()=>void recheck()} onChoose={id=>{setModelsRequested(false);choose(id);}}
        library={controls=><ComfyLibraryPanel workspace={workspace} workers={workers} call={call} controls={controls} onWorkerSettings={()=>setSettings("account")}/>}
        onLibrary={()=>{const enhancer=readyManifests.find(m=>m.category==="enhance");if(!enhancer)return;setModelsRequested(false);setVideoMode("create");setCapabilityId(enhancer.id);location.hash="video";}}/>
    </Dialog>
    <ProjectCreateDialog open={creatingProject&&canCreate} onClose={()=>setCreatingProject(false)} onCreate={createProject}/>
    <TeamSettings
      initialSection={authorized?settings:null} navigation={workspaceMenu.settings} onClose={closeSettings}
      workspace={workspace} user={user} workers={workers} call={call} onChanged={refresh} onSignOut={onSignOut}
    />
  </div>;
}


