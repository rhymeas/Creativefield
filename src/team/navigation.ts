import {isSelectedImageModel} from "../capabilities/image-model-selection";
import {cloudFeature,routerModelsFor,type CloudFeature} from "../capabilities/router-models";
import {capabilitySurface,isCreateVideoWorkflow,isImageWorkflow,isVideoWorkflow} from "../capabilities/surfaces";
import {isEffectClips,isFlashVideoCreate,isSupersededLocalVideoWorkflow,routeTask,taskPacks} from "../capabilities/tasks";
import type {CapabilityManifestV2} from "../capabilities/types";
import {VIDEO_REFRAME_ID} from "../capabilities/video-reframe";
import {resolveOpenJutsu} from "./openjutsu-navigation";
import {rootViewFromHash,routeState,sectionFromHash,type RouteState} from "./route-state";
import {changeChoiceFromHash,startTasks} from "./start-tasks";
import {NATIVE_THREE_D_TOOLS,threeDTool,type ThreeDTool} from "./three-d/tools";
import {videoModeFromHash} from "./video-edit/state";
import type {ChangeChoice} from "./transform-video-state";
import {nativeWorkflowHash,videoWorkflowMode,type VideoWorkspaceMode} from "./workflow-navigation";

export type RunTarget="local"|"cloud"|"router"|"chatgpt";
export type ImageTab="create"|"angles"|"relight"|"edit"|"upscale"|"cutout";
export type ImageEditEntry="annotate"|"modify"|"relight";
type Readiness="checking"|"ready"|"unavailable";
type RouterAvailability=(feature:CloudFeature)=>boolean;

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
  studioReadiness?:{marketing:boolean;replace:boolean;videoUpscale:boolean;cloudUpscale:boolean};
  selection?:{videoMode?:VideoWorkspaceMode;workflowId?:string;imageTab?:ImageTab;characterTab?:"characters"|"scenes"};
  models?:{open:boolean;returnHash?:string};
  openJutsuExperiment?:string;
};

type RunChoice={target:RunTarget;action:"select"|"sign-in"|"setup"|"consent"|"plan-required"};
type NamedScreen="make"|"projects"|"library"|"catalogue"|"nodes"|"block"|"audio"|"motion"|"characters"|"influencer"|"marketing";
type OpenJutsuSelection=ReturnType<typeof resolveOpenJutsu>["screen"];
export type ResolvedScreen=
  | Exclude<RouteState,{kind:"screen"}>
  | {kind:NamedScreen|"showcase"|"node-design"}
  | {kind:"chatgpt";feature:"image-edit"|"image-angles"|"image-relight";assetId?:string}
  | {kind:"fotofield"|"imageedit";assetId?:string;entry?:ImageEditEntry}
  | {kind:"image";tab:ImageTab;workflowId?:string}
  | {kind:"remix";manifest:CapabilityManifestV2;choices:CapabilityManifestV2[]}
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
  | {kind:"3d";tool:ThreeDTool|"overview";workflowId?:string;assetId?:string}
  | {kind:"openjutsu";selection:OpenJutsuSelection};

const imported=(manifest:CapabilityManifestV2)=>manifest.id.startsWith("imported-");
const selectableImage=(manifest:CapabilityManifestV2)=>isImageWorkflow(manifest)&&(isSelectedImageModel(manifest.id)||imported(manifest));
export const remixImageModel=(manifest:CapabilityManifestV2)=>["fibo2-edit","qwen-image-21-edit"].includes(manifest.id)&&selectableImage(manifest);
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

export function selectStudioModel<T extends {id:string}>(choices:T[],ready:ReadonlySet<string>,current?:string,named?:string):T|undefined{
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
  const remix=implemented.filter(remixImageModel);
  return {catalogue,implemented,ready,image,previs,defaultEffects,remix,
    effects:!!defaultEffects&&input.ready.has(defaultEffects.id),
    motion:ready.some(manifest=>capabilitySurface(manifest)==="motion"),
    enhance:ready.some(manifest=>capabilitySurface(manifest)==="video-enhance")};
}
type Models=ReturnType<typeof modelAvailability>;

