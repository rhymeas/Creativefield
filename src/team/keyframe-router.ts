import type {RouterModel} from '../capabilities/router-models';
import type {Keyframe} from './keyframe-plan';

/** One Comfy Router run per segment: keyframe n is the first frame, keyframe n+1 the last. Seedance takes whole
    seconds within its limits, so each segment's length is rounded into them; an empty prompt gets a plain
    transition sentence, as the model needs words. */
export function routerSegmentRuns(m:RouterModel,projectId:string,frames:Keyframe[],prompts:string[],fps:number){
 if(frames.length<2||frames.some(f=>!f.assetId))throw new Error('Add a picture to every keyframe.');
 const duration=m.controls.find(c=>c.id==='duration'),min=duration?.min??1,max=duration?.max??30;
 const defaults=Object.fromEntries(m.controls.map(c=>[c.id,c.default]));
 return frames.slice(1).map((end,i)=>{
  const seconds=(end.frame-frames[i].frame)/fps;
  return {projectId,idempotencyKey:crypto.randomUUID(),capabilityId:m.id,version:'1.0.0',routeId:'router',
   inputs:{start_image:frames[i].assetId,end_image:end.assetId},
   controls:{...defaults,prompt:(prompts[i]??'').trim()||'A smooth, natural transition from the first frame to the last frame.',duration:Math.min(max,Math.max(min,Math.round(seconds)))},
   audioPolicy:'mute' as const,consent:{cloudCredits:true as const}};
 });
}
