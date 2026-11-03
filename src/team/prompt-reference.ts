/** Insert a reference mention without discarding the person's current sentence or caret position. */
export function insertReferenceMention(value:string,start:number,end:number,label:string){
  const from=Math.max(0,Math.min(value.length,start)),to=Math.max(from,Math.min(value.length,end));
  const before=value.slice(0,from),after=value.slice(to),left=before&&!/\s$/.test(before)?" ":"",right=after&&!/^(?:\s|[.,;:!?])/.test(after)?" ":"";
  const inserted=`${left}${label}${right}`,next=`${before}${inserted}${after}`;
  return {value:next,caret:before.length+inserted.length};
}


export function h3PromptReferences(value:string):string { return modelPromptReferences(value,"h3",1); }

/** The mention as the model reads it: MiniMax H3 names pictures <Picture N>; other models read "image N".
 *  Only mentions of bound pictures are translated; missing slots stay as typed. */
export function modelPromptReferences(value:string,style:"h3"|"plain",available:number|readonly number[]):string {
  return value.replace(/@Image\s*(\d{1,2})\b/gi,(m,n:string)=>{const index=Number(n),exists=typeof available==="number"?index>=1&&index<=available:available.includes(index);return !exists?m:style==="h3"?`<Picture ${n}>`:`image ${n}`;});
}

/** A pack whose graph runs MiniMax H3 nodes reads <Picture N>. */
export const usesH3Prompt=(manifest:{routes:Array<{requirements:Array<{kind:string;name:string}>}>})=>manifest.routes.some(r=>r.requirements.some(q=>q.kind==="node"&&/^MiniMaxH3|^H3CharacterSwap/.test(q.name)));