function resolveMenu(input:NavigationInput,models:Models,router:RouterAvailability){
  const hosted=input.audience!=="local",signedIn=input.audience==="signed-in-guest";
  const cloudJobs=signedIn&&input.cloud.canSubmit===true;
  const sections=["video","image","3d",...(!hosted?["audio"]:[]),"make",...(!hosted||cloudJobs?["catalogue","nodes"]:[]),"library","projects"];
  const footer=!hosted?"catalogue":signedIn&&input.cloud.worker?"import":null;
  const video=[
    ...(!hosted||router("openjutsu")?["openjutsu"]:[]),"create",
    ...(input.requirements.trim==="ready"?["trim"]:[]),...(input.requirements.editArea?["edit"]:[]),
    ...(hosted&&router("talk")?["talk"]:[]),...(!hosted||router("video-create")?["storyboard"]:[]),
    "transform",...(models.motion?["motion"]:[]),...(models.enhance?["enhance"]:[]),
  ];
  const videoWorkflows=models.ready.filter(manifest=>isVideoWorkflow(manifest)&&(!hosted||cloudJobs&&supportsCloud(manifest))&&!/^vace-.*restyle/.test(manifest.id)&&
    (capabilitySurface(manifest)!=="video-create"||isFlashVideoCreate(manifest.id)||imported(manifest)));
  const localImageTabs=(["create","angles","relight"] as const).filter(tab=>imageTabTarget(tab,models.image));
  const image=[...(!hosted&&!localImageTabs.includes("create")?[]:["create"]),"fotofield"];
  if(hosted){
    for(const tab of ["angles","relight","upscale","cutout"] as const)if(router(`image-${tab}`))image.push(tab);
  }else{
    if(routeTask("image.angles",models.image)?.fallback===false)image.push("angles");
    if(localImageTabs.includes("relight"))image.push("relight");
  }
  const threeDTools=NATIVE_THREE_D_TOOLS.filter(tool=>!hosted||tool.id==="viewer"||tool.id==="image"&&router("image-to-3d")).map(tool=>tool.id);
  const threeDWorkflows=hosted||!input.canCreate?[]:models.implemented.filter(manifest=>manifest.category==="3d"&&imported(manifest));
  const hasSurface=(surface:ReturnType<typeof capabilitySurface>)=>models.implemented.some(manifest=>capabilitySurface(manifest)===surface);
  const tools=startTasks(hosted?{
    block:router("restyle"),h3effects:router("effects"),audio:router("talk"),
    replace:router("replace-character")||router("openjutsu"),motion:router("motion-transfer"),edit:router("object-swap"),
    restyle:router("restyle"),video:router("video-create"),image:router("image-create"),
    vfx:router("video-upscale")||cloudJobs&&input.studioReadiness?.cloudUpscale,
  }:{
    block:hasSurface("video-effect"),h3effects:models.effects,audio:hasSurface("audio"),
    replace:input.studioReadiness?.replace,motion:hasSurface("motion"),edit:hasSurface("video-edit"),
    restyle:hasSurface("video-effect"),video:models.implemented.some(isCreateVideoWorkflow),
    film:models.implemented.some(isCreateVideoWorkflow),image:models.image.length>0,vfx:input.studioReadiness?.videoUpscale,
    remiximage:models.remix.some(manifest=>(input.localReady??input.ready).has(manifest.id)),adimage:input.studioReadiness?.marketing,
  });
  const account=input.audience==="guest"?["sign-in"]:["guide","settings",...(signedIn?["sign-out-comfy"]:input.localSingleUser?[]:["sign-out"])];
  const settingsTabs=hosted?["account","workers"]:["account","chatgpt",...(input.workspaceAdmin?["members","workers","ai-text","providers"]:[])];
  return {sections,video,image,threeDTools,localImageTabs,tools,account,settingsTabs,
    videoWorkflows:videoWorkflows.map(manifest=>manifest.id),imageWorkflows:hosted?[]:models.image.map(manifest=>manifest.id),
    threeDWorkflows:threeDWorkflows.map(manifest=>manifest.id),threeD:input.canCreate?threeDTools:[],videoFooter:footer,imageFooter:footer};
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
  const overlay={open:root==="app"&&(section==="catalogue"||!!input.models?.open),returnHash:input.models?.returnHash||"#make"};
  const openJutsu=section==="openjutsu"?resolveOpenJutsu({hash,catalogue:models.catalogue,
    localReady:input.localReady??input.ready,
    ready:models.ready,hosted,experiment:input.openJutsuExperiment}):undefined;
  const modeFromHash=videoModeFromHash(hash);
  const namedVideo=section==="video"&&part&&!modeFromHash?models.catalogue.find(manifest=>manifest.id===part&&isVideoWorkflow(manifest)):undefined;
  const explicitWorkflow=section==="workflow"?models.catalogue.find(manifest=>manifest.id===part):undefined;
  const selectedVideo=namedVideo??models.catalogue.find(manifest=>manifest.id===input.selection?.workflowId&&isVideoWorkflow(manifest));
  let videoMode=modeFromHash??(namedVideo?videoWorkflowMode(namedVideo):input.selection?.videoMode??"create");
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
  const remix=section==="remix";
  const remixManifest=remix?selectStudioModel(models.remix,input.localReady??input.ready,input.selection?.workflowId,part):undefined;
  const localReady=input.canCreate?input.localReady??input.ready:input.ready;
  const reframe=transform&&!hosted?models.catalogue.find(manifest=>manifest.id===VIDEO_REFRAME_ID&&localReady.has(manifest.id)):undefined;
  const targets=resolveTarget(input,section,openJutsu);
  const runTargets=(reframeRequested||makeReal||remix)&&!hosted
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
  const layers=editingImage&&part==="layers";
  const editAssetId=editingImage?(layers?detail:part):undefined;
  const remoteEditAssetId=/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(editAssetId??"")?editAssetId:undefined;
  const entry=layers?assetId:detail;
  const editEntry:{entry?:ImageEditEntry}=entry==="annotate"||entry==="modify"||entry==="relight"?{entry}:{};
  const previsSelected=!!pinnedPrevis&&pinnedPrevis.id===models.previs?.id;
  const threeD=threeDTool(part);

  function tabs(){
    if(!input.hasProject||root!=="app")return null;
    if(section==="video"||section==="openjutsu")return {
      active:section==="openjutsu"?"openjutsu":previsSelected?"makereal":videoMode==="replace"?"transform":videoMode,
      items:[...(videoMode==="workflow"&&!previsSelected?["workflow"]:[]),...(!hosted||router("video-create")?["storyboard"]:[]),
        ...(!hosted||router("keyframes")?["keyframes"]:[]),"create",...(input.requirements.editArea?["edit"]:[]),"transform",
        ...(!hosted||router("openjutsu")?["openjutsu"]:[]),...(models.previs?["makereal"]:[]),
        ...(models.effects||hosted&&router("effects")?["effects"]:[]),...(input.requirements.trim==="ready"?["trim"]:[])]};
    if(section==="image"||section==="imageedit"){
      const items=runTargets.selected==="chatgpt"?["angles","relight"]:runTargets.selected==="router"?
        ["create","angles","relight",...(router("image-upscale")?["upscale"]:[]),...(router("image-cutout")?["cutout"]:[])]:menu.localImageTabs;
      return {active:items.includes(imageTab)||imageTab==="edit"?imageTab:items[0],items};
    }
    if(section==="characters"||section==="influencer")return {active:section==="influencer"?"scenes":input.selection?.characterTab??"characters",items:["characters","scenes"]};
    if(section==="3d")return {active:threeD&&menu.threeDTools.includes(threeD)?threeD:"overview",items:["overview",...menu.threeDTools]};
    return null;
  }

  function screen():ResolvedScreen{
    if(root!=="app")return {kind:root};
    if(!input.hasProject||section==="projects")return {kind:"projects"};
    if(openJutsu)return {kind:"openjutsu",selection:openJutsu.screen};
    if(remix&&hosted)return missing("Remix Studio runs on this computer","Open the local app to use its image editing workflows.");
    if(layers||hosted&&remoteEditAssetId)return {kind:"fotofield",assetId:editAssetId,...editEntry};
    const target=runTargets.selected;
    const feature=cloudFeature(section,videoMode,imageTab,change);
    const dedicated=section==="video"&&(["storyboard","keyframes","trim","workflow"].includes(videoMode)||change==="reframe");
    const routerScreen=target==="router"&&!dedicated&&(!namedVideo||createVideo||editArea||transform||effects)&&(section!=="3d"||part==="image"&&(!detail||detail==="auto"));
    const hasRouter=feature!=="unsupported"&&routerScreen&&router(feature);
    const workflowIds=section==="workflow"?(explicitWorkflow?[explicitWorkflow.id]:[]):section==="image"?images.map(manifest=>manifest.id):models.catalogue.filter(manifest=>section!=="video"||isVideoWorkflow(manifest)).map(manifest=>manifest.id);
    const availability=routeState({section,hash,mode:videoMode,workflowIds,canCreate:input.canCreate,
      catalogueKnown:catalogueReady(input),video:hasRouter||!!createWorkflow,
      effects:hasRouter||effectAvailable,
      motion:hasRouter||models.implemented.some(manifest=>capabilitySurface(manifest)==="motion"),
      image:hasRouter||(section==="marketing"?!!input.studioReadiness?.marketing:remix?!!remixManifest:!!imageWorkflow),
      audioKnown:input.requirements.audio!=="checking",audio:input.requirements.audio==="ready",
      trimKnown:input.requirements.trim!=="checking",trim:input.requirements.trim==="ready"});
    const named=section==="workflow"||section==="image"&&!!part||section==="video"&&!!part&&!modeFromHash||section==="3d"&&part==="image"&&!!detail&&detail!=="auto";
    if(named&&!catalogueReady(input))return {kind:"checking"};
    if(trim&&target==="router"&&(!named||namedVideo))return {kind:"router",feature:"unsupported"};
    if((named||section==="video"&&modeFromHash==="transform")&&availability.kind==="missing")return availability;
    if(section==="3d"&&part&&(!threeD||!menu.threeDTools.includes(threeD)))return missing("This 3D tool is unavailable","Choose a tool from the 3D workspace.","#3d","3D overview");
    if(target==="chatgpt"&&(section==="image"||editingImage))return {
      kind:"chatgpt",feature:imageTab==="angles"?"image-angles":imageTab==="relight"?"image-relight":"image-edit",
      assetId:remoteEditAssetId,
    };
    if(hasRouter)return {kind:"router",feature,assetId:section==="3d"?assetId:remoteEditAssetId};
    if(routerScreen&&feature!=="unsupported"&&!router(feature)&&hosted)return missing("This tool is unavailable here","Choose a tool with a Comfy Router model.");
    if(routerScreen&&(createVideo||editArea||transform||effects||section==="image"||editingImage)&&feature!=="unsupported")return {kind:"router",feature};
    if(availability.kind!=="screen")return availability;
    if(hosted&&named){
      const manifest=explicitWorkflow??models.catalogue.find(candidate=>candidate.id===(section==="3d"?detail:part));
      if(target!=="cloud"||!manifest||!supportsCloud(manifest)){
        return missing("This workflow is unavailable here","Choose a workflow that can run on your Comfy account.");
      }
    }
    if(explicitWorkflow)return {kind:"workflow",manifest:explicitWorkflow};
    if(remixManifest)return {kind:"remix",manifest:remixManifest,choices:models.remix};
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
    if(section==="3d")return {kind:"3d",tool:threeD??"overview",workflowId:threeD==="image"&&detail!=="auto"?detail:undefined,assetId:threeD==="image"?assetId:detail};
    if(section==="image")return {kind:"image",tab:imageTab,workflowId:imageWorkflow?.id};
    if(editingImage)return {kind:"imageedit",assetId:editAssetId,...editEntry};
    return {kind:section as NamedScreen};
  }

  const makeRealEntry=models.previs?{manifest:models.previs,hash:nativeWorkflowHash(models.previs)}:undefined;
  return {requestedHash,redirect,section,screen:screen(),tabs:tabs(),menu,runTargets,overlay,makeRealEntry,pinnedMakeReal:!!makeReal,imageWorkflow,
    access:input.access??"ready"};
}
