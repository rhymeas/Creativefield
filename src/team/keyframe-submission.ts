import type {CapabilityManifestV2} from '../capabilities/types';
import {defaultDraft} from './state';
import {planKeyframeSegments,qualifyKeyframeTiming,type Keyframe} from './keyframe-plan';

/** Keep the same render key whenever acceptance might still be uncertain. */
export function definitiveKeyframeRejection(status:number):boolean {
 return status>=400&&status<500&&![401,408,409,429].includes(status);
}

/** Board creation has no idempotency key; only a definite rejection is safe to retry. */
export function uncertainKeyframeCreation(status:number|undefined):boolean {
 return status===undefined||status<400||status>=500||[408,409,429].includes(status);
}

/** Translate visible keyframes into the existing storyboard's first/last-frame shots. */
export function buildKeyframeShots(model:CapabilityManifestV2,frames:Keyframe[],prompts:string[],fps:number,options?:{orientation:'landscape'|'portrait';turbo:boolean}){
 const segments=qualifyKeyframeTiming(model,planKeyframeSegments(frames,prompts),fps);
 const controls={...defaultDraft(model).controls};delete controls.prompt;delete controls.length;
 if(options){
  const resolution=model.resolutions?.[options.orientation];
  if(resolution&&'width' in controls&&'height' in controls){controls.width=resolution.width;controls.height=resolution.height;}
  const ratio=model.controls.find(c=>c.id==='aspect_ratio');
  const prefix=options.orientation==='landscape'?'16:9':'9:16';
  const matching=ratio?.options?.find(value=>typeof value==='string'&&value.startsWith(prefix));
  if(matching!==undefined)controls.aspect_ratio=matching;
  if(model.controls.some(c=>c.id==='turbo'))controls.turbo=options.turbo;
 }
 const shots=segments.map(s=>({prompt:s.prompt,durationSeconds:s.controlSeconds,settings:{generation:{capabilityId:model.id,version:model.version,routeId:'local' as const,controls},audioPolicy:'mute' as const,elementInputs:{}},assets:[{role:'start_image',assetId:s.startImage},{role:'end_image',assetId:s.endImage}]}));
 const portrait=options?.orientation==='portrait';
 // H3's ResolutionSelector uses binary megapixels and rounds each dimension to 32 pixels.
 // Match its output so assembly does not shrink every generated segment to 480p.
 if(model.id==='h3-flf2v'){
  const megapixels=Number(controls.megapixels),ratio=portrait?9/16:16/9;
  if(!Number.isFinite(megapixels)||megapixels<=0)throw new Error('This model has no valid output size.');
  const width=Math.round(Math.sqrt(megapixels*1024*1024*ratio)/32)*32;
  const height=Math.round(Math.sqrt(megapixels*1024*1024/ratio)/32)*32;
  return {shots,width,height};
 }
 return {shots,width:Number(controls.width??(portrait?480:832)),height:Number(controls.height??(portrait?832:480))};
}
