import type {ApiGraph} from "../workflow/build";

/** FLUX 3 Klein edits follow the source picture; a chosen Size above 1 MP turns the canvas into the
 *  source's proportions at that megapixel count. The graph builds its latent from a source-size /
 *  ResolutionSelector switch pair, so the computed numbers replace the switch links on the one
 *  EmptyFlux2LatentImage node. 1 MP keeps the existing source-size behaviour. */
export function applyFluxEditCanvas(graph:ApiGraph,values:Record<string,unknown>,controls:readonly {id:string;default?:unknown}[],sourceSize?:{width:number;height:number}){
  if(!sourceSize||!(sourceSize.width>0)||!(sourceSize.height>0))return;
  const control=controls.find(candidate=>candidate.id==="megapixels");
  const megapixels=Number(values[control?.id??""]??control?.default);
  if(!Number.isFinite(megapixels)||megapixels<=1)return;
  const scale=Math.sqrt((megapixels*1024*1024)/(sourceSize.width*sourceSize.height));
  const width=Math.max(64,Math.round((sourceSize.width*scale)/16)*16);
  const height=Math.max(64,Math.round((sourceSize.height*scale)/16)*16);
  for(const node of Object.values(graph)){
    if(node.class_type!=="EmptyFlux2LatentImage")continue;
    if(!Array.isArray(node.inputs.width)||!Array.isArray(node.inputs.height))continue;
    node.inputs.width=width;node.inputs.height=height;
  }
}
