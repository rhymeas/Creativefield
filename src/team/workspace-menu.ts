import {Clapperboard,Maximize2,Move,Scissors,Sparkles,Video} from "lucide-react";
import {isImageWorkflow} from "../capabilities/surfaces";
import {isSelectedImageModel} from "../capabilities/image-model-selection";
import {videoHashPart} from "../ui/studio-route";
import type {Catalogue} from "./api";
import type {VideoMenuId} from "./navigation";
import {videoModeFromHash} from "./video-edit/state";

/* Menu and route helpers of the team workspace, kept out of TeamApp.tsx. */
export const sectionOf=(route:string)=>route==="openjutsu"?"video":route==="influencer"?"characters":route;
/* `#video/camera` names a workflow; `#video/trim` names a mode, and a mode wins. */
export const videoWorkflowFromHash=(hash:string)=>videoModeFromHash(hash)?undefined:videoHashPart(hash);
/* Imported workflows are the person's own choice, so they always appear; built-in ones follow the selected models. */
export const isImported=(id:string)=>id.startsWith("imported-");
/** What an imported workflow does, read from its inputs and result, so the menu can place it in the right row. */
export const importedHint=(m:Catalogue[number])=>{const image=m.inputs.some(p=>p.type==="image"),video=m.inputs.some(p=>p.type==="video"),out=m.outputs[0]?.type;return out==="video"?(video?"video edit":image?"image to video":"text to video"):(image?"image edit":"text to image");};
/** An imported workflow's menu entry: its own title (never empty), its purpose as the hint. */
export const menuTitle=(m:Catalogue[number])=>m.title.split(" (")[0]||m.id.replace(/^imported-/,"").replace(/-/g," ");
export const isImageCapability=(manifest:Catalogue[number])=>isImageWorkflow(manifest)&&(isSelectedImageModel(manifest.id)||isImported(manifest.id));
/** The icon each Video menu entry shows (Sparkles for the rest). */
export const VIDEO_MENU_ICONS:Partial<Record<VideoMenuId,typeof Sparkles>>={
  create:Video,trim:Scissors,storyboard:Clapperboard,motion:Move,enhance:Maximize2,
};
