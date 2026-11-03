/** Hide the selected subject before an image-edit model sees it, while leaving
 * the surrounding crop intact. The mask is an opaque black/white image. */
export function prefillRemoval(image:ImageData,mask:ImageData):void {
  if(image.width!==mask.width||image.height!==mask.height)throw new Error("Removal mask dimensions do not match the image.");
  const pixels=image.data,selected=mask.data;
  let r=0,g=0,b=0,count=0;
  for(let i=0;i<pixels.length;i+=16){
    if(selected[i]<8&&pixels[i+3]>0){r+=pixels[i];g+=pixels[i+1];b+=pixels[i+2];count++;}
  }
  if(!count)throw new Error("Include some surrounding background in the selection context.");
  r/=count;g/=count;b/=count;
  for(let i=0;i<pixels.length;i+=4){
    const a=selected[i]/255;if(!a)continue;
    pixels[i]=pixels[i]*(1-a)+r*a;pixels[i+1]=pixels[i+1]*(1-a)+g*a;pixels[i+2]=pixels[i+2]*(1-a)+b*a;
  }
}
