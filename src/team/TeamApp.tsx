import {Box,Clapperboard,Footprints,Image as ImageIcon,LogOut,Maximize2,Move,Palette,Plus,Scissors,Settings,Sparkles,Video} from "lucide-react";
import {annotationStorageKey,imageAnnotationsSchema} from "../image/annotations";
import {TeamStoryboard} from "./TeamStoryboard";
import {ReferenceReplacePanel} from "./ReferenceReplacePanel";
import {StartScreen} from "./StartScreen";
import {GettingStarted} from "./GettingStarted";
import {SwapThingPanel} from "./SwapThingPanel";
import {changeChoiceFromHash,type StartTask} from "./start-tasks";
import {ProjectCreateDialog,TeamProjects} from "./TeamProjects";
import {useCallback,useEffect,useRef,useState,type ReactNode} from "react";
import {Panel,Reveal,ExpandToggle,AmbientReelProvider,MediaEditProvider,type MediaEditSource,type MediaToolSet,ScrollFades,useDensity,Button,EmptyState,Page,ShimmerText,ToastHost,UserMenu,ProblemBar,ProblemHost,Dialog,Meta,Notice,TopBar,WorkspaceBar,LinkButton} from "../ds";
import {AuthPanel} from "./AuthPanel";
import {ApiError,assetUrl,request,workspacePath,type Asset,type AssetPage,type Call,type RequestOptions,type Run,type User,type Workspace,type Project,type Worker,type Catalogue} from "./api";
import {TeamComposer} from "./TeamComposer";
import {TransformVideo} from "./TransformVideo";
import {TeamLibrary,TeamRuns} from "./TeamLibrary";
import {JobQueueIndicator} from "./JobQueueIndicator";
import {TeamSettings} from "./TeamSettings";
import {ChatgptImageStudio} from './ChatgptImageStudio';
import {CloudRenderStudio} from "./CloudRenderStudio";
import {cloudFeature} from "../capabilities/router-models";
import {TeamChoice} from "./TeamChoice";
import {CapabilityCatalogue} from "../ui/CapabilityCatalogue";
import {bestWorkerReadiness,defaultDraft,draftKey,refreshWorkerInventory,workerReadiness} from "./state";
import {plainProblem} from "./problems";
import {audienceOf,noWorkspaceText,settingsLabel,workspaceFacts} from "./audience";
import type {CapabilityManifestV2,Readiness} from "../capabilities/types";
import "./team.css";
import {isMaskedEdit} from "./masked-state";
import {WorkflowInfoProvider,WorkflowInfoButton} from "./workflow-info";
import {reelForSection} from "./reels";
import {capabilityPurpose,capabilitySurface,isCreateVideoWorkflow,isImageWorkflow,isVideoWorkflow} from "../capabilities/surfaces";
import {ImageStudio} from "../image/ImageStudio";
import {ImageEditor} from "../image/editor/ImageEditor";
import {defaultImageDraft,imageRunBody,type ImageDraft} from "../image/image-state";
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
import type {IntentTarget} from "./intent/router";
import {nativeWorkflowHash} from "./workflow-navigation";
import {routeState,sectionFromHash} from "./route-state";
import {videoHashPart,videoWorkflowHash} from "../ui/studio-route";
import {selectTransformManifest} from "./transform-video-state";
import {catalogueTitles} from "./job-queue";
import {firstSentence} from "./TeamComposer";
import {ToolHero,type HeroKind} from "./heroes";
import logo from "../assets/creativefield-logo-trim.png";
import {RecreateProvider,type RecreateRun} from "./recreate";

