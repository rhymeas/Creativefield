import type {ApiGraph} from "../workflow/build";

export const REPLACE_INSPECTION_OUTPUTS = [
  {id:"inspect:reference",label:"Reference images",input:"reference_image",first:false},
  {id:"inspect:reference-mask",label:"Reference identity masks",input:"reference_image_mask",first:false},
  {id:"inspect:source",label:"First driving frame",input:"pose_video",first:true},
  {id:"inspect:source-mask",label:"First driving identity mask",input:"pose_video_mask",first:true},
] as const;

/** Export the real conditioning inputs of the first SCAIL window. This only builds
 * JSON; it never queues work. SAM tracking may run when the export is later queued,
 * but no diffusion sampler, video encoder or previous generated chunk is retained. */
export function buildReplaceInspectionGraph(submitted:ApiGraph):ApiGraph {
  const graph=structuredClone(submitted);
  const condition=graph["213:114"]??Object.values(graph).find(n=>n.class_type==="WanSCAILToVideo"&&!n.inputs.previous_frames);
  if(condition?.class_type!=="WanSCAILToVideo")throw new Error("This run has no supported SCAIL reference conditioning");
  const isLink=(value:unknown):value is [string,number]=>Array.isArray(value)&&value.length===2&&typeof value[0]==="string"&&Number.isInteger(value[1]);
  // Freeze lazy branches to the submitted choice. The unused second-image branch
  // must not start merely because an inspection output was added.
  function resolve(value:unknown,seen=new Set<string>()):unknown {
    if(!isLink(value))return value;
    const node=graph[value[0]];
    if(node?.class_type!=="ComfySwitchNode")return value;
    if(seen.has(value[0]))throw new Error("Cyclic reference switch");
    seen.add(value[0]);
    const flag=node.inputs.switch;
    const selected=isLink(flag)?graph[flag[0]]?.inputs.value:flag;
    if(typeof selected!=="boolean")throw new Error("The reference selection could not be frozen for inspection");
    return resolve(node.inputs[selected?"on_true":"on_false"],seen);
  }
  for(const node of Object.values(graph))for(const [key,value] of Object.entries(node.inputs))node.inputs[key]=resolve(value);
  const roots:string[]=[];
  for(const output of REPLACE_INSPECTION_OUTPUTS){
    if(graph[output.id]||graph[output.id+":first"])throw new Error("Inspection output ID collision");
    const input=resolve(condition.inputs[output.input]);
    if(!isLink(input)||!graph[input[0]])throw new Error(`The run did not retain ${output.label.toLowerCase()}`);
    let image=input;
    if(output.first){
      const first=output.id+":first";
      graph[first]={class_type:"ImageFromBatch",inputs:{image,batch_index:0,length:1}};
      image=[first,0];
    }
    graph[output.id]={class_type:"SaveImage",inputs:{images:image,filename_prefix:`ComfyField/inspection/${output.id.replace(":","-")}`}};
    roots.push(output.id);
  }
  const needed=new Set<string>(),visiting=new Set<string>();
  function keep(id:string){
    if(needed.has(id))return;
    if(visiting.has(id))throw new Error("Cyclic reference preparation graph");
    const node=graph[id];
    if(!node)throw new Error("Reference preparation has a missing dependency");
    if(/sampler|guider|scheduler|^UNETLoader$|^VAEDecode|^CreateVideo$|^SaveVideo$|^Wan.*ToVideo$/i.test(node.class_type)){
      throw new Error("Inspection unexpectedly depends on video generation");
    }
    visiting.add(id);
    for(const value of Object.values(node.inputs))if(isLink(value))keep(value[0]);
    visiting.delete(id);needed.add(id);
  }
  roots.forEach(keep);
  return Object.fromEntries(Object.entries(graph).filter(([id])=>needed.has(id)));
}
