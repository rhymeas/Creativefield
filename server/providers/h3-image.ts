import sharp from 'sharp';
import type {OwnedInput} from './types';

const MB=1024*1024;

/** Make H3-compatible image copies without changing the project assets. */
export async function prepareH3Images(inputs:readonly OwnedInput[]):Promise<Record<string,string>>{
 const result:Record<string,string>={},sources:Buffer[]=[];
 for(const input of inputs){
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of await input.open()){const b=Buffer.from(chunk);size+=b.length;if(size>50*MB)throw new Error('Reference image is too large to prepare');chunks.push(b);}
  sources.push(Buffer.concat(chunks));
 }
 const compress=sources.reduce((sum,source)=>sum+source.length,0)>(inputs.length>1?5:10)*MB;
 for(const [index,input] of inputs.entries()){
  const source=sources[index],image=sharp(source,{animated:false,limitInputPixels:64*1024*1024,failOn:'warning'}),meta=await image.metadata();
  if(!meta.width||!meta.height||!['png','jpeg','webp','gif'].includes(meta.format??''))throw new Error('Reference image cannot be read');
  const rotated=meta.orientation!==undefined&&meta.orientation>=5&&meta.orientation<=8;
  const width=rotated?meta.height:meta.width,height=rotated?meta.width:meta.height;
  const valid=['png','jpeg'].includes(meta.format??'')&&Math.min(width,height)>=256&&Math.max(width/height,height/width)<=2.5;
  let output=source,type=meta.format==='jpeg'?'image/jpeg':'image/png';
  // Normalize orientation in the pixels: downstream model consumers may ignore EXIF.
  if(!valid||compress||(meta.orientation!==undefined&&meta.orientation!==1)){
   const factor=Math.min(2048/Math.max(width,height),Math.max(1,256/Math.min(width,height)));
   const w=Math.max(1,Math.round(width*factor)),h=Math.max(1,Math.round(height*factor));
   const canvasWidth=Math.max(256,w,Math.ceil(h/2.5)),canvasHeight=Math.max(256,h,Math.ceil(w/2.5));
   const resized=await image.rotate().resize(w,h).png().toBuffer();
   const padded=()=>sharp(resized).extend({left:Math.floor((canvasWidth-w)/2),right:Math.ceil((canvasWidth-w)/2),top:Math.floor((canvasHeight-h)/2),bottom:Math.ceil((canvasHeight-h)/2),background:{r:0,g:0,b:0,alpha:0}});
   output=await padded().png().toBuffer();type='image/png';
   if(output.length>5*MB)output=await padded().png({palette:true,colours:256}).toBuffer();
   if(output.length>5*MB)throw new Error('Reference image could not be prepared within the size limit');
  }
  result[input.role]=`data:${type};base64,${output.toString('base64')}`;
 }
 return result;
}
