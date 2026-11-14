import type {Port} from "../capabilities/types";
import {assetMatchesPort} from "../capabilities/assets";
import type {ReusableElement} from "./api";
import type {Draft,ElementInputBinding} from "./state";

/** Every Element whose asset fits the port, whatever its kind: a product, a style or a character.
 *  Screens call the control "Saved element" so a product never passes as a person. */
export function compatibleElementOptions(elements:ReusableElement[],port:Port){
  return elements.flatMap(element=>element.assets.filter(asset=>assetMatchesPort(asset,port)).map(asset=>({value:`${element.id}:${asset.id}`,label:element.name,note:`${element.kind} · ${asset.name}`})));
}

/** The storyboard shot editor places people only; a product or a style has no place in a shot's cast. */
export function characterElementOptions(elements:ReusableElement[],port:Port){
  return compatibleElementOptions(elements.filter(element=>element.kind==="character"),port);
}

/** Picker values carry both ids: the Element whose snapshot the render uses and the reference asset it binds. */
export function elementBinding(value:string):ElementInputBinding|null{
  const separator=value.indexOf(":");
  const elementId=separator<0?"":value.slice(0,separator),assetId=separator<0?"":value.slice(separator+1);
  return elementId&&assetId?{elementId,assetId}:null;
}

export function chooseElementInput(draft:Draft,port:string,value:string):Draft{
  const inputs={...draft.inputs},elementInputs={...draft.elementInputs},binding=elementBinding(value);delete inputs[port];
  if(binding)elementInputs[port]=binding;else delete elementInputs[port];
  return {...draft,inputs,elementInputs};
}
