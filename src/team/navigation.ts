import {isSelectedImageModel} from "../capabilities/image-model-selection";
import {cloudFeature,routerModelsFor,type CloudFeature} from "../capabilities/router-models";
import {capabilitySurface,isCreateVideoWorkflow,isImageWorkflow,isVideoWorkflow} from "../capabilities/surfaces";
import {FLASH_EFFECT_CLIPS_ID,isEffectClips,isFlashVideoCreate,isSupersededLocalVideoWorkflow,routeTask,taskPacks} from "../capabilities/tasks";
import type {CapabilityManifestV2} from "../capabilities/types";
import {VIDEO_REFRAME_ID} from "../capabilities/video-reframe";
import {isMaskedEdit} from "./masked-state";
import {resolveOpenJutsu} from "./openjutsu-navigation";
import {rootViewFromHash,routeState,sectionFromHash,type RouteState} from "./route-state";
import {changeChoiceFromHash,startTasks} from "./start-tasks";
import {imageTo3DWorkflows,NATIVE_THREE_D_TOOLS,threeDTool,type ThreeDTool} from "./three-d/tools";
import {videoModeFromHash} from "./video-edit/state";
import {isMotionTransfer,type ChangeChoice} from "./transform-video-state";
import {nativeWorkflowHash,videoWorkflowMode,type VideoWorkspaceMode} from "./workflow-navigation";

export type RunTarget="local"|"cloud"|"router"|"chatgpt";
export type ImageTab="create"|"angles"|"relight"|"edit"|"upscale"|"cutout";
export type ImageEditEntry="annotate"|"modify"|"relight";
type Readiness="checking"|"ready"|"unavailable";
type RouterAvailability=(feature:CloudFeature)=>boolean;
export type VideoMenuId="openjutsu"|"create"|"trim"|"edit"|"talk"|"storyboard"|"transform"|"motion"|"enhance";

const videoEntry=(id:VideoMenuId,title:string,text:string,href:string)=>({id,title,text,href});

type ImageMenuAction=
  | {kind:"open";href:string}
  | {kind:"create";workflowId:string}
  | {kind:"router";tab:"angles"|"relight"|"upscale"|"cutout"}
  | {kind:"workflow";workflowId:string};
type ImageMenuEntry={id:string;title:string;text:string;action:ImageMenuAction};
const routerImageTools=[
  ["angles","camera angles","Turn the subject to a new angle"],
  ["relight","relight","Change the light and the mood"],
  ["upscale","sharper and bigger","Upscale a picture"],
  ["cutout","cut out","Remove the background"],
] as const;

export type NavigationInput={
  hash:string;
  audience:"local"|"guest"|"signed-in-guest";
  hasProject:boolean;
  canCreate:boolean;
  workspaceAdmin?:boolean;
  localSingleUser?:boolean;
  access?:"ready"|"offline"|"reconnect";
  runTarget:RunTarget;
  cloud:{worker:boolean;canSubmit?:boolean;consent?:boolean};
  catalogue:CapabilityManifestV2[]|null;
  ready:ReadonlySet<string>;
  localReady?:ReadonlySet<string>;
  routerFeatures?:ReadonlySet<CloudFeature>;
  requirements:{trim:Readiness;audio:Readiness;editArea:boolean};
  selection?:{videoMode?:VideoWorkspaceMode;workflowId?:string;imageTab?:ImageTab};
  models?:{open:boolean;returnHash?:string};
  openJutsuExperiment?:string;
  filmStudioInstalled?:boolean;
};

type RunChoice={target:RunTarget;action:"select"|"sign-in"|"setup"|"consent"|"plan-required"};
type NamedScreen="make"|"projects"|"catalogue"|"audio";
export type LibraryScreen={kind:"library";tab:"assets"}|{kind:"library";tab:"runs";linkedRunId?:string};
type NodeEntry={kind:"feature"|"run";id:string};
export type NodesScreen={kind:"nodes";target:"local";entry?:NodeEntry}|{kind:"nodes";target:"cloud"};
export type BlockDelivery={kind:"router"}|{kind:"previs"|"depth";manifest:CapabilityManifestV2};
export type BlockScreen={kind:"block";delivery?:BlockDelivery}|{kind:"film-studio";delivery?:BlockDelivery};
type OpenJutsuSelection=ReturnType<typeof resolveOpenJutsu>["screen"];
export type ResolvedScreen=
  | Exclude<RouteState,{kind:"screen"}>
  | {kind:NamedScreen|"showcase"|"node-design"}
  | {kind:"chatgpt";feature:"image-edit"|"image-angles"|"image-relight";assetId?:string}
  | {kind:"chatgpt-unavailable"}
  | {kind:"fotofield"|"imageedit";assetId?:string;entry?:ImageEditEntry}
  | {kind:"image";tab:ImageTab;workflowId?:string}
  | {kind:"characters";tab:"characters"|"scenes";imageEditor?:CapabilityManifestV2}
  | {kind:"remix"|"marketing";manifest:CapabilityManifestV2;choices:CapabilityManifestV2[]}
  | {kind:"motion";manifest:CapabilityManifestV2;workflowIds:string[]}
  | BlockScreen
  | LibraryScreen
  | NodesScreen
  | {kind:"video";mode:VideoWorkspaceMode;workflowId?:string;change?:ReturnType<typeof changeChoiceFromHash>}
  | {kind:"storyboard";boardId?:string;target:"local"|"cloud"|"router"}
  | {kind:"keyframes";target:"local"|"router"}
  | {kind:"edit-area";assetId?:string;ready:boolean}
  | {kind:"transform";choice:ChangeChoice;reframe?:CapabilityManifestV2}
  | {kind:"make-real";manifest:CapabilityManifestV2}
  | {kind:"effects";manifest:CapabilityManifestV2}
  | {kind:"trim";assetId?:string}
  | {kind:"workflow";manifest:CapabilityManifestV2}
  | {kind:"router";feature:CloudFeature;assetId?:string}
  | {kind:"3d";tool:"image";manifest:CapabilityManifestV2;choices:CapabilityManifestV2[];assetId?:string}
  | {kind:"3d";tool:Exclude<ThreeDTool,"image">|"overview";assetId?:string}
  | {kind:"openjutsu";selection:OpenJutsuSelection};

