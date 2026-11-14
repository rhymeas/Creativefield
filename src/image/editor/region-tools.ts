import type {Doc} from "./doc";
export type ObjectRegion={canvas:HTMLCanvasElement;alpha:Uint8ClampedArray;area:number};
/** Smallest overlapping instance wins, so a foreground object remains reachable. */
export function hitObject(regions:Pick<ObjectRegion,"alpha"|"area">[],x:number,y:number,w:number,h:number):number{
  x=Math.floor(x);y=Math.floor(y);if(x<0||y<0||x>=w||y>=h)return -1;
  let best=-1,area=Infinity;for(let i=0;i<regions.length;i++)if(regions[i].alpha[(y*w+x)*4+3]>127&&regions[i].area<area){area=regions[i].area;best=i;}return best;
}
/** Selection/active-layer changes do not invalidate analysis; rendered content changes do. */
export function imageSignature(doc:Doc):string{return JSON.stringify([doc.width,doc.height,doc.layers,doc.groups??{}]);}
