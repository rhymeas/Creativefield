import {updateLayer,type Doc,type Layer} from "./doc";
export type TransformHandle="move"|"rotate"|"nw"|"ne"|"se"|"sw";
export type TransformPoint={x:number;y:number};
const corner=(handle:TransformHandle)=>({x:handle.includes("w")?-1:1,y:handle.includes("n")?-1:1});
export function transformCorner(layer:Layer,handle:TransformHandle):TransformPoint{
  const c=corner(handle),x=c.x*layer.w*layer.scale/2,y=c.y*layer.h*layer.scale/2,a=layer.rotation*Math.PI/180;
  return {x:layer.x+x*Math.cos(a)-y*Math.sin(a),y:layer.y+x*Math.sin(a)+y*Math.cos(a)};
}
export function dragLayerTransform(layer:Layer,handle:TransformHandle,start:TransformPoint,point:TransformPoint,{center=false,snap=false}={}):Layer{
  if(layer.locks?.position)return layer;
  const dx=point.x-start.x,dy=point.y-start.y;if(!dx&&!dy)return layer;
  if(handle==="move")return {...layer,x:layer.x+dx,y:layer.y+dy};
  if(handle==="rotate"){
    let rotation=layer.rotation+(Math.atan2(point.y-layer.y,point.x-layer.x)-Math.atan2(start.y-layer.y,start.x-layer.x))*180/Math.PI;
    if(snap)rotation=Math.round(rotation/15)*15;
    return {...layer,rotation:((rotation+180)%360+360)%360-180};
  }
  const edge=transformCorner(layer,handle),anchor=center?{x:layer.x,y:layer.y}:{x:2*layer.x-edge.x,y:2*layer.y-edge.y};
  const vx=edge.x-anchor.x,vy=edge.y-anchor.y,denom=vx*vx+vy*vy;
  if(!denom)return layer;
  const scale=Math.max(Math.min(.01,layer.scale),Math.min(10000,layer.scale*(1+(dx*vx+dy*vy)/denom))),factor=scale/layer.scale;
  return {...layer,scale,x:center?layer.x:anchor.x+vx*factor/2,y:center?layer.y:anchor.y+vy*factor/2};
}
export function applyLayerTransform(doc:Doc,id:string,layer:Layer):Doc{
  const before=doc.layers.find(item=>item.id===id);if(!before||before.locks?.position)return doc;
  const patch={x:layer.x,y:layer.y,scale:layer.scale,rotation:layer.rotation};
  if(layer.scale<=0||Object.entries(patch).some(([,value])=>!Number.isFinite(value)))return doc;
  return Object.entries(patch).every(([key,value])=>before[key as keyof Layer]===value)?doc:updateLayer(doc,id,patch);
}