const imported=(manifest:CapabilityManifestV2)=>manifest.id.startsWith("imported-");
const selectableImage=(manifest:CapabilityManifestV2)=>isImageWorkflow(manifest)&&(isSelectedImageModel(manifest.id)||imported(manifest));
export const remixImageModel=(manifest:CapabilityManifestV2)=>["fibo2-edit","qwen-image-21-edit"].includes(manifest.id)&&selectableImage(manifest);
export const adImageModel=(manifest:CapabilityManifestV2)=>remixImageModel(manifest)||manifest.id==="flux2-klein-edit"&&selectableImage(manifest);
const selectableVideo=(manifest:CapabilityManifestV2)=>capabilitySurface(manifest)==="video-enhance"||
  isCreateVideoWorkflow(manifest)&&(isFlashVideoCreate(manifest.id)||imported(manifest));
const supportsCloud=(manifest:CapabilityManifestV2)=>manifest.routes.some(route=>route.execution==="comfy_cloud"&&route.implementation==="implemented");
const catalogueReady=(input:NavigationInput)=>input.catalogue!==null;
const missing=(title:string,text:string,href="#make",label="All tools"):ResolvedScreen=>({kind:"missing",title,text,next:{href,label}});

export function imageTabFor(manifestId:string|undefined,route:string):ImageTab{
  if(route==="imageedit")return "edit";
  if(!manifestId)return "create";
  if(taskPacks("image.relight").includes(manifestId))return "relight";
  return taskPacks("image.angles").includes(manifestId)?"angles":"create";
}

export function imageTabTarget<T extends {id:string}>(tab:ImageTab,models:T[]):T|undefined{
  if(tab==="edit")return undefined;
  return routeTask(tab==="angles"?"image.angles":tab==="relight"?"image.relight":"image.create",models)?.pack;
}

const IMAGE_TAB_LABELS:Record<ImageTab,string>={create:"Create",angles:"Angles",relight:"Relight",edit:"Edit",upscale:"Upscale",cutout:"Cut out"};
const NATIVE_IMAGE_TABS=["create","angles","relight"] as const;

function nativeImageTabs<T extends {id:string}>(models:T[]){
  return NATIVE_IMAGE_TABS.flatMap(id=>{
    const manifest=imageTabTarget(id,models);
    return manifest?[{id,label:IMAGE_TAB_LABELS[id],manifest}]:[];
  });
}

export function imageTabs(models:Array<{id:string}>):Array<{id:ImageTab;label:string}>{
  return nativeImageTabs(models).map(({id,label})=>({id,label}));
}

type ImageTabAction={kind:"provider";href:string}|{kind:"workflow";manifest:CapabilityManifestV2;href:string};
type ImageWorkspaceTab={id:ImageTab;label:string;action?:ImageTabAction};

function resolveImageWorkspaceTabs(target:RunTarget,tab:ImageTab,models:CapabilityManifestV2[],router:RouterAvailability){
  const remoteTabs:ImageTab[]|undefined=target==="chatgpt"?["angles","relight"]:target==="router"?
    [...NATIVE_IMAGE_TABS,...(router("image-upscale")?["upscale" as const]:[]),...(router("image-cutout")?["cutout" as const]:[])]:undefined;
  const items:ImageWorkspaceTab[]=remoteTabs
    ?remoteTabs.map(id=>({id,label:IMAGE_TAB_LABELS[id],action:{kind:"provider",href:"#image"}}))
    :nativeImageTabs(models).map(({id,label,manifest})=>({id,label,
      action:id===tab?undefined:{kind:"workflow",manifest,href:nativeWorkflowHash(manifest)},
    }));
  const active=items.some(item=>item.id===tab)||tab==="edit"?tab:items[0]?.id;
  return {active,items};
}

