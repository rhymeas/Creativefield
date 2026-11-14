import type {ApiGraph} from "../workflow/build";
import type {Port} from "./types";

/**
 * MiniMax H3 Image reads its pictures as <Picture 1>, <Picture 2>, ... in packed slot order: an empty slot is
 * skipped, so the pictures after it move up. The prompt is written against the editor's stable slots
 * (@Image n, or <Picture n> typed by hand, where n is the nth image input), so translate each mention of an
 * attached picture to its packed position. Mentions of empty slots stay as typed.
 * Note: src/team/prompt-reference.ts has a similar promptSlotsToPictures for the video composer (uncommitted
 * at the time of writing); merge the two once it lands.
 */
export function packH3PictureMentions(prompt:string,imagePorts:readonly Port[],inputs:Record<string,string>):string {
  const positions=new Map<number,number>();
  let next=1;
  imagePorts.forEach((port,index)=>{if(inputs[port.id])positions.set(index+1,next++);});
  return prompt.replace(/@Image\s*(\d{1,2})\b|<Picture\s+(\d{1,2})>/gi,(match,mention:string|undefined,picture:string|undefined)=>{
    const position=positions.get(Number(mention??picture));
    return position===undefined?match:`<Picture ${position}>`;
  });
}

/** The format choice that keeps Picture 1's proportions instead of a fixed aspect ratio. */
export const H3_SOURCE_SIZE = "Same as Picture 1";

/**
 * When the format control asks for Picture 1's proportions, the canvas keeps those proportions. With a
 * decoded source size and a chosen megapixel count the canvas is sized to that count on the 32 px grid
 * (the same binary-megapixel rule as the selector); without it the node falls back to Picture 1's own size.
 */
export function applyH3SourceSize(graph:ApiGraph,values:Record<string,unknown>,controls:readonly {id:string;default?:unknown;binding?:{node:string;field:string}}[],sourceSize?:{width:number;height:number}){
  for(const node of Object.values(graph)){
    if(node.class_type!=="MiniMaxH3ImageConditioning")continue;
    const width=node.inputs.width,height=node.inputs.height;
    if(!Array.isArray(width)||!Array.isArray(height)||width[0]!==height[0])continue;
    const selector=String(width[0]);
    const format=controls.find(control=>control.binding?.node===selector&&control.binding.field==="aspect_ratio");
    if(!format||(values[format.id]??format.default)!==H3_SOURCE_SIZE)continue;
    if(!Object.keys(node.inputs).some(field=>field.startsWith("images.")))throw new Error(`${H3_SOURCE_SIZE} needs Picture 1`);
    const megapixels=controls.find(control=>control.id==="megapixels");
    const target=Number(values[megapixels?.id??""]??megapixels?.default);
    if(sourceSize&&Number.isFinite(target)&&target>0){
      const scale=Math.sqrt((target*1024*1024)/(sourceSize.width*sourceSize.height));
      node.inputs.width=Math.max(64,Math.round((sourceSize.width*scale)/32)*32);
      node.inputs.height=Math.max(64,Math.round((sourceSize.height*scale)/32)*32);
    }else{
      node.inputs.width=0;node.inputs.height=0;
    }
    const stillUsed=Object.values(graph).some(other=>other!==node&&Object.values(other.inputs).some(value=>Array.isArray(value)&&value[0]===selector));
    if(!stillUsed)delete graph[selector];
  }
}

/** Apply the translation to every MiniMax H3 Image conditioning prompt in a compiled graph. */
export function applyH3PictureMentions(graph:ApiGraph,ports:readonly Port[],inputs:Record<string,string>){
  const imagePorts=ports.filter(port=>port.type==="image");
  if(!imagePorts.length)return;
  for(const node of Object.values(graph)){
    if(node.class_type!=="MiniMaxH3ImageConditioning"||typeof node.inputs.prompt!=="string")continue;
    node.inputs.prompt=packH3PictureMentions(node.inputs.prompt,imagePorts,inputs);
  }
}

/** ComfyUI's ResolutionSelector caps megapixels at 16; the H3-Image model is good to 20. */
const RESOLUTION_SELECTOR_MAX_MEGAPIXELS = 16;

function megapixelsFromAspect(ratio:number,megapixels:number){
  const width=Math.round(Math.sqrt(megapixels*1024*1024*ratio)/32)*32;
  const height=Math.round(Math.sqrt(megapixels*1024*1024/ratio)/32)*32;
  if(!(width>0)||!(height>0))throw new Error("This model has no valid output size.");
  return {width,height};
}

/**
 * Above 16 megapixels the core ResolutionSelector refuses the value. Compute the same canvas
 * (binary megapixels, 32 px grid) from the chosen format and megapixels and write width and
 * height straight into the conditioning node, dropping the unused selector. The 4-16 MP path
 * stays on the selector, exactly as verified.
 */
export function applyH3LargeCanvas(graph:ApiGraph){
  for(const node of Object.values(graph)){
    if(node.class_type!=="MiniMaxH3ImageConditioning")continue;
    const width=node.inputs.width,height=node.inputs.height;
    if(!Array.isArray(width)||!Array.isArray(height)||width[0]!==height[0])continue;
    const selector=String(width[0]);
    const selected=graph[selector];
    if(!selected||selected.class_type!=="ResolutionSelector")continue;
    const megapixels=Number(selected.inputs.megapixels);
    if(!Number.isFinite(megapixels)||megapixels<=RESOLUTION_SELECTOR_MAX_MEGAPIXELS)continue;
    const ratioText=String(selected.inputs.aspect_ratio??"");
    const ratioMatch=/^\s*(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)/.exec(ratioText);
    if(!ratioMatch||Number(ratioMatch[1])<=0||Number(ratioMatch[2])<=0)throw new Error("This model has no valid aspect ratio.");
    const size=megapixelsFromAspect(Number(ratioMatch[1])/Number(ratioMatch[2]),megapixels);
    node.inputs.width=size.width;node.inputs.height=size.height;
    const stillUsed=Object.values(graph).some(other=>other!==node&&Object.values(other.inputs).some(value=>Array.isArray(value)&&value[0]===selector));
    if(!stillUsed)delete graph[selector];
  }
}

