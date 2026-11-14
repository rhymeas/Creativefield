/** Insert a reference mention without discarding the person's current sentence or caret position. */
export function insertReferenceMention(value:string,start:number,end:number,label:string){
  const from=Math.max(0,Math.min(value.length,start)),to=Math.max(from,Math.min(value.length,end));
  const before=value.slice(0,from),after=value.slice(to),left=before&&!/\s$/.test(before)?" ":"",right=after&&!/^(?:\s|[.,;:!?])/.test(after)?" ":"";
  const inserted=`${left}${label}${right}`,next=`${before}${inserted}${after}`;
  return {value:next,caret:before.length+inserted.length};
}


export function h3PromptReferences(value:string):string { return modelPromptReferences(value,"h3",1); }

/** An end frame is a timed guide, not a numbered image in H3's reference list. */
export function describeEndFrameMention(value:string,slot:number,hasEnd:boolean):string {
  if(!hasEnd || !Number.isSafeInteger(slot) || slot<1)return value;
  return value.replace(new RegExp(`@Image\\s*${slot}\\b|<Picture\\s+${slot}>`,"gi"),"the end frame");
}

/** The mention as the model reads it: MiniMax H3 names pictures <Picture N>; other models read "image N".
 *  Only mentions of bound pictures are translated; missing slots stay as typed. */
export function modelPromptReferences(value:string,style:"h3"|"plain",available:number|readonly number[]):string {
  return value.replace(/@Image\s*(\d{1,2})\b/gi,(m,n:string)=>{const index=Number(n),exists=typeof available==="number"?index>=1&&index<=available:available.includes(index);return !exists?m:style==="h3"?`<Picture ${n}>`:`image ${n}`;});
}

/** The image reader sees a packed list; keep its labels aligned with the editor's
 * stable slots so the workflow can pack them exactly once at submission. */
export function promptPicturesToSlots(value:string,referenceSlots:readonly number[]):string {
  return value.replace(/<Picture\s+(\d+)>/gi,(match,n:string)=>{
    const number=Number(n);
    if(number<2)return match;
    const slot=referenceSlots[number-2];
    return slot===undefined?match:`<Picture ${slot+2}>`;
  });
}

/** Translate the editor's stable image slots to the packed order sent to the reader. */
export function promptSlotsToPictures(value:string,referenceSlots:readonly number[]):string {
  const positions=new Map<number,number>([[1,1]]);
  referenceSlots.forEach((slot,index)=>positions.set(slot+2,index+2));
  return value.replace(/@Image\s*(\d{1,2})\b|<Picture\s+(\d+)>/gi,(match,mention:string|undefined,picture:string|undefined)=>{
    const position=positions.get(Number(mention??picture));
    return position===undefined?match:`<Picture ${position}>`;
  });
}

/** A pack whose graph runs MiniMax H3 nodes reads <Picture N>. */
export const usesH3Prompt=(manifest:{routes:Array<{requirements:Array<{kind:string;name:string}>}>})=>manifest.routes.some(r=>r.requirements.some(q=>q.kind==="node"&&/^MiniMaxH3|^H3CharacterSwap/.test(q.name)));