function selectReadyWorkflow(choices:CapabilityManifestV2[],ready:ReadonlySet<string>,current?:string,named?:string):CapabilityManifestV2|undefined{
  const requested=choices.find(model=>model.id===named);
  const previous=choices.find(model=>model.id===current);
  const available=choices.find(model=>ready.has(model.id));
  return requested??(previous&&(!available||ready.has(previous.id))?previous:available??choices[0]);
}

function resolveTarget(input:NavigationInput,section:string,openJutsu?:ReturnType<typeof resolveOpenJutsu>){
  const hosted=input.audience!=="local",signedIn=input.audience==="signed-in-guest";
  const cloudEligible=signedIn&&input.cloud.worker&&input.cloud.canSubmit!==false;
  let selected:RunTarget=input.runTarget;
  if(hosted&&(selected!=="router"&&(!cloudEligible||selected!=="cloud")))selected=cloudEligible?"cloud":"router";
  if(!hosted&&selected==="cloud"&&!input.cloud.worker)selected="local";
  const choices:RunChoice[]=[];
  if(openJutsu){
    selected=openJutsu.screen.kind==="router"?"router":"local";
    if(input.canCreate&&!hosted){
      if(openJutsu.localAvailable)choices.push({target:"local",action:"select"});
      choices.push({target:"router",action:"select"});
    }
  }else if(input.canCreate&&hosted){
    choices.push({target:"router",action:signedIn?"select":"sign-in"});
    choices.push({target:"cloud",action:!signedIn?"sign-in":input.cloud.canSubmit===false?"plan-required":input.cloud.worker?"select":"setup"});
  }else if(input.canCreate){
    choices.push({target:"local",action:"select"});
    choices.push({target:"cloud",action:!input.cloud.worker?"setup":input.cloud.consent?"select":"consent"});
    choices.push({target:"router",action:"select"});
    if(section==="image"||section==="imageedit"||selected==="chatgpt")choices.push({target:"chatgpt",action:"select"});
  }
  return {selected,choices};
}

function modelAvailability(input:NavigationInput){
  const catalogue=input.catalogue??[];
  const implemented=catalogue.filter(manifest=>manifest.coverage.local==="implemented");
  const ready=catalogue.filter(manifest=>input.ready.has(manifest.id));
  const image=implemented.filter(selectableImage);
  const localReady=input.localReady??input.ready;
  const previs=input.audience==="local"?routeTask("video.previs",catalogue.filter(manifest=>localReady.has(manifest.id)))?.pack:undefined;
  const defaultEffects=implemented.find(manifest=>isEffectClips(manifest.id)&&!isSupersededLocalVideoWorkflow(manifest.id));
  const imageStudios={remix:implemented.filter(remixImageModel),marketing:implemented.filter(adImageModel)};
  const motionChoices=implemented.filter(isMotionTransfer);
  return {catalogue,implemented,ready,image,previs,defaultEffects,imageStudios,motionChoices,threeDImages:imageTo3DWorkflows(catalogue),
    effects:!!defaultEffects&&input.ready.has(defaultEffects.id)};
}
type Models=ReturnType<typeof modelAvailability>;

function resolveImageMenu(hosted:boolean,models:Models,router:RouterAvailability):ImageMenuEntry[]{
  const entries:ImageMenuEntry[]=[];
  const create=imageTabTarget("create",models.image);
  const createAction:ImageMenuAction|undefined=hosted?{kind:"open",href:"#image"}:create&&{kind:"create",workflowId:create.id};
  if(createAction)entries.push({id:"create-image",title:"Create Image",
    text:hosted?"Make a picture with FLUX 2 Pro on your Comfy credits":"Generate a durable image with local ComfyUI",
    action:createAction});
  entries.push({id:"fotofield",title:"FotoField",text:"Our free photo editor: layers, masks and AI edits",
    action:{kind:"open",href:hosted?"#imageedit/layers":"#imageedit"}});
  if(hosted){
    for(const [tab,title,text] of routerImageTools){
      const feature=`image-${tab}` as const;
      const model=router(feature)?routerModelsFor(feature)[0]:undefined;
      if(model)entries.push({id:`router-${tab}`,title:`${model.title} ${title}`,text,action:{kind:"router",tab}});
    }
    return entries;
  }
  const angles=taskPacks("image.angles")[0],relight=taskPacks("image.relight")[0];
  for(const {id} of models.image){
    if(id!==angles&&id!==relight)continue;
    entries.push({id,title:id===angles?"Camera angles":"Relight",
      text:id===angles?"Explore another view of your image":"Change light and atmosphere",action:{kind:"workflow",workflowId:id}});
  }
  return entries;
}

