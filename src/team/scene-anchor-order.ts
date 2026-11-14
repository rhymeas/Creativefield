import {heuristicPlan,mentionLabel} from "../workflow/reference-prompt";
import {withIndexes,sceneWords} from "./reference-replace";

export function sceneAnchorOrder(characters:Array<{asset:string;index:number}>,prompt:string,edited:boolean){
  const parsed=edited?heuristicPlan(`${mentionLabel("video",1)}. ${prompt}`):null;
  const positions=parsed?withIndexes(parsed):[];
  const order=characters.map((c,i)=>({...c,index:positions.find(p=>p.face===mentionLabel("image",i+1))?.index??c.index})).sort((a,b)=>a.index-b.index);
  const problem=order.length!==2||order[0].index!==0||order[1].index!==1?"A scene frame needs one reference for the left person and one for the right person.":"";
  return {references:order.map(c=>c.asset),targets:order.map(c=>c.index),prompt:edited?sceneWords(prompt):"",problem};
}
