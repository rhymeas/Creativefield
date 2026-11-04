import type {CapabilityManifestV2} from "../capabilities/types";
import {nativeCameraPose} from "./camera-controls";
import type {CameraPose} from "../ds/CameraMovePicker";

/** H3 interprets these as prompt guidance; they are not fixed camera paths. */
export const CAMERA_MOVES=[
  {id:"static",label:"Static",instruction:"Keep the camera still and locked off throughout the shot."},
  {id:"pan-left",label:"Pan left",instruction:"The camera slowly pans left."},
  {id:"pan-right",label:"Pan right",instruction:"The camera slowly pans right."},
  {id:"pan-up",label:"Pan up",instruction:"The camera slowly tilts up."},
  {id:"pan-down",label:"Pan down",instruction:"The camera slowly tilts down."},
  {id:"zoom-in",label:"Zoom in",instruction:"The camera slowly zooms in."},
  {id:"zoom-out",label:"Zoom out",instruction:"The camera slowly zooms out."},
] as const;

/** Put the chosen direction in the editable shot prompt, so saving and rendering use the same text. */
export function appendCameraDirection(prompt:string,id:string):string{
  const move=CAMERA_MOVES.find(option=>option.id===id);
  if(!move)return prompt;
  const lines=prompt.split("\n"),previous=lines.filter(line=>CAMERA_MOVES.some(option=>line.trim()===option.instruction));
  if(previous.length===1&&previous[0].trim()===move.instruction)return prompt;
  const rest=lines.filter(line=>!CAMERA_MOVES.some(option=>line.trim()===option.instruction)).join("\n");
  return `${rest}${rest&&!rest.endsWith("\n")?"\n":""}${move.instruction}`;
}

/** The end of each named move, as the camera stage draws it. */
const MOVE_POSES:Record<string,CameraPose>={static:{x:0,y:0,zoom:1},"pan-left":{x:-.3,y:0,zoom:1},"pan-right":{x:.3,y:0,zoom:1},"pan-up":{x:0,y:-.3,zoom:1},"pan-down":{x:0,y:.3,zoom:1},"zoom-in":{x:0,y:0,zoom:1.4},"zoom-out":{x:0,y:0,zoom:.75}};
export const cameraMovePose=(id:string):CameraPose|null=>MOVE_POSES[id]??null;
/** The named move a pose stands for, by its largest part (models with one fixed camera path follow one move). */
export function cameraPoseMove(pose:CameraPose):string{
  const zoom=Math.abs(Math.log(pose.zoom))*.9,x=Math.abs(pose.x),y=Math.abs(pose.y);
  if(!x&&!y&&!zoom)return "static";
  if(zoom>=x&&zoom>=y)return pose.zoom>1?"zoom-in":"zoom-out";
  return x>=y?(pose.x<0?"pan-left":"pan-right"):(pose.y<0?"pan-up":"pan-down");
}

const CAMERA_LINE=/^Camera: /;
/** One prompt line H3 reads and the stage reads back: direction, amount and zoom in plain words. */
export function cameraSentence(pose:CameraPose):string{
  if(!pose.x&&!pose.y&&pose.zoom===1)return "Camera: locked off, the camera holds perfectly still for the whole shot.";
  const parts:string[]=[];
  if(pose.x)parts.push(`pans ${pose.x<0?"left":"right"} about ${Math.round(Math.abs(pose.x)*100)}% of the frame`);
  if(pose.y)parts.push(`tilts ${pose.y<0?"up":"down"} about ${Math.round(Math.abs(pose.y)*100)}% of the frame`);
  if(pose.zoom!==1)parts.push(`${pose.zoom>1?"zooms in":"pulls back"} to ${Number(pose.zoom.toFixed(2))}x`);
  const list=parts.length>1?`${parts.slice(0,-1).join(", ")} and ${parts[parts.length-1]}`:parts[0];
  return `Camera: the camera ${list}, moving smoothly through the whole shot and ending there.`;
}
/** The camera pose written in a prompt (by the stage, or an older one-word move), or null when there is none. */
export function readCameraPose(prompt:string):CameraPose|null{
  for(const raw of prompt.split("\n").reverse()){
    const line=raw.trim(),legacy=CAMERA_MOVES.find(move=>move.instruction===line);
    if(legacy)return cameraMovePose(legacy.id);
    if(!CAMERA_LINE.test(line))continue;
    if(/locked off/.test(line))return {x:0,y:0,zoom:1};
    const pan=line.match(/pans (left|right) about (\d+)%/),tilt=line.match(/tilts (up|down) about (\d+)%/),zoom=line.match(/(zooms in|pulls back) to ([\d.]+)x/);
    return {x:pan?(pan[1]==="left"?-1:1)*Number(pan[2])/100:0,y:tilt?(tilt[1]==="up"?-1:1)*Number(tilt[2])/100:0,zoom:zoom?Number(zoom[2]):1};
  }
  return null;
}
/** Replace any camera line in the prompt with this pose's sentence, or remove it for null. */
export function writeCameraPose(prompt:string,pose:CameraPose|null):string{
  const rest=prompt.split("\n").filter(line=>!CAMERA_LINE.test(line.trim())&&!CAMERA_MOVES.some(move=>move.instruction===line.trim())).join("\n").trimEnd();
  return pose?`${rest}${rest?"\n":""}${cameraSentence(pose)}`:rest;
}

/** H3 has no native camera path: express a requested movement in its text prompt. */
export function supportsH3PromptCamera(manifest:CapabilityManifestV2){
  return ["h3-t2v","h3-i2v","h3-flf2v"].includes(manifest.id)&&manifest.controls.some(control=>control.id==="prompt"&&!!control.binding);
}

/** The model whose camera moves are only a sentence in the prompt, and the one that moves the camera for real. */
export const CAMERA_ROUTE_PAIRS:Readonly<Record<string,string>>={"wan22-i2v-14b":"camera"};

export function cameraPair(manifest:CapabilityManifestV2,catalogue:CapabilityManifestV2[]){
  const id=CAMERA_ROUTE_PAIRS[manifest.id];
  return id?catalogue.find(m=>m.id===id&&m.coverage.local==="implemented"&&nativeCameraPose(m,"pan-left")!==undefined):undefined;
}

/**
 * A chosen camera move runs on the model with a fixed camera path: a prompt sentence is a wish the
 * model may ignore (measured: 1 % zoom in one second), a path is followed. Only controls that model
 * has are sent; its duration stops at its own maximum.
 */
export function cameraRoute(camera:CapabilityManifestV2,move:string,inputs:Record<string,string>,controls:Record<string,string|number|boolean>){
  const pose=nativeCameraPose(camera,move);
  if(pose===undefined||!inputs.start_image)return undefined;
  const wanted:Record<string,string|number|boolean>={...controls,camera_pose:pose};
  const sent:Record<string,string|number|boolean>={};
  for(const control of camera.controls){
    let value=wanted[control.id];
    if(value===undefined||value==="")continue;
    if(control.id==="width"||control.id==="height")continue;
    if(typeof value==="number"&&control.max!==undefined)value=Math.min(value,control.max);
    sent[control.id]=value;
  }
  return {capabilityId:camera.id,version:camera.version,inputs:{start_image:inputs.start_image},controls:sent};
}
