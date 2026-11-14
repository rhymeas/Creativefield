import {z} from "zod";
import type {Rect} from "./ai";

export const CHARACTER_DRAG_TYPE="application/x-comfyfield-character";
export function characterDropId(custom:string,plain=""):string|null{
  const value=custom||(plain.startsWith("character:")?plain.slice(10):"");
  const parsed=z.uuid().safeParse(value);
  return parsed.success?parsed.data:null;
}

/** A reviewable starting area. Actual pose and scale remain generative. */
export function characterPlacementRect(width:number,height:number,point:{x:number;y:number}):Rect{
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||!Number.isFinite(point.x)||!Number.isFinite(point.y))throw new Error("Choose a valid position on the image.");
  const w=Math.max(1,Math.round(width*.24)),h=Math.max(1,Math.round(height*.55));
  return {x:Math.max(0,Math.min(width-w,Math.round(Math.max(0,Math.min(1,point.x))*width-w/2))),y:Math.max(0,Math.min(height-h,Math.round(Math.max(0,Math.min(1,point.y))*height-h/2))),w,h};
}

export function characterPlacementInstruction(name:string,prompt:string):string{
  return `Place the character ${JSON.stringify(name)} inside the selected region. Use all supplied character references to preserve identity and clothing. Keep the surrounding scene unchanged. ${prompt.trim()}`.trim();
}

/** A prompt preset for replacing an already masked person, not a separate pipeline. */
export function characterSwapInstruction(name:string,prompt:string):string{
  return `Replace the person inside the selected region with the character ${JSON.stringify(name)}. Preserve the reference face, hair, skin tone and clothing. Match the scene perspective, scale and lighting. Keep everything outside the selected region unchanged. ${prompt.trim()}`.trim();
}