function resolveMenu(input:NavigationInput,models:Models,router:RouterAvailability){
  const hosted=input.audience!=="local",signedIn=input.audience==="signed-in-guest";
  const cloudJobs=signedIn&&input.cloud.canSubmit===true;
  const sections=["video","image","3d",...(!hosted?["audio"]:[]),"make",...(!hosted||cloudJobs?["catalogue","nodes"]:[]),"library","projects"];
  const footer=!hosted?"catalogue":signedIn&&input.cloud.worker?"import":null;
  const videoWorkflows=models.ready.filter(manifest=>isVideoWorkflow(manifest)&&
    (!hosted||cloudJobs&&input.cloud.worker&&supportsCloud(manifest))&&!/^vace-.*restyle/.test(manifest.id)&&
    (capabilitySurface(manifest)!=="video-create"||isFlashVideoCreate(manifest.id)||imported(manifest)));
  const enhance=videoWorkflows.find(manifest=>manifest.category==="enhance");
  const video=[
    ...(!hosted||router("openjutsu")?[videoEntry("openjutsu","OpenJutsu · H3 API","Experimental character/reference video generation through Comfy Router","#openjutsu")]:[]),
    videoEntry("create","Create Video","Generate video from text or images","#video/create"),
    ...(input.requirements.trim==="ready"?[videoEntry("trim","Trim Video","Cut an exact decoded frame range locally","#video/trim")]:[]),
    ...(input.requirements.editArea?[videoEntry("edit","Edit Area","Edit a selected area of your video","#video/edit")]:[]),
    ...(hosted&&router("talk")?[videoEntry("talk","Make it talk","Lip sync a video to a voice","#audio")]:[]),
    ...(!hosted||router("video-create")?[videoEntry("storyboard","Storyboard","Plan shots and assemble them into one video","#video/storyboard")]:[]),
    videoEntry("transform","Transform Video","Transfer motion, swap objects or restyle a video","#video/transform"),
    ...(videoWorkflows.some(isMotionTransfer)?[videoEntry("motion","Motion Control","Transfer motion from a video to a character","#motion")]:[]),
    ...(enhance?[videoEntry("enhance","Video Upscale","Enhance video quality",nativeWorkflowHash(enhance))]:[]),
  ];
  const image=resolveImageMenu(hosted,models,router);
  const hostedImageTo3D=router("image-to-3d")||cloudJobs&&input.cloud.worker&&models.threeDImages.some(supportsCloud);
  const threeDTools=NATIVE_THREE_D_TOOLS.filter(tool=>!hosted||tool.id==="viewer"||tool.id==="image"&&hostedImageTo3D)
    .map(tool=>({...tool,href:`#3d/${tool.id}`}));
  const threeDWorkflows=hosted||!input.canCreate?[]:models.implemented.filter(manifest=>manifest.category==="3d"&&imported(manifest));
  const threeD={canOpenMenu:input.canCreate,tools:threeDTools,
    workflows:threeDWorkflows.map(manifest=>({manifest,href:`#workflow/${manifest.id}`})),
    tabs:[{id:"overview",label:"Overview",href:"#3d"},...threeDTools.map(({id,title,href})=>({id,label:id==="workflows"?"Workflows":title,href}))]};
  const hasSurface=(surface:ReturnType<typeof capabilitySurface>)=>models.implemented.some(manifest=>capabilitySurface(manifest)===surface);
  const canMakeVideo=models.implemented.some(isCreateVideoWorkflow);
  const upscale=models.implemented.find(manifest=>manifest.id==="nvidia-vfx-upscale");
  const localReady=input.localReady??input.ready;
  // Installed tools can still open their setup when a local worker is offline.
  const tools=startTasks(hosted?{
    block:router("restyle"),h3effects:router("effects"),audio:router("talk"),
    replace:router("replace-character")||router("openjutsu"),motion:router("motion-transfer"),edit:router("object-swap"),
    restyle:router("restyle"),video:router("video-create"),image:router("image-create"),
    vfx:router("video-upscale")||cloudJobs&&upscale?.routes.some(route=>route.execution==="comfy_cloud"),
  }:{
    block:hasSurface("video-effect"),h3effects:input.ready.has(FLASH_EFFECT_CLIPS_ID),
    audio:models.implemented.some(manifest=>manifest.category==="audio"||/chatterbox|lip-?sync|speech/.test(manifest.id)),
    replace:models.implemented.some(manifest=>manifest.id==="scail2-character-replace"),
    motion:models.motionChoices.length>0,edit:models.implemented.some(isMaskedEdit),
    restyle:hasSurface("video-effect"),video:canMakeVideo,film:canMakeVideo,image:models.image.length>0,vfx:!!upscale,
    remiximage:models.imageStudios.remix.some(manifest=>localReady.has(manifest.id)),
    adimage:models.imageStudios.marketing.some(manifest=>localReady.has(manifest.id)),
  }).filter(task=>input.filmStudioInstalled||task.href!=="#block/film")
    .map(task=>hosted&&!cloudJobs&&task.id==="sharpen"
      ? {...task,href:"#video/transform/upscale",workflow:undefined}
      : task);
  const account=input.audience==="guest"?["sign-in"]:["guide","settings",...(signedIn?["sign-out-comfy"]:input.localSingleUser?[]:["sign-out"])];
  const settingsTabs=hosted?["account","workers"]:["account","chatgpt",...(input.workspaceAdmin?["members","workers","ai-text","providers"]:[])];
  return {sections,video,image,threeD,tools,account,settingsTabs,
    videoWorkflows:videoWorkflows.map(manifest=>manifest.id),imageWorkflows:hosted?[]:models.image.map(manifest=>manifest.id),
    videoFooter:footer,imageFooter:footer};
}

