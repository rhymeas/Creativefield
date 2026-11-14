/** How the edit model names its pictures: "image N" for most, <Picture N> for MiniMax H3 Image. */
export type PictureMentionStyle="plain"|"h3";

/** Bind user reference pictures after the canvas (and optional annotation guide), preserving visible reference numbers. */
export function modifyReferenceBindings(source:string,guide:string|undefined,references:Array<string|null>,ports:readonly string[],prompt:string,style:PictureMentionStyle="plain"){
  const inputs:Record<string,string>={source_image:source},ordered=references.flatMap((id,index)=>id?[{id,index}]:[]);
  const available=["reference_image","reference_image_2","reference_image_3"].filter(port=>ports.includes(port));
  if(ordered.length+(guide?1:0)>available.length)throw new Error("This model cannot use all references together with these annotations. Remove a reference or choose a compatible model.");
  let next=0;if(guide)inputs[available[next++]]=guide;
  const imageNumbers=new Map<number,number>();for(const ref of ordered){inputs[available[next]]=ref.id;imageNumbers.set(ref.index+1,next+2);next++;}
  const text=prompt.replace(/@Image\s+([1-3])\b/gi,(match,index)=>{const number=imageNumbers.get(Number(index));return number?(style==="h3"?`<Picture ${number}>`:`image ${number}`):match;});
  return {inputs,prompt:text};
}

/** The guide is a reference, never an instruction to paint the overlay. */
export const selectionGuideInstruction = "The second image is a selection guide: the blue overlay marks the area to edit in the first image. Follow the user's instruction within that area. Do not include the blue overlay in the result; leave unrelated areas unchanged.";
const H3_SELECTION_GUIDE = "<Picture 2> is a selection guide: the blue overlay marks the area to edit in <Picture 1>. Follow the instruction within that area. Do not include the blue overlay in the result; leave unrelated areas unchanged.";

/** The selection-guide sentence in the model's own picture names. */
export const selectionGuideFor = (style:PictureMentionStyle) => style==="h3" ? H3_SELECTION_GUIDE : selectionGuideInstruction;

/** MiniMax H3 Image edits Picture 1 when the instruction says so, as the official edit node does ("Edit <Picture 1>. ..."). */
export function editInstructionFor(style:PictureMentionStyle,instruction:string):string {
  if(style!=="h3"||/^\s*Edit <Picture \d+>/.test(instruction))return instruction;
  return `Edit <Picture 1>. ${instruction}`;
}

export function canAttachSelectionGuide(ports:readonly string[],references:Array<string|null>):boolean {
  return ["reference_image","reference_image_2","reference_image_3"].filter(port=>ports.includes(port)).length>references.filter(Boolean).length;
}

/** Resolve image mentions inside every numbered annotation as well as the main prompt. */
export function mapAnnotationReferenceMentions<T extends {instruction:string}>(annotations:T[],source:string,guide:string|undefined,references:Array<string|null>,ports:readonly string[],style:PictureMentionStyle="plain"):T[]{
  return annotations.map(annotation=>({...annotation,instruction:modifyReferenceBindings(source,guide,references,ports,annotation.instruction,style).prompt}));
}
