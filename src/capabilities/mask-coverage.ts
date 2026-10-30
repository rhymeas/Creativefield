export type MaskCoverageFrame={selectedPixels:number;bounds:{left:number;top:number;width:number;height:number}|null};
export type MaskCoverage={version:1;maskSha256:string;width:number;height:number;frames:MaskCoverageFrame[]};

/** Exact decoded-pixel coverage, not tracking confidence or a semantic quality score. */
export class MaskCoverageBuilder{
  private pixel=0;private selected=0;private left=Infinity;private right=-1;private top=Infinity;private bottom=-1;private frames:MaskCoverageFrame[]=[];
  constructor(readonly width:number,readonly height:number,readonly frameCount:number){if(![width,height,frameCount].every(Number.isInteger)||width<16||height<16||width>832||height>832||width*height>399360||frameCount<17||frameCount>81||(frameCount-1)%4)throw Error("Unsupported mask coverage geometry");}
  add(selected:boolean){
    if(this.frames.length>=this.frameCount)throw Error("Unexpected mask coverage pixels");
    if(selected){const x=this.pixel%this.width,y=Math.floor(this.pixel/this.width);this.selected++;this.left=Math.min(this.left,x);this.right=Math.max(this.right,x);this.top=Math.min(this.top,y);this.bottom=Math.max(this.bottom,y);}
    if(++this.pixel===this.width*this.height){this.frames.push({selectedPixels:this.selected,bounds:this.selected?{left:this.left,top:this.top,width:this.right-this.left+1,height:this.bottom-this.top+1}:null});this.pixel=0;this.selected=0;this.left=this.top=Infinity;this.right=this.bottom=-1;}
  }
  finish(maskSha256:string):MaskCoverage{if(this.pixel||this.frames.length!==this.frameCount||!/^[a-f0-9]{64}$/.test(maskSha256))throw Error("Incomplete mask coverage scan");return {version:1,maskSha256,width:this.width,height:this.height,frames:this.frames};}
}
export function validatedMaskCoverage(value:unknown,geometry:{width:number;height:number;frames:number},maskSha256:string|undefined):MaskCoverage|null{
  const r=value as MaskCoverage,pixels=geometry.width*geometry.height;
  if(!r||r.version!==1||!maskSha256||!/^[a-f0-9]{64}$/.test(maskSha256)||r.maskSha256!==maskSha256||r.width!==geometry.width||r.height!==geometry.height||!Array.isArray(r.frames)||r.frames.length!==geometry.frames)return null;
  for(const f of r.frames){if(!f||!Number.isSafeInteger(f.selectedPixels)||f.selectedPixels<0||f.selectedPixels>pixels)return null;const b=f.bounds;if(!f.selectedPixels){if(b!==null)return null;}else if(!b||![b.left,b.top,b.width,b.height].every(Number.isSafeInteger)||b.left<0||b.top<0||b.width<=0||b.height<=0||b.left+b.width>r.width||b.top+b.height>r.height||b.width*b.height<f.selectedPixels)return null;}
  return r;
}
export function flaggedMaskFrames(report:MaskCoverage){const pixels=report.width*report.height;return report.frames.flatMap((f,i)=>f.selectedPixels===0||f.selectedPixels===pixels?[i]:[]);}
