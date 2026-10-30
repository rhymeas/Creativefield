import sharp from "sharp";
import type {PreservationQA} from "../src/capabilities/edit-preservation";

export const PRESERVATION_LIMIT=4194304;
export const MAX_UPSCALED_CROP_PIXELS=16777216;
/** Conservative pixel-budget estimate for the pinned upstream forced-size crop.
 * This is geometry, not measured RAM/VRAM use. */
export function estimateCropCanvasPixels(width:number,height:number,bounds:{left:number;top:number;right:number;bottom:number},context:number,forceWidth:number,forceHeight:number){
  const cropWidth=Math.min(width,bounds.right+1+context)-Math.max(0,bounds.left-context);
  const cropHeight=Math.min(height,bounds.bottom+1+context)-Math.max(0,bounds.top-context);
  const scale=Math.max(1,forceWidth/cropWidth,forceHeight/cropHeight);
  return Math.ceil(width*scale)*Math.ceil(height*scale);
}

/** Observes output drift; never edits or blends model pixels. Klein stays upstream. */
export async function measurePreservation(original:Buffer| string,final:Buffer|string,effectiveMask:Buffer|string,includeMask=false):Promise<{qa:PreservationQA;driftPng?:Buffer}>{
  const decode=(input:Buffer|string)=>sharp(input,{limitInputPixels:PRESERVATION_LIMIT,failOn:"warning",animated:false})
    .toColourspace("srgb").removeAlpha().raw().toBuffer({resolveWithObject:true});
  const [a,b,m]=await Promise.all([decode(original),decode(final),decode(effectiveMask)]);
  const {width,height}=a.info;
  if([b,m].some(image=>image.info.width!==width||image.info.height!==height)||[a,b,m].some(image=>image.info.channels!==3))
    throw new Error("Preservation QA requires aligned RGB rasters");
  let protectedPixels=0,changedProtectedPixels=0,maxChannelDelta=0,totalDelta=0;
  const drift=includeMask?Buffer.alloc(width*height):undefined;
  for(let i=0;i<width*height;i++){
    const p=i*3;if(m.data[p]>0)continue;
    protectedPixels++;
    const d0=Math.abs(a.data[p]-b.data[p]),d1=Math.abs(a.data[p+1]-b.data[p+1]),d2=Math.abs(a.data[p+2]-b.data[p+2]);
    const delta=Math.max(d0,d1,d2);maxChannelDelta=Math.max(maxChannelDelta,delta);totalDelta+=d0+d1+d2;
    if(delta>2){changedProtectedPixels++;if(drift)drift[i]=255;}
  }
  const driftPercent=protectedPixels?changedProtectedPixels/protectedPixels*100:null;
  return {qa:{method:"srgb8-max-channel-v1",channelTolerance:2,excludedMask:"effective mask > 0/255",driftTolerancePercent:.1,
    protectedPixels,changedProtectedPixels,driftPercent,maxChannelDelta,meanChannelDelta:protectedPixels?totalDelta/(protectedPixels*3):null,withinTolerance:driftPercent!==null&&driftPercent<=.1,width,height},
    ...(drift?{driftPng:await sharp(drift,{raw:{width,height,channels:1}}).png().toBuffer()}:{}),};
}