export type ThreeDNavigation=ReturnType<typeof resolveMenu>["threeD"];

/** The stored graph link is scoped and validated by the editor server. */
export const runFromHash=(hash:string)=>/^#nodes\/run\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(hash)?.[1]??null;

function nodeEntry(hash:string):NodeEntry|undefined{
  const feature=/^#nodes\/feature\/([a-z0-9][a-z0-9-]{0,79})$/.exec(hash)?.[1];
  if(feature)return {kind:"feature",id:feature};
  const run=runFromHash(hash);
  if(run)return {kind:"run",id:run};
}

/** Resolves workspace navigation from an immutable snapshot. Components own drafts and events. */
export function resolveScreen(input:NavigationInput){
  const requestedHash=input.hash;
  const redirect=requestedHash==="#video/transform/edit"?"#video/edit":undefined;
  const hash=redirect??requestedHash;
  const root=rootViewFromHash(hash),section=sectionFromHash(hash);
  const [,part,detail,assetId]=hash.replace(/^#/,"").split("/");
  const hosted=input.audience!=="local";
  const router:RouterAvailability=feature=>input.routerFeatures?.has(feature)??routerModelsFor(feature).length>0;
  const models=modelAvailability(input),menu=resolveMenu(input,models,router);
  const catalogueAddress=section==="catalogue";
  const previousHash=input.models?.returnHash;
  const returnHash=previousHash&&sectionFromHash(previousHash)!=="catalogue"?previousHash:"#make";
  const overlay={
    open:root==="app"&&input.access!=="reconnect"&&(catalogueAddress||!!input.models?.open),
    returnHash,...(catalogueAddress?{closeHash:returnHash}:{}),
  };
  const catalogueManifests=overlay.open?models.catalogue.filter(manifest=>
    !manifest.mediaContract?.additionalMaskInputs?.length&&(hosted||!isSupersededLocalVideoWorkflow(manifest.id))):[];
  const openJutsu=section==="openjutsu"?resolveOpenJutsu({hash,catalogue:models.catalogue,
    localReady:input.localReady??input.ready,
    ready:models.ready,hosted,experiment:input.openJutsuExperiment}):undefined;
  const modeFromHash=videoModeFromHash(hash);
  const namedVideo=section==="video"&&part&&!modeFromHash?models.catalogue.find(manifest=>manifest.id===part&&isVideoWorkflow(manifest)):undefined;
  const explicitWorkflow=section==="workflow"?models.catalogue.find(manifest=>manifest.id===part):undefined;
  const selectedVideo=namedVideo??models.catalogue.find(manifest=>manifest.id===input.selection?.workflowId&&isVideoWorkflow(manifest));
  const rememberedMode=input.selection?.videoMode;
  let videoMode=modeFromHash??(namedVideo?videoWorkflowMode(namedVideo):rememberedMode==="workflow"&&!selectedVideo?"create":rememberedMode??"create");
  if(hosted&&(videoMode==="storyboard"&&!router("video-create")||videoMode==="keyframes"&&!router("keyframes")))videoMode="create";
  const createVideo=section==="video"&&videoMode==="create";
  const trim=section==="video"&&videoMode==="trim";
  const effects=section==="video"&&videoMode==="effects";
  const effectWorkflow=effects?(namedVideo&&isEffectClips(namedVideo.id)?namedVideo:models.defaultEffects):undefined;
  const effectAvailable=!!effectWorkflow&&(!hosted||supportsCloud(effectWorkflow));
  const editArea=section==="video"&&videoMode==="edit";
  const transform=section==="video"&&(videoMode==="transform"||videoMode==="replace");
  const change=videoMode==="replace"?undefined:changeChoiceFromHash(namedVideo&&transform?nativeWorkflowHash(namedVideo):hash);
  const reframeRequested=transform&&change==="reframe";
  const pinnedPrevis=videoMode==="workflow"&&selectedVideo&&taskPacks("video.previs").includes(selectedVideo.id)?selectedVideo:undefined;
  const makeReal=section==="video"?pinnedPrevis:undefined;
  const studio=section==="remix"||section==="marketing"?section:undefined;
  const studioChoices=studio?models.imageStudios[studio]:[];
  const studioManifest=studio?selectReadyWorkflow(studioChoices,input.localReady??input.ready,input.selection?.workflowId,part):undefined;
  const motion=section==="motion";
  const motionChoices=hosted?models.motionChoices.filter(supportsCloud):models.motionChoices;
  const motionManifest=motion?selectReadyWorkflow(motionChoices,input.ready,input.selection?.workflowId,part):undefined;
  const localReady=input.canCreate?input.localReady??input.ready:input.ready;
  const reframe=transform&&!hosted?models.catalogue.find(manifest=>manifest.id===VIDEO_REFRAME_ID&&localReady.has(manifest.id)):undefined;
  const targets=resolveTarget(input,section,openJutsu);
  const threeD=section==="3d"?threeDTool(part):null;
  const namedThreeD=threeD==="image"&&detail!=="auto"?detail:undefined;
  const routerThreeD=threeD==="image"&&!namedThreeD&&router("image-to-3d");
  const cloudThreeD=models.threeDImages.filter(supportsCloud);
  const canCloudThreeD=cloudThreeD.some(manifest=>!namedThreeD||manifest.id===namedThreeD);
  const threeDTarget:RunTarget=targets.selected==="cloud"&&canCloudThreeD?"cloud":
    (hosted||targets.selected==="router")&&routerThreeD?"router":hosted?targets.selected:"local";
  const nodes=section==="nodes";
  const projects=!catalogueAddress&&!nodes&&(section==="projects"||!input.hasProject);
  const library=section==="library",libraryTab=part==="runs"?"runs":"assets";
  const characters=section==="characters"||section==="influencer";
  const characterTab=section==="influencer"||part==="scenes"?"scenes":"characters";
  const block=section==="block",filmStudio=block&&part==="film";
  const blockRouter=block&&router("restyle");
  const blockTarget:RunTarget=blockRouter&&(hosted||targets.selected==="router")?"router":"local";
  const audio=section==="audio",routerAudio=audio&&router("talk");
  const audioTarget:RunTarget=hosted||(targets.selected==="router"&&routerAudio)?"router":"local";
  const runTargets=projects||catalogueAddress||nodes||library||characters||filmStudio?{selected:targets.selected,choices:[]}
    :block?{selected:blockTarget,choices:targets.choices.filter(choice=>choice.target==="router"?blockRouter:choice.target==="local")}
    :audio?{selected:audioTarget,choices:targets.choices.filter(choice=>
    choice.target==="local"||choice.target==="router"&&routerAudio)}
    :threeD==="image"?{selected:threeDTarget,choices:targets.choices.filter(choice=>
    choice.target==="local"||choice.target==="router"&&routerThreeD||choice.target==="cloud"&&canCloudThreeD)}
    :(reframeRequested||makeReal||studio)&&!hosted
    ? {selected:"local" as const,choices:targets.choices.filter(choice=>choice.target==="local")}
    : targets;
  const createWorkflow=createVideo
    ? selectedVideo&&selectableVideo(selectedVideo)?selectedVideo:routeTask("video.create",models.implemented)?.pack
    : undefined;
  const images=section==="image"?models.catalogue.filter(selectableImage):[];
  const namedImage=images.find(manifest=>manifest.id===part);
  const imageWorkflow=namedImage??images.find(manifest=>manifest.id===input.selection?.workflowId)??imageTabTarget("create",models.image);
  const imageTab:ImageTab=section==="imageedit"?"edit":runTargets.selected==="router"||runTargets.selected==="chatgpt"?input.selection?.imageTab??"create":
    imageTabFor(imageWorkflow?.id,section);
  const editingImage=section==="imageedit";
  const imageWorkspace=input.hasProject&&root==="app"&&(section==="image"||editingImage)
    ?resolveImageWorkspaceTabs(runTargets.selected,imageTab,models.image,router):null;
  const layers=editingImage&&part==="layers";
  const editAssetId=editingImage?(layers?detail:part):undefined;
  const remoteEditAssetId=/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(editAssetId??"")?editAssetId:undefined;
  const entry=layers?assetId:detail;
  const editEntry:{entry?:ImageEditEntry}=entry==="annotate"||entry==="modify"||entry==="relight"?{entry}:{};
  const previsSelected=!!pinnedPrevis&&pinnedPrevis.id===models.previs?.id;

  function tabs(){
    if(!input.hasProject||root!=="app")return null;
    if(section==="video"||section==="openjutsu")return {
      active:section==="openjutsu"?"openjutsu":previsSelected?"makereal":videoMode==="replace"?"transform":videoMode,
      items:[...(videoMode==="workflow"&&!previsSelected?["workflow"]:[]),...(!hosted||router("video-create")?["storyboard"]:[]),
        ...(!hosted||router("keyframes")?["keyframes"]:[]),"create",...(input.requirements.editArea?["edit"]:[]),"transform",
        ...(!hosted||router("openjutsu")?["openjutsu"]:[]),...(models.previs?["makereal"]:[]),
        ...(models.effects||hosted&&router("effects")?["effects"]:[]),...(input.requirements.trim==="ready"?["trim"]:[])]};
    if(imageWorkspace)return {active:imageWorkspace.active,items:imageWorkspace.items.map(item=>item.id)};
    if(library)return {active:libraryTab,items:["assets","runs"]};
    if(characters)return {active:characterTab,items:["characters","scenes"]};
    if(section==="3d")return {active:threeD&&menu.threeD.tools.some(tool=>tool.id===threeD)?threeD:"overview",items:menu.threeD.tabs.map(tab=>tab.id)};
    return null;
  }

  function screen():ResolvedScreen{
    if(root!=="app")return {kind:root};
    if(catalogueAddress)return {kind:"catalogue"};
    if(nodes)return hosted?{kind:"nodes",target:"cloud"}:{kind:"nodes",target:"local",entry:nodeEntry(hash)};
    if(projects)return {kind:"projects"};
    if(library)return libraryTab==="runs"?{kind:"library",tab:"runs",linkedRunId:detail}:{kind:"library",tab:"assets"};
    if(characters){
      const editors=hosted||!input.canCreate?[]:models.imageStudios.remix.filter(manifest=>localReady.has(manifest.id));
      const imageEditor=selectReadyWorkflow(editors,localReady,taskPacks("image.edit")[0]);
      return {kind:"characters",tab:characterTab,imageEditor};
    }
    if(filmStudio)return input.filmStudioInstalled?
      // The studio hands a shot to the same Grey-block-to-video delivery the generator uses,
      // so the two screens never pick different Make-it-real targets.
      {kind:"film-studio",delivery:!hosted&&input.canCreate&&models.previs?{kind:"previs",manifest:models.previs}:undefined}:
      missing("Film Studio is unavailable here","You can draw a layout and make a shot in Block.","#block","Open Block");
    if(block){
      if(blockTarget==="router")return {kind:"block",delivery:{kind:"router"}};
      if(hosted)return missing("Block is unavailable here","Choose a tool with a Comfy Router model.");
      if(!input.canCreate)return {kind:"block"};
      if(models.previs)return {kind:"block",delivery:{kind:"previs",manifest:models.previs}};
      const depth=models.implemented.find(manifest=>localReady.has(manifest.id)&&manifest.audioPolicies.includes("mute")&&
        ["source_video","depth_video"].every(id=>manifest.inputs.some(port=>port.id===id&&port.type==="video"&&port.required)));
      if(depth)return {kind:"block",delivery:{kind:"depth",manifest:depth}};
      if(!catalogueReady(input))return {kind:"checking"};
      return missing("Block needs a ready video workflow","Check the local previs and depth workflows in Models.","#catalogue","Open Models");
    }
    if(openJutsu)return {kind:"openjutsu",selection:openJutsu.screen};
    if(studio&&hosted)return missing(studio==="remix"?"Remix Studio runs on this computer":"Ad Studio runs on this computer","Open the local app to use its image editing workflows.");
    if(layers||hosted&&remoteEditAssetId)return {kind:"fotofield",assetId:editAssetId,...editEntry};
    const target=runTargets.selected;
    if(audio&&target==="router"&&routerAudio)return {kind:"router",feature:"talk"};
    if(audio&&hosted)return missing("Audio is unavailable here","Choose an available tool from All tools.");
    if(section==="3d"){
      if(part&&!menu.threeD.tools.some(tool=>tool.id===threeD))return missing("This 3D tool is unavailable","Choose a tool from the 3D workspace.","#3d","3D overview");
      if(!input.canCreate)return {kind:"missing",title:"3D tools require creator access",text:"Ask your workspace administrator for creator access to open the 3D workspace."};
      if(target==="chatgpt")return {kind:"chatgpt-unavailable"};
      if(threeD!=="image")return {kind:"3d",tool:threeD??"overview",assetId:detail};
      if(target==="router"&&routerThreeD)return {kind:"router",feature:"image-to-3d",assetId};
      if(!catalogueReady(input))return {kind:"checking"};
      const choices=hosted||target==="cloud"?cloudThreeD:models.threeDImages;
      const selected=namedThreeD?choices.find(manifest=>manifest.id===namedThreeD):
        selectReadyWorkflow(choices,target==="local"?localReady:input.ready);
      if(selected)return {kind:"3d",tool:"image",manifest:selected,choices,assetId};
      if(namedThreeD||hosted)return missing("This 3D workflow is unavailable","Choose an available tool from the 3D workspace.");
      return missing("No image-to-3D workflow loaded","Check Models for available workflows and their requirements.","#catalogue","Open Models");
    }
    const feature=cloudFeature(section,videoMode,imageTab,change);
    const dedicated=section==="video"&&(["storyboard","keyframes","trim","workflow"].includes(videoMode)||change==="reframe");
    const routerScreen=target==="router"&&!dedicated&&(!namedVideo||createVideo||editArea||transform||effects);
    const hasRouter=feature!=="unsupported"&&routerScreen&&router(feature);
    const workflowIds=section==="workflow"?(explicitWorkflow?[explicitWorkflow.id]:[]):section==="image"?images.map(manifest=>manifest.id):models.catalogue.filter(manifest=>section!=="video"||isVideoWorkflow(manifest)).map(manifest=>manifest.id);
    const availability=routeState({section,hash,mode:videoMode,workflowIds,canCreate:input.canCreate,
      catalogueKnown:catalogueReady(input),video:hasRouter||!!createWorkflow,
      effects:hasRouter||effectAvailable,
      motion:hasRouter||!!motionManifest,
      image:hasRouter||!!(studio?studioManifest:imageWorkflow),
      audioKnown:input.requirements.audio!=="checking",audio:input.requirements.audio==="ready",
      trimKnown:input.requirements.trim!=="checking",trim:input.requirements.trim==="ready"});
    const named=section==="workflow"||section==="image"&&!!part||section==="video"&&!!part&&!modeFromHash;
    if(named&&!catalogueReady(input))return {kind:"checking"};
    if((named||section==="video"&&modeFromHash==="transform")&&availability.kind==="missing")return availability;
    if(target==="chatgpt"&&(section==="video"||motion))return {kind:"chatgpt-unavailable"};
    if(trim&&target==="router"&&(!named||namedVideo))return {kind:"router",feature:"unsupported"};
    if(target==="chatgpt"&&(section==="image"||editingImage))return {
      kind:"chatgpt",feature:imageTab==="angles"?"image-angles":imageTab==="relight"?"image-relight":"image-edit",
      assetId:remoteEditAssetId,
    };
    if(hasRouter)return {kind:"router",feature,assetId:remoteEditAssetId};
    if(routerScreen&&feature!=="unsupported"&&!router(feature)&&hosted)return missing("This tool is unavailable here","Choose a tool with a Comfy Router model.");
    if(routerScreen&&(createVideo||editArea||transform||effects||motion||section==="image"||editingImage)&&feature!=="unsupported")return {kind:"router",feature};
    if(motion&&hosted&&catalogueReady(input)&&!motionManifest)return missing("Motion Control uses Comfy Router here","Choose Comfy Router in Run on to transfer motion.");
    if(availability.kind!=="screen")return availability;
    if(section==="video"&&videoMode==="workflow"&&target==="router"&&!hosted&&!makeReal)return {kind:"router",feature:"unsupported"};
    if(hosted&&named){
      const manifest=explicitWorkflow??models.catalogue.find(candidate=>candidate.id===part);
      if(target!=="cloud"||!manifest||!supportsCloud(manifest)){
        return missing("This workflow is unavailable here","Choose a workflow that can run on your Comfy account.");
      }
    }
    if(explicitWorkflow)return {kind:"workflow",manifest:explicitWorkflow};
    if(studio&&studioManifest)return {kind:studio,manifest:studioManifest,choices:studioChoices};
    if(motionManifest)return {kind:"motion",manifest:motionManifest,workflowIds:motionChoices.map(manifest=>manifest.id)};
    if(section==="video"){
      if(videoMode==="storyboard")return {kind:"storyboard",boardId:detail,target:hosted?"router":target==="cloud"?"cloud":"local"};
      if(videoMode==="keyframes")return {kind:"keyframes",target:target==="local"?"local":"router"};
      if(trim)return {kind:"trim",assetId:detail};
      if(editArea)return {kind:"edit-area",assetId:detail,ready:input.requirements.editArea};
      if(makeReal)return {kind:"make-real",manifest:makeReal};
      if(effectAvailable)return {kind:"effects",manifest:effectWorkflow};
      if(transform){
        if(reframeRequested&&!reframe)return hosted
          ? missing("Reframe runs on this computer","Choose a Transform tool available through Comfy Router.")
          : missing("Reframe is not ready here","Check the local HyperFlow Reframe workflow in Models.","#catalogue","Open Models");
        if(change==="upscale"||change==="cutout")return missing("This tool uses Comfy Router","Choose Comfy Router in Run on to open this tool.");
        return {kind:"transform",choice:change&&change!=="person"?change:"motion",reframe};
      }
      const workflow=createVideo?createWorkflow:selectedVideo;
      return {kind:"video",mode:videoMode,workflowId:workflow?.id,change};
    }
    if(section==="image")return {kind:"image",tab:imageTab,workflowId:imageWorkflow?.id};
    if(editingImage)return {kind:"imageedit",assetId:editAssetId,...editEntry};
    return {kind:section as NamedScreen};
  }

  const makeRealEntry=models.previs?{manifest:models.previs,hash:nativeWorkflowHash(models.previs)}:undefined;
  return {requestedHash,redirect,section,screen:screen(),tabs:tabs(),menu,runTargets,overlay,catalogueManifests,makeRealEntry,imageWorkflow,
    imageTabs:section==="image"&&imageWorkspace?.active?{...imageWorkspace,active:imageWorkspace.active}:null,
    access:input.access??"ready"};
}
