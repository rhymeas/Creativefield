import {blankCanvas,setBitmap} from '../../src/image/editor/bitmaps';
import {docFromImage} from '../../src/image/editor/doc';
import {wandShape} from '../../src/image/editor/selection';

/** Browser regression checks for the actual canvas-based selection algorithm. */
export function runWandChecks(){
 const image=blankCanvas(40,10),ctx=image.getContext('2d')!;
 for(const [index,value] of [100,120,200,100].entries()){
  ctx.fillStyle=`rgb(${value},${value},${value})`;ctx.fillRect(index*10,0,10,10);
 }
 setBitmap('wand-browser-regression',image);
 const doc=docFromImage('Wand','wand-browser-regression',40,10);
 const pixels=(tolerance:number,contiguous=true)=>{
  const canvas=wandShape(doc,{x:5,y:5},tolerance,{contiguous});
  return [5,15,25,35].map(x=>canvas.getContext('2d')!.getImageData(x,5,1,1).data[3]);
 };
 const check=(actual:number[],expected:number[])=>{
  if(actual.some((value,index)=>value!==expected[index]))throw new Error(`Unexpected wand selection ${actual}; expected ${expected}`);
 };
 check(pixels(5),[255,0,0,0]);
 check(pixels(20),[255,255,0,0]);
 check(pixels(100),[255,255,255,255]);
 check(pixels(5,false),[255,0,0,255]);
 return ['narrow tolerance','expanded tolerance','full range','non-contiguous matching'];
}
