import {workspacePath,type Call} from './api';
import type {ShotPayload} from './storyboard-state';

/** Ask the local vision reader only about anchors that border an empty prompt. */
export async function fillKeyframePrompts(shots:ShotPayload[],call:Call,workspaceId:string,projectId:string,workerId:string){
 const needed=new Set<string>();
 for(const shot of shots)if(!shot.prompt.trim())for(const asset of shot.assets)needed.add(asset.assetId);
 if(!needed.size)return {shots,fallback:false};

 const anchors=[...needed].map((assetId,index)=>({assetId,label:`@Image ${index+1}`,where:`keyframe ${index+1}`}));
 const answer=await call<{looks:Record<string,string>}>(workspacePath(workspaceId,'reference-describe'),'POST',{
  projectId,workerId,purpose:'keyframe',people:anchors,
 }).catch(()=>null);
 const looks=new Map(anchors.map(anchor=>[anchor.assetId,answer?.looks?.[anchor.label]?.trim()]));
 let fallback=false;
 const completed=shots.map(shot=>{
  if(shot.prompt.trim())return shot;
  const first=looks.get(shot.assets.find(asset=>asset.role==='start_image')?.assetId??'');
  const last=looks.get(shot.assets.find(asset=>asset.role==='end_image')?.assetId??'');
  fallback||=!first||!last;
  const start=first?`Open on the first reference: ${first}.`:'Open on the exact composition of the first reference.';
  const end=last?`Settle into the final reference: ${last}.`:'Settle naturally into the exact composition of the final reference.';
  const motion=shot.durationSeconds<3
   ?'Connect them with one clear, purposeful movement suggested by the images, easing into the final pose.'
   :'Build a small visual beat: anticipation, a motivated movement through the scene, and a deliberate settle into the final pose.';
  const identity='Keep faces, wardrobe and existing brand marks consistent throughout. Preserve readable lettering and its placement.';
  const sound=shot.settings.audioPolicy==='replace'?' Add subtle ambience and movement sounds that fit the scene.':'';
  return {...shot,prompt:`${start} ${motion} ${end} ${identity}${sound}`};
 });
 return {shots:completed,fallback};
}
