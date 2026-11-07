import {runShape} from "./run-shape";

/** The format option closest to a picture's shape; undefined when no option names a shape. */
export function nearestFormat<T>(shape:number,options:readonly T[]){
  let best:T|undefined,gap=Infinity;
  for(const option of options){
    const candidate=runShape({aspect_ratio:option});
    if(!candidate)continue;
    const distance=Math.abs(Math.log(candidate/shape));
    if(distance<gap){gap=distance;best=option;}
  }
  return best;
}
