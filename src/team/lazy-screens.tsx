/*
 * Big screens load when they are first shown, not with the app. Hovering, focusing or touching a link that
 * leads to one starts its download early, so by the time the click lands the code is usually there.
 */
import {lazy,Suspense,type ComponentProps,type ComponentType} from "react";

type Loaded<C>=Promise<C>;
export type Preloadable<C extends ComponentType<any>>=ComponentType<ComponentProps<C>>&{preload:()=>Loaded<C>};

/** A component whose code is fetched on first render or on `preload()`, whichever comes first. */
export function preloadable<C extends ComponentType<any>>(load:()=>Loaded<C>):Preloadable<C>{
  let pending:Loaded<C>|null=null;
  const get=()=>pending??=load().catch(error=>{pending=null;throw error;});
  const Lazy=lazy(()=>get().then(component=>({default:component})));
  const Screen=((props:ComponentProps<C>)=><Suspense fallback={null}><Lazy {...props}/></Suspense>) as Preloadable<C>;
  Screen.preload=get;
  return Screen;
}

export const ImageEditor=preloadable(()=>import("../image/editor/ImageEditor").then(m=>m.ImageEditor));
export const ImageStudio=preloadable(()=>import("../image/ImageStudio").then(m=>m.ImageStudio));
export const ChatgptImageStudio=preloadable(()=>import("./ChatgptImageStudio").then(m=>m.ChatgptImageStudio));
export const CloudRenderStudio=preloadable(()=>import("./CloudRenderStudio").then(m=>m.CloudRenderStudio));
export const ThreeDStudio=preloadable(()=>import("./three-d/ThreeDStudio").then(m=>m.ThreeDStudio));
export const ImageTo3DPanel=preloadable(()=>import("./three-d/ImageTo3DPanel").then(m=>m.ImageTo3DPanel));
export const ModelToolsPanel=preloadable(()=>import("./three-d/ModelToolsPanel").then(m=>m.ModelToolsPanel));
export const TextTo3DPanel=preloadable(()=>import("./three-d/TextTo3DPanel").then(m=>m.TextTo3DPanel));
export const ComfyNodes=preloadable(()=>import("./nodes/ComfyNodes").then(m=>m.ComfyNodes));
export const AudioStudio=preloadable(()=>import("./audio/AudioStudio").then(m=>m.AudioStudio));
export const CharacterWorkspace=preloadable(()=>import("./characters/CharacterWorkspace").then(m=>m.CharacterWorkspace));
export const TeamStoryboard=preloadable(()=>import("./TeamStoryboard").then(m=>m.TeamStoryboard));
export const KeyframeStudio=preloadable(()=>import("./KeyframeStudio").then(m=>m.KeyframeStudio));
export const TeamSettings=preloadable(()=>import("./TeamSettings").then(m=>m.TeamSettings));
export const VideoEditStudio=preloadable(()=>import("./video-edit/VideoEditStudio").then(m=>m.VideoEditStudio));
export const TransformVideo=preloadable(()=>import("./TransformVideo").then(m=>m.TransformVideo));

/** Which screens a link's hash may open; the first match wins. */
const ROUTES:[RegExp,Preloadable<any>[]][]=[
  [/imageedit|fotofield/,[ImageEditor]],
  [/3d|three|model/,[ThreeDStudio,ImageTo3DPanel,TextTo3DPanel,ModelToolsPanel]],
  [/node/,[ComfyNodes]],
  [/audio|voice|sound|music/,[AudioStudio]],
  [/character|influencer/,[CharacterWorkspace]],
  [/storyboard/,[TeamStoryboard]],
  [/keyframe/,[KeyframeStudio]],
  [/settings/,[TeamSettings]],
  [/image|picture/,[ImageStudio]],
  [/trim|transform|replace|swap|edit/,[VideoEditStudio,TransformVideo]],
];

/** Start loading the screens a hash leads to. Safe to call often; each screen loads once. */
export function preloadFor(hash:string){
  const key=hash.toLowerCase();
  const hit=ROUTES.find(([pattern])=>pattern.test(key));
  hit?.[1].forEach(screen=>void screen.preload().catch(()=>{}));
}

/** One listener for the whole app: any in-app link (`href="#…"`) or element with `data-preload="#…"` warms its screen. */
export function installIntentPreload(){
  if(typeof document==="undefined")return()=>{};
  const seen=new Set<string>();
  const warm=(event:Event)=>{
    const el=(event.target as Element|null)?.closest?.<HTMLElement>("a[href^='#'],[data-preload]");
    const hash=el?.dataset.preload??el?.getAttribute("href");
    if(!hash||seen.has(hash))return;
    seen.add(hash);preloadFor(hash);
  };
  for(const type of ["pointerover","focusin","touchstart"])document.addEventListener(type,warm,{passive:true,capture:true});
  return()=>{for(const type of ["pointerover","focusin","touchstart"])document.removeEventListener(type,warm,{capture:true});};
}

installIntentPreload();