/** A worker's kind comes from the server; the shared Worker type does not carry it yet. */
export type VideoWorkspaceMode="create"|"edit"|"trim"|"storyboard"|"effects"|"transform"|"replace"|"workflow";
export function videoWorkflowMode(manifest:CapabilityManifestV2):VideoWorkspaceMode{
  if(manifest.id==="video-edit")return "trim";
  if(isMaskedEdit(manifest))return "edit";
  if(capabilitySurface(manifest)==="video-effect")return "effects";
  return isCreateVideoWorkflow(manifest)||capabilitySurface(manifest)==="video-enhance"?"create":"workflow";
}
export type RunTarget="local"|"cloud"|"router"|"chatgpt";
export const isCloudWorker=(worker:Worker)=>(worker as Worker&{kind?:"local"|"cloud"}).kind==="cloud";
/** Every creative canvas offers the cloud setup path; this computer remains the default. */
export function runTargetOptions(workers:Worker[],imageEditing=false):{value:RunTarget;label:string;note?:string}[]|undefined{
  return [{value:"local",label:"This computer"},{value:"cloud",label:"Comfy Cloud",note:workers.some(isCloudWorker)?"Connected · uses your Comfy Cloud credits":"Set up a cloud worker · no render starts"},{value:"router",label:"Comfy Router · BYOK",note:"Hosted models · your Comfy credits"},...(imageEditing?[{value:"chatgpt" as const,label:"ChatGPT",note:"Your sign-in · subscription quota"}]:[])];
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
const ANGLE_WORKFLOWS=["flux2-klein-angles","qwen-image-21-angles"],RELIGHT_WORKFLOW="flux2-klein-relight";
/** The angle workflow this computer really has ready: the camera-angle tool first, then the 45° angle shots. */
export function angleWorkflow<T extends {id:string}>(ready:T[]):T|undefined{
  return ready.find(m=>m.id==="flux2-klein-angles")??ready.find(m=>m.id==="qwen-image-21-angles");
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
/** The workflow a tab opens; Create takes the first ready picture workflow that is not a tool. */
export function imageTabTarget<T extends {id:string;inputs?:Array<{required:boolean}>}>(tab:ImageTab,ready:T[]):T|undefined{
  if(tab==="angles")return angleWorkflow(ready);
  if(tab==="relight")return ready.find(m=>m.id===RELIGHT_WORKFLOW);
  if(tab==="edit")return undefined;
  return ready.find(m=>m.id!==RELIGHT_WORKFLOW&&!ANGLE_WORKFLOWS.includes(m.id)&&(!m.inputs||m.inputs.every(port=>!port.required)));
}
/** A tab starts from its own earlier draft, so its preset is still there when you come back.
    A first visit keeps the picture that is already chosen on the other tab. */
export function imageDraftForTab(manifest:CapabilityManifestV2,remembered:Record<string,ImageDraft>,showing:ImageDraft):ImageDraft{
  const earlier=remembered[manifest.id];
  if(earlier)return earlier;
  const inputs=Object.fromEntries(Object.entries(showing.inputs??{}).filter(([port,asset])=>!!asset&&manifest.inputs.some(input=>input.id===port&&input.type==="image")));
  return Object.keys(inputs).length?{...defaultImageDraft(manifest),inputs}:defaultImageDraft(manifest);
}

export default function TeamApp(){
  const [user,setUser]=useState<User|null>(null),[workspaces,setWorkspaces]=useState<Workspace[]>([]),[workspaceId,setWorkspaceId]=useState("");
  const [authRequired,setAuthRequired]=useState(false),[offline,setOffline]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const call:Call=useCallback(async<T,>(path:string,method?:string,body?:unknown,options?:RequestOptions)=>{
    try {const value=await request<T>(path,method,body,options);setOffline(false);return value;}
    catch(e){if(e instanceof ApiError){if(e.status===401)setAuthRequired(true);if(e.status===0)setOffline(true);}throw e;}
  },[]);
  const signIn=useCallback(async()=>{
    const account=await request<User>("/auth/me"),memberships=await request<Workspace[]>("/workspaces");
    setUser(account);setWorkspaces(memberships);setWorkspaceId(id=>memberships.some(w=>w.id===id)?id:memberships[0]?.id??"");setAuthRequired(false);setOffline(false);setError("");setLoading(false);
  },[]);
  useEffect(()=>{let active=true;void signIn().catch(e=>{if(active){if(!(e instanceof ApiError)||e.status!==401)setError((e as Error).message);setLoading(false);}});return()=>{active=false;};},[signIn]);
  const signOut=useCallback(async()=>{await call("/auth/logout","POST");setUser(null);setWorkspaces([]);setWorkspaceId("");setAuthRequired(false);},[call]);
  const closeReauth=useCallback(()=>{},[]);
  const workspace=workspaces.find(w=>w.id===workspaceId);
  if(loading)return <div className="cf-auth"><ShimmerText>Connecting to your team server…</ShimmerText></div>;
  if(!user)return <>{error&&<Notice title="Team server unavailable" actions={<><Button variant="secondary" onClick={()=>void signIn().catch(e=>setError((e as Error).message))}>Retry</Button></>}>{error}</Notice>}<AuthPanel onSignedIn={signIn}/></>;
  return <ToastHost><ProblemHost>
    {workspace?<TeamWorkspace key={`${user.id}:${workspace.id}`} user={user} workspace={workspace} workspaces={workspaces} onWorkspace={setWorkspaceId} call={call} authorized={!authRequired} offline={offline} onSignOut={signOut} onReconnect={()=>void signIn().catch(e=>setError((e as Error).message))}/>:<div className="cf-auth"><EmptyState title="No workspace access" text={noWorkspaceText(audienceOf(user))} action={<Button variant="secondary" onClick={()=>void signOut()}>Sign out</Button>}/></div>}
    <Dialog open={authRequired&&!user.localSingleUser} title="Sign in to continue" onClose={closeReauth}><Notice inline title="Your session has expired">Your draft is preserved. Signing in below keeps it, and you queue explicitly when ready.</Notice><AuthPanel embedded onSignedIn={signIn}/></Dialog>
  </ProblemHost></ToastHost>;
}

const sectionOf=(route:string)=>route==="openjutsu"?"video":route;
/* `#video/camera` names a workflow; `#video/trim` names a mode, and a mode wins. */
const videoWorkflowFromHash=(hash:string)=>videoModeFromHash(hash)?undefined:videoHashPart(hash);
const isImageCapability=(manifest:Catalogue[number])=>isImageWorkflow(manifest);

function TeamWorkspace({user,workspace,workspaces,onWorkspace,call,authorized,offline,onSignOut,onReconnect}:{user:User;workspace:Workspace;workspaces:Workspace[];onWorkspace:(id:string)=>void;call:Call;authorized:boolean;offline:boolean;onSignOut:()=>Promise<void>;onReconnect:()=>void}){
  const [routeHash,setRouteHash]=useState(location.hash);
  const [route,setRoute]=useState(sectionFromHash(location.hash)),[settings,setSettings]=useState(false),[modelsOpen,setModelsOpen]=useState(()=>sectionFromHash(location.hash)==="catalogue"),[creatingProject,setCreatingProject]=useState(false),[projects,setProjects]=useState<Project[]>([]),[projectId,setProjectId]=useState("");
  const [workers,setWorkers]=useState<Worker[]>([]),[catalogue,setCatalogue]=useState<Catalogue>([]),[capabilityId,setCapabilityId]=useState("");
  const [addressWorkflow,setAddressWorkflow]=useState<string|null>(()=>videoWorkflowFromHash(location.hash)??null);
  const [videoMode,setVideoMode]=useState<VideoWorkspaceMode>(()=>videoModeFromHash(location.hash)??"create");
  const [characterMode,setCharacterMode]=useState<CharacterMode>("characters");
  const [imageDraft,setImageDraft]=useState<ImageDraft>({controls:{}}),[imageAssets,setImageAssets]=useState<Asset[]>([]),[imageRuns,setImageRuns]=useState<Run[]>([]),[imageBusy,setImageBusy]=useState(false),[imageIntentKey,setImageIntentKey]=useState("");
  /* The draft each image tab was left with, so a tab switch returns to the same picture and preset. */
  const imageDraftMemory=useRef<Record<string,ImageDraft>>({});
  const [intentText,setIntentText]=useState(""),[intentMode,setIntentMode]=useState(()=>{try{return localStorage.getItem("comfyfield.intent-mode")==="1";}catch{return false;}});
  const [error,setError]=useState(""),[version,setVersion]=useState(0),[checking,setChecking]=useState(false),[,setCharacterCount]=useState(0),[audioRequirements,setAudioRequirements]=useState<AudioRequirements|null>(null),[videoEditRequirements,setVideoEditRequirements]=useState<VideoEditRequirements|null>(null);
  const cloudDraftRef=useRef<{workspaceId:string;projectId:string;inputs:Record<string,string>;prompt:string}>();
  const captureCloudDraft=useCallback((d:{workspaceId:string;projectId:string;inputs:Record<string,string>;prompt:string})=>{cloudDraftRef.current=d;},[]);
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
  useEffect(()=>{if(route!=="video"&&route!=="motion"&&route!=="image")return;if(route==="video"&&(videoMode==="transform"||videoMode==="workflow"))return;setCapabilityId(id=>{const selected=catalogue.find(m=>m.id===id);if(selected&&(route==="image"?isImageCapability(selected):route==="motion"?selected.category==="motion":videoMode==="edit"?isMaskedEdit(selected):videoMode==="effects"?capabilitySurface(selected)==="video-effect":isCreateVideoWorkflow(selected)||capabilitySurface(selected)==="video-enhance"))return id;return (route==="image"?imageTabTarget("create",catalogue.filter(m=>m.coverage.local==="implemented"&&isImageCapability(m)))?.id:undefined)??catalogue.find(m=>route==="image"?m.coverage.local==="implemented"&&isImageCapability(m):route==="motion"?m.coverage.local==="implemented"&&m.category==="motion":videoMode==="edit"?isMaskedEdit(m):videoMode==="effects"?m.coverage.local==="implemented"&&capabilitySurface(m)==="video-effect":m.coverage.local==="implemented"&&m.category==="t2v")?.id??"";});},[route,catalogue,videoMode]);
  /* A link may name the video workflow: `#video/camera`. It selects once the list is known, and an
     unknown id falls back to this screen's default. */
  useEffect(()=>{
    if(!addressWorkflow)return;
    const named=catalogue.find(m=>m.id===addressWorkflow);
    if(!named&&!catalogue.length)return;
    if(named&&route==="video"&&isVideoWorkflow(named)){setCapabilityId(named.id);setVideoMode(videoWorkflowMode(named));}
    setAddressWorkflow(null);
  },[addressWorkflow,catalogue,route]);
  useEffect(()=>{if(route!=="image")return;const named=catalogue.find(m=>m.id===routeHash.split("/")[1]&&isImageCapability(m));if(named)setCapabilityId(named.id);},[routeHash,route,catalogue]);
  const manifest=catalogue.find(m=>m.id===capabilityId),project=projects.find(p=>p.id===projectId);
  /* The Comfy account behind the cloud key, shown in the user menu. */
  const [account,setAccount]=useState<{connected:boolean;name?:string;email?:string;workspace?:string;credits?:number;canSubmit?:boolean;addCreditsUrl?:string}|null>(null);
  useEffect(()=>{if(!authorized)return;let live=true;void call<NonNullable<typeof account>>(workspacePath(workspace.id,"cloud-account")).then(a=>{if(live)setAccount(a);}).catch(()=>{});return()=>{live=false;};},[authorized,workspace.id,call]);
  const cloudWorker=workers.find(isCloudWorker),runChoices=runTargetOptions(workers,route==="image"||route==="imageedit"||runOn==="chatgpt"),runWorkers=targetWorkers(workers,runOn==="router"?"local":runOn),cloudConsentKey=`comfyfield.cloud-consent:v1:${user.id}:${workspace.id}`;
  useEffect(()=>{if(runOn==="cloud"&&!cloudWorker){setRunOn("local");setAskCloud(false);}},[runOn,cloudWorker]);
  /* The draft is set from the tab that is opening: its own earlier draft, or the picture already chosen on
     the tab being left. `imageDraft` is read once here on purpose, so it is not a dependency. */
  useEffect(()=>{if(route==="image"&&manifest&&isImageCapability(manifest)){setImageDraft(imageDraftForTab(manifest,imageDraftMemory.current,imageDraft));setImageIntentKey("");}},[route,manifest?.id,manifest?.version]);
  useEffect(()=>{
    if(!authorized||route!=="image"||!project)return;let current=true;
    void Promise.all([call<AssetPage>(workspacePath(workspace.id,`assets?projectId=${project.id}`)),call<Run[]>(workspacePath(workspace.id,`runs?projectId=${project.id}`))])
      .then(([assets,runs])=>{if(current){setImageAssets(assets.items.filter(asset=>asset.media_type==="image"));setImageRuns(runs);}})
      .catch(e=>{if(current)setError((e as Error).message);});
    return()=>{current=false;};
  },[authorized,route,project?.id,workspace.id,call,version]);
  const canCreate=workspace.role!=="viewer"&&authorized&&!offline;
  /* A failed request is said in everyday words; the raw text waits behind Details (rule 36). */
  const failure=error?plainProblem(error):null;
  function pickRunOn(value:string){
    if(value==="chatgpt"){const incoming=route==="imageedit"&&location.hash.split("/")[1]?{inputs:{source_image:location.hash.split("/")[1]},prompt:""}:route==="image"?{inputs:imageDraft.inputs??{},prompt:String(imageDraft.controls.prompt??"")}:undefined;setRouterIncoming(incoming&&project?{...incoming,workspaceId:workspace.id,projectId:project.id}:undefined);setRouterImageTab("edit");setRunOn("chatgpt");setAskCloud(false);location.hash="imageedit";return;}
    if(value==="router"){let incoming:{inputs:Record<string,string>;prompt:string}|undefined;const local=cloudDraftRef.current;if(project&&local?.workspaceId===workspace.id&&local.projectId===project.id&&(videoMode==="replace"||(videoMode==="transform"&&changeChoiceFromHash(location.hash)==="person")))incoming=local;else if(route==="image")incoming={inputs:imageDraft.inputs??{},prompt:String(imageDraft.controls.prompt??"")};else if(project&&manifest&&videoMode==="create"){try{const d=JSON.parse(localStorage.getItem(draftKey(user.id,workspace.id,project.id,manifest.id))??"null");if(d?.inputs)incoming={inputs:d.inputs,prompt:String(d.controls?.prompt??"")};}catch{}}setRouterIncoming(incoming&&project?{...incoming,workspaceId:workspace.id,projectId:project.id}:undefined);setRunOn("router");setAskCloud(false);return;}
    if(value!=="cloud"){setRunOn("local");setAskCloud(false);return;}
    if(!cloudWorker){setAskCloud(false);setSettingsSection("workers");setSettings(true);return;}
    let accepted=false;try{accepted=localStorage.getItem(cloudConsentKey)==="yes";}catch{}
    if(accepted){setRunOn("cloud");setAskCloud(false);return;}
    setAskCloud(true);
  }
  function useCloud(){try{localStorage.setItem(cloudConsentKey,"yes");}catch{}setAskCloud(false);setRunOn("cloud");}
  function keepLocal(){setAskCloud(false);setRunOn("local");}
  const audioReady=canCreate&&audioRequirements?.state==="ready";
  const trimReady=workspace.role!=="viewer"&&authorized&&videoEditRequirements?.trim.state==="ready";
  async function createProject(name:string,description:string){setError("");try{const p=await call<Project>(workspacePath(workspace.id,"projects"),"POST",{name,description:description||undefined});setProjects(old=>[p,...old]);setProjectId(p.id);return true;}catch(e){setError((e as Error).message);return false;}}
  const statuses:Record<string,Readiness>=Object.fromEntries(catalogue.map(m=>{
    const readiness=bestWorkerReadiness(m,runWorkers);
    return [m.id,offline?{state:"offline",reasons:["The team server cannot confirm worker readiness."],missing:readiness.missing}:readiness];
  }));
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
      if(original.project_id!==project?.id||original.capability_id!==manifest.id||!original.invocation)
        throw new Error("The original run inputs are not available for this workflow.");
      const recorded=Object.fromEntries(Object.entries(original.invocation.controls)
        .filter(([,value])=>["string","number","boolean"].includes(typeof value))) as ImageDraft["controls"];
      const next={...defaultImageDraft(manifest),inputs:{...original.invocation.inputs},
        controls:{...defaultImageDraft(manifest).controls,...recorded}};
      setImageDraft(next);imageDraftMemory.current[manifest.id]=next;
      await queueImage(manifest,next);
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
  /* Run on Comfy Cloud: the Replace character models the cloud worker can run right now. */
  const replaceModel=(m:Catalogue[number])=>({id:m.id,version:m.version,title:m.title,note:firstSentence(m.description)});
  /* On this computer: SCAIL-2 and the local jutsu route, when each is ready here. */
  const jutsuRoute=routeFor("local-jutsu-replace");
  const localReplace=runOn!=="cloud"&&canCreate?(()=>{const scail=catalogue.find(m=>m.id==="scail2-character-replace"),jutsu=catalogue.find(m=>m.id==="local-jutsu-replace");const models=[...(scail&&routeFor(scail.id)?[replaceModel(scail)]:[]),...(jutsu&&jutsuRoute?[replaceModel(jutsu)]:[])];const workerId=routeFor("scail2-character-replace")?.workerId??jutsuRoute?.workerId;return workerId&&models.length?{workerId,routeId:"local",models}:undefined;})():undefined;
  const cloudReplace=runOn==="cloud"&&cloudWorker&&canCreate?{workerId:cloudWorker.id,routeId:"cloud",models:catalogue.filter(m=>CLOUD_REPLACE_MODELS.includes(m.id)&&m.routes.some(r=>r.id==="cloud")&&workerReadiness(m,cloudWorker).state==="ready").map(m=>({id:m.id,version:m.version,title:m.title,note:firstSentence(m.description)}))}:undefined;
  const replaceRoute=routeFor("scail2-character-replace"),swapMaskRoute=routeFor("sam31-video-mask"),swapEditRoute=routeFor("wan21-vace-masked-edit"),vfxRoute=routeFor("nvidia-vfx-upscale");
  const editRoute=routeFor("qwen-image-21-edit");
  const readyManifests=catalogue.filter(m=>statuses[m.id]?.state==="ready"),readyImages=readyManifests.filter(isImageCapability),shownImages=catalogue.filter(m=>m.coverage.local==="implemented"&&isImageCapability(m)),readyEdit=readyManifests.some(isMaskedEdit),readyMotion=readyManifests.some(m=>m.category==="motion"),readyEnhance=readyManifests.some(m=>m.category==="enhance"),readyEffects=readyManifests.some(m=>capabilitySurface(m)==="video-effect");
  /* The image screen's own tabs: the open workflow decides which one is on, and a tab for a tool that is not
     ready here is never drawn (rule 26). */
  const chatgptUnsupported=runOn==="chatgpt"&&["video","motion","3d","audio","characters","influencer"].includes(route);
  const chatgptPage=runOn==="chatgpt"&&(route==="image"||route==="imageedit");
  const routerPage=runOn==="router"&&["video","motion","image","imageedit","3d","audio","characters","influencer"].includes(route);
  const imageTabItems=runOn==="chatgpt"?[{id:"angles" as const,label:"Angles"},{id:"relight" as const,label:"Relight"}]:runOn==="router"?[{id:"create" as const,label:"Create"},{id:"angles" as const,label:"Angles"},{id:"relight" as const,label:"Relight"}]:imageTabs(shownImages),wantedImageTab=imageTabFor(manifest?.id,route),imageTab=imageTabItems.some(item=>item.id===wantedImageTab)?wantedImageTab:imageTabItems[0]?.id??"create";
  const intentImage=imageTabTarget("create",readyImages),intentVideo=readyManifests.find(m=>isCreateVideoWorkflow(m)&&m.inputs.every(port=>!port.required))??readyManifests.find(isCreateVideoWorkflow),intentMotion=readyManifests.find(m=>m.category==="motion");
  const intentAvailable={image:!!intentImage,video:!!intentVideo,motion:!!intentMotion,edit:readyEdit,trim:trimReady,storyboard:!!intentVideo,audio:audioReady};
  /* Only leave a mode the person asked for once readiness is actually known. On a reload or a deep
     link the catalogue is still empty for a moment, and falling back then dropped `#video/effects`
     and `#video/edit` into Create even when those modes were ready a second later.
     Trim keeps its mode: an unready `#video/trim` names what is missing instead of switching. */
  useEffect(()=>{
    if(!catalogue.length)return;
    // The mask tool is not a screen of its own any more: its address opens editing with one sentence.
    if(route==="video"&&videoMode==="create"&&swapMaskRoute&&swapEditRoute&&isMaskedEdit(catalogue.find(m=>m.id===capabilityId))){setVideoMode("edit");location.hash="video/edit";}
    if(videoMode==="edit"&&!(swapMaskRoute&&swapEditRoute)){const masked=readyManifests.find(isMaskedEdit);setVideoMode("create");if(masked){setCapabilityId(masked.id);location.hash=videoWorkflowHash(masked.id);}}
    if((videoMode==="effects"&&!readyEffects))setVideoMode("create");
  },[videoMode,readyEdit,readyEffects,catalogue.length,capabilityId,route]);
  const choose=(id:string)=>{const selected=catalogue.find(m=>m.id===id);if(!selected||statuses[id]?.state!=="ready")return;setCapabilityId(id);if(isImageCapability(selected))setImageDraft(defaultImageDraft(selected));setVideoMode(videoWorkflowMode(selected));location.hash=nativeWorkflowHash(selected);};
  /** A workflow picked on the video screen takes its place in the address, so reload and back keep it. */
  const chooseWorkflow=(id:string)=>{setCapabilityId(id);if(route==="video"&&(videoMode==="create"||videoMode==="workflow"))location.hash=videoWorkflowHash(id);};
  /** An All tools card opens its screen: a task that names one workflow selects it, every other card starts from that screen's default. */
  const openStartTask=(task:StartTask)=>{const target=task.workflow?routeFor(task.workflow):undefined;setCapabilityId(target?.manifest.id??"");location.hash=task.href.slice(1);};
  async function useImageInVideo(assetId:string){
    if(!project||!canCreate)return;
    const compatible=readyManifests.filter(m=>isCreateVideoWorkflow(m)&&m.inputs.some(port=>port.type==="image"&&port.id==="start_image")),target=compatible.find(m=>m.id==="wan22-ti2v-5b")??compatible[0];
    if(!target){setError("A ready image-to-video workflow is required to use this image.");return;}
    setError("");
    try{
      const asset=await call<Asset>(workspacePath(workspace.id,`assets/${assetId}`));
      if(asset.project_id!==project.id||asset.media_type!=="image"||!asset.content_type.startsWith("image/"))throw new Error("Choose a generated image in this project.");
      const key=draftKey(user.id,workspace.id,project.id,target.id);
      if(sessionStorage.getItem(`${key}:intent`)||localStorage.getItem(`${key}:intent`))throw new Error("Resolve the pending video submission before changing its source image.");
      const draft=defaultDraft(target),saved=JSON.parse(localStorage.getItem(key)??"null");
      if(saved?.controls&&typeof saved.controls==="object")for(const control of target.controls)if(["string","number","boolean"].includes(typeof saved.controls[control.id]))draft.controls[control.id]=saved.controls[control.id];
      if(saved?.inputs&&typeof saved.inputs==="object")for(const port of target.inputs)if(typeof saved.inputs[port.id]==="string")draft.inputs[port.id]=saved.inputs[port.id];
      draft.inputs.start_image=assetId;
      if(!String(draft.controls.prompt??"").trim())draft.controls.prompt="Animate this shot with subtle natural movement.";
      localStorage.setItem(key,JSON.stringify(draft));setCapabilityId(target.id);setVideoMode("create");location.hash="video";
    }catch(e){setError((e as Error).message);}
  }
  async function useAudioInLipSync(assetId:string){
    if(!project||!canCreate)return;
    const target=readyManifests.find(m=>!!m.voiceContract);
    if(!target){setError("A ready local lip-sync workflow is required.");return;}
    setError("");
    try{
      const asset=await call<Asset>(workspacePath(workspace.id,`assets/${assetId}`));
      if(asset.project_id!==project.id||asset.media_type!=="audio")throw new Error("Choose an audio take in this project.");
      if(!["audio/wav","audio/x-wav"].includes(asset.content_type))throw new Error("Use a saved microphone take or mono PCM16 WAV for local lip sync.");
      const key=draftKey(user.id,workspace.id,project.id,target.id);
      if(sessionStorage.getItem(`${key}:intent`)||localStorage.getItem(`${key}:intent`))throw new Error("Resolve the pending lip-sync submission before changing its audio.");
      const draft=defaultDraft(target);draft.inputs[target.voiceContract!.audioInput]=assetId;
      localStorage.setItem(key,JSON.stringify(draft));setCapabilityId(target.id);setVideoMode("create");location.hash="video";
    }catch(e){setError((e as Error).message);}
  }
  function prefillComposer(target:Catalogue[number],text:string){
    if(!project||!target.controls.some(c=>c.id==="prompt"))return;
    const draft=defaultDraft(target);draft.controls.prompt=text;
    try{localStorage.setItem(draftKey(user.id,workspace.id,project.id,target.id),JSON.stringify(draft));}catch{}
  }
  function runIntent(target:Exclude<IntentTarget,"unknown">){
    const text=intentText.trim();if(!text)return;
    if(target==="image"&&intentImage){const draft=defaultImageDraft(intentImage);draft.controls.prompt=text;setCapabilityId(intentImage.id);setImageDraft(draft);setImageIntentKey("");location.hash="image";void queueImage(intentImage,draft);return;}
    if(target==="video"&&intentVideo){prefillComposer(intentVideo,text);setCapabilityId(intentVideo.id);setVideoMode("create");location.hash="video";return;}
    if(target==="motion"&&intentMotion){prefillComposer(intentMotion,text);setCapabilityId(intentMotion.id);location.hash="motion";return;}
    if(target==="edit"){const masked=readyManifests.find(isMaskedEdit);if(masked)prefillComposer(masked,text);setVideoMode("edit");location.hash="video/edit";return;}
    if(target==="trim"&&trimReady){setVideoMode("trim");location.hash="video";return;}
    if(target==="storyboard"&&intentVideo){setVideoMode("storyboard");location.hash="video";return;}
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
      ...(readyEdit?[{id:"edit",icon:<Sparkles size={18}/>,title:"Edit Video",text:"Edit a validated region with a local mask workflow",onSelect:()=>{setVideoMode("edit");location.hash="video/edit";}}]:[]),
      {id:"storyboard",icon:<Clapperboard size={18}/>,title:"Storyboard",text:"Plan shots and assemble them into one video",onSelect:()=>{setVideoMode("storyboard");location.hash="video";}},
      {id:"transform",icon:<Sparkles size={18}/>,title:"Transform Video",text:"Transfer motion, swap objects or restyle a video",onSelect:()=>{setVideoMode("transform");location.hash="video";}},
      ...(readyMotion?[{id:"motion",icon:<Move size={18}/>,title:"Motion Control",text:"Transfer motion from a video to a character",onSelect:()=>{location.hash="motion";}}]:[]),
      ...(readyEnhance?[{id:"enhance",icon:<Maximize2 size={18}/>,title:"Video Upscale",text:"Enhance video quality",onSelect:()=>{setVideoMode("create");setCapabilityId(readyManifests.find(m=>m.category==="enhance")?.id??"");location.hash="video";}}]:[]),
    ],
    models:readyManifests.filter(isVideoWorkflow).map(m=>({id:m.id,icon:<Sparkles size={18}/>,title:m.title.split(" (")[0],text:capabilityPurpose(m),onSelect:()=>choose(m.id)})),
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
  const listedTools={replace:implemented.some(m=>m.id==="scail2-character-replace"),motion:implemented.some(m=>m.category==="motion"),effects:implemented.some(m=>capabilitySurface(m)==="video-effect"),edit:implemented.some(isMaskedEdit),vfx:implemented.some(m=>m.id==="nvidia-vfx-upscale"),video:implemented.some(m=>isCreateVideoWorkflow(m)),image:shownImages.length>0,audio:implemented.some(m=>m.category==="audio"||/chatterbox|lip-?sync|speech/.test(m.id))};
  const section=sectionOf(route);
  /* Areas without a tool panel of their own open with a hero band: what the area is for. */
  const pageHeroKind:HeroKind|undefined=route==="library"?"library":route==="characters"?"cast":route==="influencer"?"scenes":route==="audio"?"voice":route==="video"&&videoMode==="storyboard"?"film":route==="video"&&videoMode==="trim"?"trim":undefined;
  useDensity();
  /* One answer for a hash that names no screen or a screen this computer cannot run yet. */
  const fallback=routeState({
    section:route,mode:videoMode,hash:routeHash,workflowIds:catalogue.filter(m=>route==="video"?isVideoWorkflow(m):route==="image"?isImageCapability(m):true).map(m=>m.id),canCreate,
    catalogueKnown:offline||!authorized||catalogue.length>0,
    video:catalogue.some(m=>m.coverage.local==="implemented"&&(isCreateVideoWorkflow(m)||capabilitySurface(m)==="video-enhance")),motion:catalogue.some(m=>m.coverage.local==="implemented"&&m.category==="motion"),image:catalogue.some(m=>m.coverage.local==="implemented"&&isImageCapability(m)),
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
    <div className="cf-production"><Panel>{body}</Panel><TeamRuns workspace={workspace} project={target} call={call} canEdit={canCreate} authorized={authorized} version={version} user={user} hero={latest=><ToolHero latest={latest} kind={tool==="person"?"replace":tool} workflowId={tool==="person"?replaceRoute?.manifest.id:swapEditRoute?.manifest.id}/>} titles={catalogueTitles(catalogue)} capabilityId={tool==="person"?[replaceRoute?.manifest.id??""]:[swapEditRoute?.manifest.id??"","wan21-vace-masked-edit-reference"]}/></div>;
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
    const draft=defaultDraft(target),saved=JSON.parse(localStorage.getItem(key)??"null");
    if(saved?.controls&&typeof saved.controls==="object")for(const control of target.controls)if(["string","number","boolean"].includes(typeof saved.controls[control.id]))draft.controls[control.id]=saved.controls[control.id];
    Object.assign(draft.inputs,inputs);Object.assign(draft.controls,controls);
    localStorage.setItem(key,JSON.stringify(draft));window.dispatchEvent(new CustomEvent("cf-draft-preset",{detail:key}));
  }
  /* Where a picture or clip can go from the full view. A tool that is not ready here is never offered (rule 26). */
  const mediaTools=(media:{src:string;name:string;mediaType:"image"|"video"}):MediaToolSet|undefined=>{
    if(!canCreate||!project)return undefined;
    const image=media.mediaType==="image";
    const animateTarget=image?(readyManifests.find(m=>m.id==="wan22-ti2v-5b"&&isCreateVideoWorkflow(m))??readyManifests.find(m=>isCreateVideoWorkflow(m)&&m.inputs.some(port=>port.type==="image"&&port.id==="start_image"))):undefined;
    const motionTarget=selectTransformManifest(catalogue,statuses,"motion"),restyleTarget=selectTransformManifest(catalogue,statuses,"restyle");
    const motionReady=!!motionTarget&&statuses[motionTarget.id]?.state==="ready"&&motionTarget.category==="motion",restyleReady=!!restyleTarget&&statuses[restyleTarget.id]?.state==="ready"&&capabilitySurface(restyleTarget)==="video-effect";
    const send=(target:Catalogue[number],port:string,hash:string,mode?:typeof videoMode)=>async()=>{
      const id=await mediaAssetId(media);presetTool(target,{[port]:id});setCapabilityId(target.id);if(mode)setVideoMode(mode);location.hash=hash;
    };
    const animate=animateTarget?send(animateTarget,"start_image",videoWorkflowHash(animateTarget.id),"create"):undefined;
    const toMotion=motionReady?send(motionTarget!,image?"start_image":"motion_video","video/transform/motion","transform"):undefined;
    const openIn:NonNullable<MediaToolSet["openIn"]>=[
      ...(animate&&animateTarget?[{id:"animate",label:"Make a video",note:"Image to video",icon:<Video size={16}/>,run:animate}]:[]),
      ...(toMotion?[{id:"motion",label:"Motion transfer",note:image?"As the character picture":"As the driving video",icon:<Footprints size={16}/>,run:toMotion}]:[]),
      ...(!image&&restyleReady?[{id:"restyle",label:"Restyle",note:"As the source clip",icon:<Palette size={16}/>,run:send(restyleTarget!,"source_video","video/transform/restyle","transform")}]:[]),
    ];
    const upscaleTarget=!image&&vfxRoute?vfxRoute.manifest:undefined;
    const known=(()=>{try{const url=new URL(media.src,location.href);return url.origin===location.origin&&url.pathname.startsWith(`/api/v1${workspacePath(workspace.id,"assets/")}`)?url.pathname.slice(`/api/v1${workspacePath(workspace.id,"assets/")}`.length).match(/^([^/]+)\/content$/)?.[1]:undefined;}catch{return undefined;}})();
    return {
      ...(animate?{animate}:{}),
      ...(openIn.length?{openIn}:{}),
      ...(image&&toMotion?{reference:[{id:"motion",label:"Motion transfer",note:"As the character picture",icon:<Footprints size={16}/>,run:toMotion}]}:{}),
      ...(upscaleTarget?{upscale:send(upscaleTarget,"source_video","video/create","create")}:{}),
      ...(known?{downloadHref:assetUrl(workspace.id,known,true)}:{}),
    };
  };
  /* Where a finished run can be made again: the tool it was made in, with its inputs and settings (never its seed, so the copy is a new take).
     Pictures and the multi-step tools keep their own state, so they offer nothing (rule 26). */
  const recreatePlace=(m:Catalogue[number])=>{
    if(m.category==="motion")return {hash:"video/transform/motion",mode:"transform" as const};
    if(isMaskedEdit(m))return swapMaskRoute&&swapEditRoute?{hash:"video/edit",mode:"edit" as const}:undefined;
    const surface=capabilitySurface(m);
    if(surface==="video-effect")return {hash:"video/transform/restyle",mode:"transform" as const};
    if(isCreateVideoWorkflow(m)||surface==="video-enhance")return {hash:videoWorkflowHash(m.id),mode:"create" as const};
    return undefined;
  };
  const recreate:RecreateRun=run=>{
    if(!canCreate||!project||run.state!=="succeeded"||!run.invocation)return undefined;
    const target=catalogue.find(m=>m.id===run.capability_id);
    if(!target||statuses[target.id]?.state!=="ready")return undefined;
    const place=recreatePlace(target),invocation=run.invocation;
    if(!place)return undefined;
    return ()=>{
      const inputs=Object.fromEntries(Object.entries(invocation.inputs).filter(([port,id])=>typeof id==="string"&&id&&target.inputs.some(item=>item.id===port)));
      const controls=Object.fromEntries(Object.entries(invocation.controls).filter(([id,value])=>id!=="seed"&&["string","number","boolean"].includes(typeof value)&&target.controls.some(control=>control.id===id))) as Record<string,string|number|boolean>;
      try{presetTool(target,inputs,controls);}catch(cause){setError((cause as Error).message);return;}
      setCapabilityId(target.id);setVideoMode(place.mode);location.hash=place.hash;
    };
  };
  /* A screen whose content fills the work area declares it on its page, and the WorkspaceBar reads only that
     declaration (rule 35), so no DS rule keeps a list of screen names. Reading pages stay capped. */
  const fillPage=route==="workflow"||route==="imageedit"||(route==="image"&&!!manifest)
    ||(route==="video"&&(videoMode==="storyboard"||videoMode==="transform"||videoMode==="replace"||videoMode==="edit"))
    ||((route==="video"||route==="motion")&&!!manifest);
  return <div className="cf-team">
    <ScrollFades/><Reveal/>
    <TopBar brand={<img className="ds-topbar__brand-image" src={logo} alt="CreativeField"/>} current={topCurrent} items={[{label:"Video",href:"#video",menu:videoMenu},{label:"Image",href:"#image",menu:imageMenu},{label:"FotoField",href:"#imageedit",featured:true},{label:"3D",href:"#3d",menu:canCreate?threeDMenu:undefined},{label:"All tools",href:"#make"},{label:"Models",href:"#catalogue",onSelect:openModels},{label:"Nodes",href:"#nodes"}]} secondary={[{label:"Library",href:"#library"},{label:"Projects",href:"#projects",suffix:project?.name,dropdown:{items:projects.map(p=>({id:p.id,title:p.name,onSelect:()=>setProjectId(p.id)})),selectedId:projectId,footer:{id:"add",icon:<Plus size={14}/>,title:"Add project",onSelect:()=>setCreatingProject(true)}}}]} end={<>{route!=="openjutsu"&&<ExpandToggle icon={<Sparkles size={16}/>} label="Free input" on={intentMode} onChange={setIntentMode}/>} {canCreate&&runChoices&&<TeamChoice label="Run on" variant="pill" display={route==="openjutsu"?"Comfy Router":runOn==="chatgpt"?"ChatGPT":runOn==="router"?"Comfy Router":runOn==="cloud"?"Comfy Cloud":"This computer"} value={route==="openjutsu"?"router":runOn} onChange={pickRunOn} options={route==="openjutsu"?runChoices.filter(c=>c.value==="router"):runChoices}/>} {workspaces.length>1&&<div className="cf-workspace-picker"><TeamChoice label="Workspace" variant="pill" display={workspace.name} value={workspace.id} onChange={onWorkspace} options={workspaces.map(w=>({value:w.id,label:w.name,note:w.role}))}/></div>}<JobQueueIndicator version={version} workspace={workspace} call={call} authorized={authorized} titles={catalogueTitles(catalogue)} onOpenRun={run=>{setProjectId(run.project_id);location.hash=`library/runs/${run.id}`;}}/><UserMenu initials={(account?.name??user.email).slice(0,1).toUpperCase()} name={account?.name??user.email} meta={<Meta parts={account?.connected?[account.email,account.workspace]:workspaceFacts(audienceOf(user),workspace)}/>} extra={account?.connected&&typeof account.credits==="number"?<><Meta parts={[`${account.credits.toLocaleString()} credits`,account.canSubmit===false?"plan cannot run jobs from ComfyField":undefined]}/>{account.addCreditsUrl&&<LinkButton variant="ghost" href={account.addCreditsUrl} target="_blank" rel="noreferrer">Add credits</LinkButton>}</>:undefined} items={[{id:"settings",label:settingsLabel(audienceOf(user)),icon:<Settings size={14}/>,onSelect:()=>setSettings(true)},...(user.localSingleUser?[]:[{id:"out",label:"Sign out",icon:<LogOut size={14}/>,onSelect:()=>void onSignOut()}])]}/></>}/>
    <WorkflowInfoProvider><MediaEditProvider canAnnotate={!!editRoute} onEdit={canCreate?editPreview:undefined} saveCrop={canCreate?savePreviewCrop:undefined} tools={canCreate?mediaTools:undefined}><RecreateProvider value={recreate}><AmbientReelProvider src={reelForSection(section)}>
    <div className="cf-team__body">
    <div className="cf-team__main ds-canvas">
    {section!=="catalogue"&&section!=="nodes"&&section!=="3d"&&<WorkspaceBar density={route!=="imageedit"}
      tabs={section==="video"&&project?{label:"Video workspace",value:route==="openjutsu"?"openjutsu":(videoMode==="replace"?"transform":videoMode==="edit"?"create":videoMode) as string,onChange:(id:string)=>{if(id==="openjutsu"){location.hash="openjutsu";return;}setVideoMode(id as typeof videoMode);if(id!=="workflow")location.hash=id==="create"?"video":`video/${id}`;},items:[...(videoMode==="workflow"?[{id:"workflow" as const,label:"Workflow"}]:[]),{id:"storyboard" as const,label:"Storyboard"},{id:"create" as const,label:"Create Video"},{id:"transform" as const,label:"Change Video"},{id:"openjutsu" as const,label:"OpenJutsu"},...(readyEffects?[{id:"effects" as const,label:"Effects"}]:[]),...(trimReady?[{id:"trim" as const,label:"Trim"}]:[])]}
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
    {route==="openjutsu"&&project?<section className="cf-team__content"><CloudRenderStudio key={`${workspace.id}:${project.id}:openjutsu`} feature="openjutsu" workspace={workspace} project={project} user={user} call={call} version={version} canEdit={canCreate} onQueued={refresh} onSettings={()=>setSettings(true)} onLocal={()=>{setRunOn("local");location.hash="video";}}/></section>:chatgptUnsupported&&project?<section className="cf-team__content"><Page narrow><EmptyState title="ChatGPT edits images here" text="This feature uses a different renderer. Choose this computer to continue here, or open the image editor for ChatGPT." action={<Button variant="secondary" onClick={()=>setRunOn("local")}>Use this computer</Button>}/></Page></section>:chatgptPage&&project?<section className="cf-team__content"><ChatgptImageStudio key={`${user.id}:${workspace.id}:${project.id}:${location.hash}:${routerImageTab}`} feature={route==="imageedit"?"image-edit":routerImageTab==="angles"?"image-angles":routerImageTab==="relight"?"image-relight":"image-edit"} incoming={route==="imageedit"&&/^[a-f0-9-]{36}$/i.test(location.hash.split("/")[1]??"")?{inputs:{source_image:location.hash.split("/")[1]},prompt:""}:routerIncoming?.workspaceId===workspace.id&&routerIncoming.projectId===project.id?routerIncoming:undefined} workspace={workspace} project={project} user={user} call={call} version={version} canEdit={canCreate} onQueued={refresh}/></section>:routerPage&&project?<section className="cf-team__content"><CloudRenderStudio key={`${workspace.id}:${project.id}:${route}:${videoMode}:${routerImageTab}:${changeChoiceFromHash(location.hash)}`} incoming={routerIncoming?.workspaceId===workspace.id&&routerIncoming.projectId===project.id?routerIncoming:undefined} feature={cloudFeature(route,videoMode,routerImageTab,changeChoiceFromHash(location.hash))} workspace={workspace} project={project} user={user} call={call} version={version} canEdit={canCreate} onQueued={refresh} onSettings={()=>setSettings(true)} onLocal={()=>setRunOn("local")} onFeature={f=>{location.hash=`video/transform/${f==="replace-character"?"person":f==="motion-transfer"?"motion":f==="object-swap"?"swap":"restyle"}`;}}/></section>:route==="3d"?<section className="cf-team__content cf-nodes-page"><ThreeDStudio textPanel={project?<TextTo3DPanel key={`${project.id}:text`} catalogue={catalogue} user={user} workspace={workspace} project={project} workers={runWorkers} call={call} canEdit={canCreate} authorized={authorized} onQueued={refresh}/>:undefined} meshPanel={project?<ModelToolsPanel key={`${project.id}:mesh:${routeHash.split("/")[2]??""}`} mode="mesh" workspace={workspace} project={project} call={call} canEdit={canCreate} onChanged={refresh}/>:undefined} texturePanel={project?<ModelToolsPanel key={`${project.id}:texture:${routeHash.split("/")[2]??""}`} mode="texture" workspace={workspace} project={project} call={call} canEdit={canCreate} onChanged={refresh}/>:undefined} viewerPanel={project?<ModelToolsPanel key={`${project.id}:viewer:${routeHash.split("/")[2]??""}`} mode="viewer" workspace={workspace} project={project} call={call} canEdit={canCreate} onChanged={refresh}/>:undefined} imagePanel={project?<ImageTo3DPanel key={routeHash} initialWorkflow={routeHash.split("/")[2]==="auto"?undefined:routeHash.split("/")[2]} initialAssetId={routeHash.split("/")[3]} user={user} workspace={workspace} project={project} catalogue={catalogue} workers={runWorkers} call={call} canEdit={canCreate} authorized={authorized} onQueued={refresh} onOpenModels={openModels}/>:undefined} workspace={workspace} workers={runWorkers} canEdit={canCreate} status={<ProblemBar/>}/></section>:route==="nodes"?<section className="cf-team__content cf-nodes-page"><ComfyNodes workspace={workspace} workers={runWorkers} canEdit={canCreate} serverOffline={offline} onChanged={refresh} onWorkerSettings={()=>{setSettingsSection("workers");setSettings(true);}}/></section>:route==="catalogue"?<CapabilityCatalogue manifests={catalogue.filter(m=>!m.mediaContract?.additionalMaskInputs?.length)} statuses={statuses} checking={checking} recheckLabel={workspace.role==="admin"?"Probe workers and recheck":"Refresh status"} onRecheck={()=>void recheck()} onChoose={choose} library={controls=><ComfyLibraryPanel workspace={workspace} workers={workers} call={call} controls={controls} onWorkerSettings={()=>setSettings(true)}/>} onLibrary={()=>{const enhancer=readyManifests.find(m=>m.category==="enhance");if(!enhancer)return;setVideoMode("create");setCapabilityId(enhancer.id);location.hash="video";}}/>:<div className="cf-team__body">
      {(route==="projects"||!project)&&<section className="cf-team__content"><Page narrow><TeamProjects projects={projects} projectId={projectId} canCreate={canCreate} onCreate={createProject} onOpen={id=>{setProjectId(id);location.hash="library";}}/></Page></section>}
      {!routerPage&&project&&route!=="projects"&&route!=="openjutsu"&&fallback.kind!=="screen"&&<section className="cf-team__content"><Page narrow><EmptyState stage title={fallbackTitle} text={fallbackText} action={fallbackNext?<Button variant="secondary" onClick={()=>{location.hash=fallbackNext.href;}}>{fallbackNext.label}</Button>:undefined}/></Page></section>}
      {!routerPage&&project&&route!=="projects"&&route!=="openjutsu"&&fallback.kind==="screen"&&<section className={`cf-team__content ds-page${route==="imageedit"?" ds-page--workspace":fillPage?" ds-page--fill":""}`}>
        {pageHeroKind&&<div className="cf-team__pagehero"><ToolHero kind={pageHeroKind}/></div>}
        {route==="workflow"&&catalogue.find(m=>m.id===routeHash.split("/")[1])?<TeamComposer key={`${project.id}:${routeHash}`} manifest={catalogue.find(m=>m.id===routeHash.split("/")[1])!} catalogue={catalogue} onCapability={choose} user={user} workspace={workspace} project={project} workers={runWorkers} call={call} canQueue={canCreate} authorized={authorized} onQueued={refresh} onWorkerSettings={()=>{setSettingsSection("workers");setSettings(true);}} onModels={openModels} onRunLocal={()=>setRunOn("local")}/>:route==="make"?<StartScreen ready={listedTools} onOpen={openStartTask}/>:route==="imageedit"?<ImageEditor userId={user.id} freeInput={intentMode} key={`${user.id}:${workspace.id}:${project.id}:${location.hash.split("/")[1]??""}`} openAssetId={location.hash.split("/")[1]} workspace={workspace} project={project} call={call} canEdit={canCreate} authorized={authorized} inpaint={inpaintRoute} edit={editRoute} segment={routeFor("sam3-image-segment")} precision={routeFor("flux2-klein-preserve-edit")} onOpenModels={openModels}/>:(route==="characters"||route==="influencer")?<CharacterWorkspace mode={route==="influencer"?"scenes":characterMode} user={user} workspace={workspace} project={project} catalogue={catalogue} workers={runWorkers} call={call} authorized={authorized} canEdit={canCreate} onCount={setCharacterCount} onOpenStoryboard={()=>{setVideoMode("storyboard");location.hash="video";}} onOpenCharacters={()=>setCharacterMode("characters")}/>:route==="audio"&&audioReady&&audioRequirements?<AudioStudio userId={user.id} key={`${workspace.id}:${project.id}`} workspace={workspace} project={project} call={call} requirements={audioRequirements} onChanged={refresh} onLipSync={canCreate&&readyManifests.some(m=>!!m.voiceContract)?assetId=>void useAudioInLipSync(assetId):undefined}/>:route==="video"&&videoMode==="edit"&&swapMaskRoute&&swapEditRoute?changeScreen(project,"edit",<SwapThingPanel promptOnly key={`edit:${project.id}:${location.hash.split("/")[2]??""}`} initialVideo={location.hash.split("/")[2]} workspace={workspace} project={project} workerId={swapEditRoute.workerId} call={call} canEdit={canCreate} onChanged={refresh}/>):route==="video"&&videoMode==="trim"&&trimReady&&videoEditRequirements?<VideoEditStudio canEdit={canCreate} maxGenerationFrames={routeFor("video-edit")?.manifest.controls.find(c=>c.id==="generation_frames")?.max??13} userId={user.id} extensionWorkerId={canCreate?routeFor("video-edit")?.workerId:undefined} initialAssetId={location.hash.split("/")[2]} key={`${workspace.id}:${project.id}`} workspace={workspace} project={project} call={call} requirements={videoEditRequirements} onChanged={refresh}/>:route==="video"&&(videoMode==="transform"||videoMode==="replace")?<TransformVideo manifests={catalogue} statuses={statuses} user={user} workspace={workspace} project={project} workers={runWorkers} call={call} canQueue={canCreate} authorized={authorized} onCapability={setCapabilityId} onQueued={refresh} onModels={openModels} initial={videoMode==="replace"?"person":changeChoiceFromHash(routeHash)} swapThing={swapMaskRoute&&swapEditRoute?top=>changeScreen(project,"swap",<SwapThingPanel key={project.id} top={top} workspace={workspace} project={project} workerId={swapEditRoute.workerId} call={call} canEdit={canCreate} onChanged={refresh}/>):undefined} replace={replaceRoute||jutsuRoute||cloudReplace?.models.length?top=>changeScreen(project,"person",<ReferenceReplacePanel onCloudDraft={captureCloudDraft} key={project.id} top={top} workspace={workspace} project={project} workerId={replaceRoute?.workerId??jutsuRoute?.workerId??cloudReplace!.workerId} cloud={cloudReplace?.models.length?cloudReplace:localReplace} call={call} canEdit={canCreate} onChanged={refresh}/>):undefined}/>:route==="image"&&manifest&&isImageCapability(manifest)?<ImageStudio modelOptions={shownImages.map(m=>({value:m.id,label:m.title.split(" (")[0],note:capabilityPurpose(m)}))} onModel={id=>{const selected=catalogue.find(m=>m.id===id);if(!selected)return;setCapabilityId(id);setImageDraft(defaultImageDraft(selected));location.hash=nativeWorkflowHash(selected);}} subjectRelightAvailable={canCreate&&!!routeFor("flux2-klein-preserve-edit")} key={`${project.id}:${manifest.id}`} workspace={workspace} project={project} manifest={manifest} readiness={canCreate?(statuses[manifest.id]??{state:"offline",reasons:["Image readiness has not been checked."],missing:[]}):{state:"unsupported",reasons:[workspace.role==="viewer"?"Viewer access is read-only.":"Sign in to generate images."],missing:[]}} workerName={imageWorker?.name} onUseInVideo={canCreate?assetId=>void useImageInVideo(assetId):undefined} batchContext={{userId:user.id,workerId:imageWorker?.id??"",call,onChanged:refresh}} assets={imageAssets} runs={imageRuns} draft={imageDraft} busy={imageBusy} onDraftChange={draft=>{setImageDraft(draft);imageDraftMemory.current[manifest.id]=draft;setImageIntentKey("");}} onGenerate={draft=>void generateImage(draft)} onCancel={canCreate?cancelImageRun:undefined} canCancelRun={run=>workspace.role==="admin"||run.created_by===user.id} onRetake={canCreate&&!imageIntentKey&&!imageBusy?retakeImage:undefined}/>:route==="video"&&videoMode==="storyboard"?<TeamStoryboard key={project.id} user={user} workspace={workspace} project={project} catalogue={catalogue} workers={runWorkers} call={call} authorized={authorized} canEdit={canCreate}/>: (route==="video"||route==="motion")&&manifest?<TeamComposer key={`${project.id}:${manifest.id}`} manifest={manifest} catalogue={catalogue} onCapability={chooseWorkflow} user={user} workspace={workspace} project={project} workers={runWorkers} call={call} canQueue={canCreate} authorized={authorized} onQueued={refresh} onWorkerSettings={()=>{setSettingsSection("workers");setSettings(true);}} onModels={openModels} onRunLocal={()=>setRunOn("local")}/>:route==="library"?<TeamLibrary titles={catalogueTitles(catalogue)} key={project.id} workspace={workspace} project={project} call={call} canEdit={canCreate} authorized={authorized} version={version} user={user} videoEditReady={trimReady} onEditVideo={asset=>{setVideoMode("trim");location.hash=`video/trim/${asset.id}`;}}/>:null}
      </section>}
    </div>}
    {intentMode&&route!=="openjutsu"&&route!=="imageedit"&&section!=="catalogue"&&section!=="nodes"&&section!=="3d"&&project&&<IntentDock value={intentText} onChange={setIntentText} onSubmit={runIntent} available={intentAvailable} busy={imageBusy}/>}
    </div>
    </div>
    </AmbientReelProvider></RecreateProvider></MediaEditProvider></WorkflowInfoProvider>
    <Dialog wide className="cf-models-dialog" open={modelsOpen&&authorized} title="Models" onClose={closeModels}>
      <CapabilityCatalogue embedded manifests={catalogue.filter(m=>!m.mediaContract?.additionalMaskInputs?.length)} statuses={statuses} checking={checking} recheckLabel={workspace.role==="admin"?"Probe workers and recheck":"Refresh status"} onRecheck={()=>void recheck()} onChoose={id=>{setModelsOpen(false);choose(id);}} library={controls=><ComfyLibraryPanel workspace={workspace} workers={workers} call={call} controls={controls} onWorkerSettings={()=>setSettings(true)}/>} onLibrary={()=>{const enhancer=readyManifests.find(m=>m.category==="enhance");if(!enhancer)return;setModelsOpen(false);setVideoMode("create");setCapabilityId(enhancer.id);location.hash="video";}}/>
    </Dialog>
    <ProjectCreateDialog open={creatingProject} onClose={()=>setCreatingProject(false)} onCreate={createProject}/>
    <TeamSettings initialSection={settingsSection} open={settings&&authorized} onClose={closeSettings} workspace={workspace} user={user} workers={workers} call={call} onChanged={refresh} onSignOut={onSignOut}/>
  </div>;
}


