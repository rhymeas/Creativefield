// AUD-01 contracts only. These types define provenance shapes for a future
// voice pipeline. Nothing here renders, synthesizes or qualifies a route.

export type ScriptLine={speakerCharacterId:string;text:string;deliveryNote?:string};
export type ScriptRevisionV1={kind:"script_revision_v1";id:string;projectId:string;revision:number;language:string;lines:ScriptLine[];createdBy:string;createdAt:string};
export type VoiceElementRevisionV1={kind:"voice_element_revision_v1";id:string;projectId:string;revision:number;engine:string;model:string;sourceType:"recorded"|"uploaded"|"generated";sourceHashes:string[];consentAttested:boolean;createdBy:string;createdAt:string};
export type VoiceRoute={id:string;execution:"local"|"hosted";model:string;license:string;languages:string[];ready:boolean};
export type VoiceTakeV1={kind:"voice_take_v1";id:string;projectId:string;scriptRevisionId:string;voiceElementRevisionId:string;routeId:string;parameters:Record<string,string|number|boolean>;durationSeconds:number;sampleRate:number;channels:number;outputHash:string;review:"pending"|"approved"|"rejected"};
export type PerformancePlanV1={kind:"performance_plan_v1";id:string;projectId:string;voiceTakeId:string;visualAssetId:string;targetDurationSeconds:number;frameRate:number;language:string;lipSyncRouteId:string};

const nonEmpty=(value:unknown):value is string=>typeof value==="string"&&value.trim().length>0;
const positive=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value)&&value>0;

export function scriptRevisionErrors(value:Partial<ScriptRevisionV1>):string[]{
  const errors:string[]=[];
  if(!nonEmpty(value.id))errors.push("Script revision id is required.");
  if(!nonEmpty(value.projectId))errors.push("Script revision project is required.");
  if(!positive(value.revision))errors.push("Script revision number must be positive.");
  if(!nonEmpty(value.language))errors.push("Script language is required.");
  if(!Array.isArray(value.lines)||!value.lines.length)errors.push("Script needs at least one line.");
  else value.lines.forEach((line,index)=>{
    if(!nonEmpty(line.speakerCharacterId))errors.push(`Line ${index+1} needs a speaker character.`);
    if(!nonEmpty(line.text))errors.push(`Line ${index+1} needs text.`);
  });
  if(!nonEmpty(value.createdBy)||!nonEmpty(value.createdAt))errors.push("Script revision provenance is required.");
  return errors;
}

export function voiceElementErrors(value:Partial<VoiceElementRevisionV1>):string[]{
  const errors:string[]=[];
  if(!nonEmpty(value.id))errors.push("Voice element id is required.");
  if(!nonEmpty(value.projectId))errors.push("Voice element project is required.");
  if(!positive(value.revision))errors.push("Voice element revision must be positive.");
  if(!nonEmpty(value.engine)||!nonEmpty(value.model))errors.push("Voice engine and model must be named.");
  if(!Array.isArray(value.sourceHashes)||!value.sourceHashes.length)errors.push("Voice source hashes are required.");
  if(value.consentAttested!==true)errors.push("Consent and rights attestation is required.");
  if(!nonEmpty(value.createdBy)||!nonEmpty(value.createdAt))errors.push("Voice element provenance is required.");
  return errors;
}

export function voiceTakeErrors(value:Partial<VoiceTakeV1>,route?:VoiceRoute):string[]{
  const errors:string[]=[];
  if(!nonEmpty(value.id))errors.push("Voice take id is required.");
  if(!nonEmpty(value.scriptRevisionId))errors.push("Voice take needs an exact script revision.");
  if(!nonEmpty(value.voiceElementRevisionId))errors.push("Voice take needs an exact voice element revision.");
  if(!route)errors.push("Voice route is unknown.");
  else{
    if(route.id!==value.routeId)errors.push("Voice take route does not match its route definition.");
    if(!route.ready)errors.push("Voice route is not qualified as ready.");
    if(!nonEmpty(route.model)||!nonEmpty(route.license))errors.push("Voice route must name its model and license.");
  }
  if(!positive(value.durationSeconds))errors.push("Voice take duration must be positive.");
  if(!positive(value.sampleRate)||!positive(value.channels))errors.push("Voice take format must be recorded.");
  if(!nonEmpty(value.outputHash))errors.push("Voice take output hash is required.");
  return errors;
}

export function performancePlanErrors(value:Partial<PerformancePlanV1>,take?:VoiceTakeV1):string[]{
  const errors:string[]=[];
  if(!nonEmpty(value.id))errors.push("Performance plan id is required.");
  if(!take)errors.push("Performance plan needs an existing voice take.");
  else{
    if(take.id!==value.voiceTakeId)errors.push("Performance plan take does not match.");
    if(take.review!=="approved")errors.push("Only a manually approved voice take can enter a performance plan.");
    if(take.projectId!==value.projectId)errors.push("Performance plan and voice take projects differ.");
  }
  if(!nonEmpty(value.visualAssetId))errors.push("Performance plan needs a target visual asset.");
  if(!positive(value.targetDurationSeconds))errors.push("Performance target duration must be positive.");
  if(!positive(value.frameRate))errors.push("Performance frame rate must be positive.");
  if(!nonEmpty(value.language))errors.push("Performance language is required.");
  if(!nonEmpty(value.lipSyncRouteId))errors.push("Performance plan needs a separately selected lip-sync route.");
  return errors;
}
