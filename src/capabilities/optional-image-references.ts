import type {ApiGraph} from "../workflow/build";
import type {Port} from "./types";

/** Nodes whose autogrow image sockets were reviewed as optional reference inputs, with the socket pattern. */
const REFERENCE_SOCKETS:Record<string,RegExp>={
  TextEncodeQwenImage21:/^images\.image_([1-9]|1[0-6])$/,
  TextEncodeFibo2:/^images\.image_([1-9]|1[0-6])$/,
  MiniMaxH3ReferenceToVideo:/^ref_images\.ref_image_[0-9]$/,
};

/** Only the reviewed Qwen, Fibo 2 and MiniMax H3 autogrow reference sockets may be removed. Ordinary
 * optional inputs retain their declared workflow defaults. */
export function optionalReferenceLink(graph:ApiGraph,port:Port){
  const binding=port.binding,node=binding&&graph[binding.node];
  if(port.required||port.type!=="image"||!binding||binding.field!=="image"||node?.class_type!=="LoadImage")throw new Error(`Invalid optional reference: ${port.id}`);
  const links=Object.entries(graph).flatMap(([id,consumer])=>Object.entries(consumer.inputs).filter(([,value])=>Array.isArray(value)&&value[0]===binding.node).map(([field,value])=>({id,consumer,field,value})));
  if(links.length!==1||!REFERENCE_SOCKETS[links[0].consumer.class_type]?.test(links[0].field)||!Array.isArray(links[0].value)||links[0].value[1]!==0)throw new Error(`Invalid optional reference consumer: ${port.id}`);
  return {loader:binding.node,consumer:links[0].id,field:links[0].field};
}

export function omitMissingReferences(graph:ApiGraph,ports:Port[],inputs:Record<string,string>){
  for(const port of ports.filter(port=>port.omitWhenMissing)){
    const link=optionalReferenceLink(graph,port);
    if(!inputs[port.id]){delete graph[link.consumer].inputs[link.field];delete graph[link.loader];}
  }
}
