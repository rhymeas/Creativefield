import type {ApiGraph} from "../workflow/build";

/** Qwen Image 2.1 and Fibo 2 edits follow the source picture; a Size above 1 MP turns the canvas
 *  into the source's proportions at that megapixel count. Both graphs build their latent at the
 *  source size by default (Qwen picks the text encoder latent, Fibo passes width/height 0), so the
 *  computed numbers replace that source-size path. 1 MP keeps the existing behaviour. */
export function applyEditCanvas(graph:ApiGraph,values:Record<string,unknown>,controls:readonly {id:string;default?:unknown}[],sourceSize?:{width:number;height:number}){
  const control=controls.find(candidate=>candidate.id==="megapixels");
  if(!control)return;
  const megapixels=Number(values[control.id]??control.default);
  const above=Number.isFinite(megapixels)&&megapixels>1&&!!sourceSize&&sourceSize.width>0&&sourceSize.height>0;
  const canvas=(multiple:number)=>{
    if(!above)return undefined;
    const scale=Math.sqrt((megapixels*1024*1024)/(sourceSize!.width*sourceSize!.height));
    return {
      width:Math.max(64,Math.round((sourceSize!.width*scale)/multiple)*multiple),
      height:Math.max(64,Math.round((sourceSize!.height*scale)/multiple)*multiple),
    };
  };
  for(const node of Object.values(graph)){
    if(node.class_type!=="TextEncodeFibo2"||!("width" in node.inputs)||!("height" in node.inputs))continue;
    const size=canvas(16);
    node.inputs.width=size?.width??0;node.inputs.height=size?.height??0;
  }
  for(const node of Object.values(graph)){
    if(node.class_type!=="ComfySwitchNode")continue;
    const onTrue=node.inputs.on_true,onFalse=node.inputs.on_false;
    if(!Array.isArray(onTrue)||!Array.isArray(onFalse))continue;
    const latent=graph[String(onTrue[0])],source=graph[String(onFalse[0])];
    if(latent?.class_type!=="EmptyLatentImage"||source?.class_type!=="TextEncodeQwenImage21")continue;
    const size=canvas(32);
    node.inputs.switch=!!size;
    if(size){latent.inputs.width=size.width;latent.inputs.height=size.height;}
  }
}
