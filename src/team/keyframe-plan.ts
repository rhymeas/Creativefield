import {expectedGenerationFrames,hasQualifiedDurationMapping} from '../capabilities/timing';
import type {CapabilityManifestV2} from '../capabilities/types';

/** A keyframe is an existing project image and its position in output frames. */
export type Keyframe = { assetId:string; frame:number };
export type KeyframeSegment = { startImage:string; endImage:string; startFrame:number; endFrame:number; frameCount:number; prompt:string };

/** Remove a keyframe and its adjoining prompt while keeping the timeline rooted at zero. */
export function removeKeyframe(frames:Keyframe[],prompts:string[],index:number):{frames:Keyframe[];prompts:string[]} {
  if(frames.length<=2||index<0||index>=frames.length||!Number.isInteger(index)||prompts.length!==frames.length-1)throw new Error('Cannot remove this keyframe.');
  const offset=index===0?frames[1].frame:0;
  return {frames:frames.filter((_,i)=>i!==index).map(frame=>({...frame,frame:frame.frame-offset})),prompts:prompts.filter((_,i)=>i!==(index===0?0:index===frames.length-1?index-1:index))};
}

/** Retain approximate times while keeping the timeline ordered on the 4-frame grid. */
export function rescaleKeyframes(keyframes:Keyframe[],oldFps:number,newFps:number):Keyframe[] {
  if(!Number.isFinite(oldFps)||oldFps<=0||!Number.isFinite(newFps)||newFps<=0)throw new Error('Invalid keyframe frame rate.');
  const max=Math.round(newFps*15/4)*4;
  let previous=-4;
  return keyframes.map((item,index)=>{
    const remaining=keyframes.length-index-1;
    const target=index===0?0:Math.round(item.frame/oldFps*newFps/4)*4;
    const frame=Math.max(previous+4,Math.min(max-remaining*4,target));
    previous=frame;
    return {...item,frame};
  });
}

/** Frame spans that really end on the model's final decoded frame. */
export function keyframeSpans(model:CapabilityManifestV2):number[] {
  const fps=model.timing?.fps,length=model.controls.find(c=>c.id==='length');
  if(!fps||!length||!hasQualifiedDurationMapping(model))return [];
  const min=length.min??model.timing!.minSeconds,max=Math.min(15,length.max??model.timing!.maxSeconds);
  const spans:number[]=[];
  for(let n=Math.max(1,Math.ceil(min*fps));n<=Math.floor(max*fps);n++)if(expectedGenerationFrames(model,n/fps)===n+1)spans.push(n);
  return spans;
}

/** Pick the nearest achievable keyframe positions while preserving segment order. */
export function fitKeyframesToModel(frames:Keyframe[],oldFps:number,model:CapabilityManifestV2):Keyframe[] {
  const fps=model.timing?.fps,spans=keyframeSpans(model);
  if(!fps||!Number.isFinite(oldFps)||oldFps<=0||!spans.length)throw new Error('This model has no usable keyframe timing.');
  let choices=new Map<number,{cost:number;positions:number[]}>([[0,{cost:0,positions:[0]}]]);
  for(let i=1;i<frames.length;i++){
    const next=new Map<number,{cost:number;positions:number[]}>(),target=frames[i].frame/oldFps*fps;
    for(const [start,prior] of choices)for(const span of spans){
      const position=start+span;if(position>15*fps)continue;
      const cost=prior.cost+Math.abs(position-target),old=next.get(position);
      if(!old||cost<old.cost)next.set(position,{cost,positions:[...prior.positions,position]});
    }
    choices=next;
  }
  const best=[...choices.values()].sort((a,b)=>a.cost-b.cost)[0];
  if(!best)throw new Error('These keyframes do not fit this model within 15 seconds.');
  return frames.map((frame,i)=>({...frame,frame:best.positions[i]}));
}

/** Positions which keep both adjacent segments on valid model boundaries. */
export function keyframePositions(frames:Keyframe[],index:number,model:CapabilityManifestV2):number[] {
  if(index<1||index>=frames.length)return [];
  const spans=keyframeSpans(model),valid=new Set(spans),start=frames[index-1].frame,end=frames[index+1]?.frame,limit=15*model.timing!.fps;
  return spans.map(span=>start+span).filter(position=>position<=limit&&(end===undefined||valid.has(end-position)));
}

