/** Fill an empty input without losing a draft or replacing a pending choice. */
export function intentReferenceDraft<T extends {inputs?:Record<string,string>;elementInputs?:Record<string,unknown>;controls:Record<string,string|number|boolean>}>(draft:T,port:string,assetId:string,prompt:string,defaultPrompt:string):T {
  if((draft.inputs?.[port]&&draft.inputs[port]!==assetId)||draft.elementInputs?.[port])throw new Error("This draft already has a source. Clear it before using this reference.");
  const old=String(draft.controls.prompt??"").trim();
  if(old&&old!==defaultPrompt.trim()&&old!==prompt)throw new Error("This draft already has a prompt. Clear it before using this request.");
  return {...draft,inputs:{...draft.inputs,[port]:assetId},controls:{...draft.controls,prompt}};
}
/** Keep the active supported edit model when handing off an image reference. */
export function intentImageReferenceTarget<T extends {id:string;inputs:readonly {id:string;type:string}[]}>(ready:readonly T[],activeId?:string):T|undefined {
  const supported=ready.filter(pack=>["fibo2-edit","qwen-image-21-edit","flux2-klein-edit"].includes(pack.id)&&pack.inputs.some(port=>port.id==="source_image"&&port.type==="image"));
  return supported.find(pack=>pack.id===activeId)??supported[0];
}
