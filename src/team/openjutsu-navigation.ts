import {isOpenJutsuAdvanced,OPENJUTSU_ADVANCED_FLASH_ID,OPENJUTSU_ADVANCED_ID} from "../capabilities/openjutsu-advanced";
import {isOpenJutsuSingleSwap,routeTask} from "../capabilities/tasks";
import type {CapabilityManifestV2} from "../capabilities/types";

type Choice = {value:string;label:string;note?:string};
type OpenJutsuScreen =
  | {kind:"composer";manifest:CapabilityManifestV2;subtitle:string;options:Choice[]}
  | {kind:"experimental"}
  | {kind:"router"};

const advancedFlash=(manifest:CapabilityManifestV2)=>manifest.id===OPENJUTSU_ADVANCED_FLASH_ID;

function workflowLabel(manifest:CapabilityManifestV2){
  if(advancedFlash(manifest))return "HyperFlow H3 Flash · 1–4 characters";
  if(manifest.id===OPENJUTSU_ADVANCED_ID)return "MiniMax H3 · Multiple characters";
  return `${manifest.title.split(" (")[1]?.replace(")","")??"MiniMax H3"} · One character`;
}

export function resolveOpenJutsu({hash,catalogue,flash,localReady,ready,hosted,experiment}: {
  hash:string;
  catalogue:CapabilityManifestV2[];
  flash?:CapabilityManifestV2;
  localReady?:ReadonlySet<string>;
  ready:CapabilityManifestV2[];
  hosted:boolean;
  experiment?:string;
}):{screen:OpenJutsuScreen;localAvailable:boolean}{
  const [section,subroute]=hash.replace(/^#/,"").split("/");
  const requested=section==="openjutsu"?subroute:undefined;
  const local=catalogue.filter(manifest=>manifest.coverage.local==="implemented");
  const flashReady=flash??local.find(manifest=>localReady?.has(manifest.id)&&advancedFlash(manifest));
  const pinned=local.find(manifest=>manifest.id===requested);
  const advanced=local.find(manifest=>manifest.id===OPENJUTSU_ADVANCED_ID);
  const single=routeTask("video.swap-person",ready)?.pack??routeTask("video.swap-person",local)?.pack;
  const fallback=flashReady??single??advanced;
  const explicit=pinned&&(isOpenJutsuAdvanced(pinned.id)||isOpenJutsuSingleSwap(pinned.id))?pinned:undefined;
  const manifest=explicit??(requested==="advanced"?flashReady??advanced??single:fallback);
  const localAvailable=!!manifest;
  if(hosted||requested==="cloud")return {screen:{kind:"router"},localAvailable};
  if(requested==="multi")return {screen:{kind:"experimental"},localAvailable};
  if(!manifest)return {screen:{kind:"router"},localAvailable};

  const choices=new Map<string,Choice>();
  for(const option of [flashReady,...(flashReady?[]:[advanced,single]),manifest]){
    if(option)choices.set(option.id,{value:option.id,label:workflowLabel(option)});
  }
  if(experiment)choices.set(experiment,{value:experiment,label:"SCAIL-2 · Multiple characters",note:"Experimental"});
  return {screen:{kind:"composer",manifest,subtitle:workflowLabel(manifest),options:[...choices.values()]},localAvailable};
}