/** Positions where one more keyframe fits: both halves of the split segment (or the appended
 * segment) must be spans the model really ends on, within the 15 second limit. */
export function keyframeInsertPositions(frames:Keyframe[],model:CapabilityManifestV2):number[] {
  if(frames.length>=4||!frames.length)return [];
  const spans=keyframeSpans(model),valid=new Set(spans),limit=15*(model.timing?.fps??0),out=new Set<number>();
  for(let i=0;i<frames.length;i++){
    const start=frames[i].frame,end=frames[i+1]?.frame;
    for(const span of spans){const position=start+span;if(end===undefined?position<=limit:position<end&&valid.has(end-position))out.add(position);}
  }
  return [...out].sort((a,b)=>a-b);
}

/** Insert an empty keyframe. A split segment keeps its prompt on the first half; the new half starts blank. */
export function insertKeyframe(frames:Keyframe[],prompts:string[],position:number):{frames:Keyframe[];prompts:string[];index:number} {
  if(frames.length>=4||!Number.isSafeInteger(position)||position<=0||frames.some(f=>f.frame===position)||prompts.length!==frames.length-1)throw new Error('Cannot add a keyframe here.');
  const after=frames.findIndex(f=>f.frame>position),index=after<0?frames.length:after;
  return {frames:[...frames.slice(0,index),{assetId:'',frame:position},...frames.slice(index)],prompts:[...prompts.slice(0,index),'',...prompts.slice(index)],index};
}

/** Rearrange the pictures; the timeline positions and the segment prompts stay where they are. */
export function moveKeyframeImage(frames:Keyframe[],from:number,to:number):Keyframe[] {
  if(from===to||from<0||to<0||from>=frames.length||to>=frames.length)return frames;
  const images=frames.map(f=>f.assetId),[moved]=images.splice(from,1);images.splice(to,0,moved);
  return frames.map((frame,i)=>({...frame,assetId:images[i]}));
}

/** Plan inclusive FLF segments. Adjacent segments share one boundary frame, which must be
 * removed once when assembling to keep the requested keyframe positions exact. */
export function planKeyframeSegments(keyframes:Keyframe[],prompts:string[]):KeyframeSegment[] {
  if(keyframes.length<2||keyframes.length>4)throw new Error("Choose two to four keyframes.");
  if(keyframes.some(k=>!k.assetId))throw new Error("Add an image to each keyframe.");
  if(keyframes.some(k=>!Number.isSafeInteger(k.frame)||k.frame<0)||keyframes[0].frame!==0)throw new Error("The first keyframe must start at frame zero.");
  if(prompts.length!==keyframes.length-1)throw new Error("Segment prompts do not match the keyframes.");
  return keyframes.slice(1).map((end,index)=>{
    const start=keyframes[index],prompt=prompts[index].trim();
    if(end.frame<=start.frame)throw new Error("Keyframes must be in increasing order.");
    return {startImage:start.assetId,endImage:end.assetId,startFrame:start.frame,endFrame:end.frame,frameCount:end.frame-start.frame+1,prompt};
  });
}

/** A final keyframe must be the model's actual final frame, not an earlier cut. */
export function qualifyKeyframeTiming(model:CapabilityManifestV2,segments:KeyframeSegment[],outputFps:number){
 const length=model.controls.find(c=>c.id==='length'),timing=model.timing;
 if(!model.inputs.some(p=>p.id==='start_image'&&p.type==='image')||!model.inputs.some(p=>p.id==='end_image'&&p.type==='image')||!length||!timing||!hasQualifiedDurationMapping(model))throw new Error('Choose a first-and-last-frame model with verified timing.');
 if(!Number.isFinite(outputFps)||outputFps!==timing.fps)throw new Error('Use the model frame rate to keep keyframes on their exact frames.');
 return segments.map((segment,index)=>{
  const seconds=(segment.frameCount-1)/outputFps,min=length.min??timing.minSeconds,max=length.max??timing.maxSeconds;
  if(seconds<min||seconds>max)throw new Error(`Segment ${index+1} must be between ${min} and ${max} seconds.`);
  if(expectedGenerationFrames(model,seconds)!==segment.frameCount)throw new Error(`Segment ${index+1} cannot end on that frame with this model.`);
  return {...segment,controlSeconds:seconds,assemblyStartFrame:index?1:0,assemblyFrames:segment.frameCount-(index?1:0)};
 });
}
