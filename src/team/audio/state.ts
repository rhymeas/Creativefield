import type {Asset} from "../api";

export type AudioOperationKind="extract"|"preserve"|"mute"|"replace"|"mix";
export type AudioDraft={
  operation:AudioOperationKind;videoAssetId:string;audioAssetId:string;
  videoStreamIndex:string;sourceAudioStreamIndex:string;audioStreamIndex:string;
  shortAudio:"reject"|"pad_silence";longAudio:"reject"|"trim";
  offsetSeconds:string;audioStartSeconds:string;audioEndSeconds:string;
  sourceGainDb:string;audioGainDb:string;
};

export const audioOperationLabels:Record<AudioOperationKind,string>={extract:"Extract audio",preserve:"Preserve source audio",mute:"Remove audio",replace:"Replace audio",mix:"Mix source and external audio"};
export const defaultAudioDraft:AudioDraft={operation:"preserve",videoAssetId:"",audioAssetId:"",videoStreamIndex:"0",sourceAudioStreamIndex:"0",audioStreamIndex:"0",shortAudio:"pad_silence",longAudio:"trim",offsetSeconds:"0",audioStartSeconds:"0",audioEndSeconds:"",sourceGainDb:"0",audioGainDb:"0"};
export const needsSourceAudio=(kind:AudioOperationKind)=>kind==="extract"||kind==="preserve"||kind==="mix";
export const needsExternalAudio=(kind:AudioOperationKind)=>kind==="replace"||kind==="mix";
export const needsDurationPolicy=(kind:AudioOperationKind)=>kind==="preserve"||kind==="replace"||kind==="mix";

const number=(value:string)=>value.trim()===""?NaN:Number(value);
const integer=(value:string)=>Number.isInteger(number(value))&&number(value)>=0;
const finite=(value:string,min:number,max:number)=>Number.isFinite(number(value))&&number(value)>=min&&number(value)<=max;

export function audioDraftIssues(draft:AudioDraft,assets:Asset[]):string[]{
  const issues:string[]=[],video=assets.find(asset=>asset.id===draft.videoAssetId&&asset.media_type==="video"),audio=assets.find(asset=>asset.id===draft.audioAssetId&&asset.media_type==="audio");
  if(!video?.sha256)issues.push("Choose a project video with a recorded SHA-256.");
  if(!integer(draft.videoStreamIndex))issues.push("Video stream index must be a whole number.");
  if(needsSourceAudio(draft.operation)&&!integer(draft.sourceAudioStreamIndex))issues.push("Source audio stream index must be a whole number.");
  if(needsExternalAudio(draft.operation)&&!audio?.sha256)issues.push("Choose a project audio asset with a recorded SHA-256.");
  if(needsExternalAudio(draft.operation)&&!integer(draft.audioStreamIndex))issues.push("External audio stream index must be a whole number.");
  if(needsExternalAudio(draft.operation)){
    if(!finite(draft.offsetSeconds,0,3600))issues.push("Offset must be between 0 and 3600 seconds.");
    if(!finite(draft.audioStartSeconds,0,3600))issues.push("Trim start must be between 0 and 3600 seconds.");
    if(draft.audioEndSeconds!==""&&(!finite(draft.audioEndSeconds,0,3600)||number(draft.audioEndSeconds)<=number(draft.audioStartSeconds)))issues.push("Trim end must be after trim start.");
  }
  if((draft.operation==="preserve"||draft.operation==="mix")&&!finite(draft.sourceGainDb,-60,24))issues.push("Source gain must be between −60 and +24 dB.");
  if(needsExternalAudio(draft.operation)&&!finite(draft.audioGainDb,-60,24))issues.push("External gain must be between −60 and +24 dB.");
  return issues;
}

export function buildAudioRequest(draft:AudioDraft,assets:Asset[],projectId:string,idempotencyKey:string){
  const issues=audioDraftIssues(draft,assets);if(issues.length)throw new Error(issues[0]);
  const video=assets.find(asset=>asset.id===draft.videoAssetId)!,audio=assets.find(asset=>asset.id===draft.audioAssetId);
  const request:Record<string,unknown>={projectId,idempotencyKey,operation:draft.operation,videoAssetId:video.id,expectedVideoSha256:video.sha256,videoStreamIndex:number(draft.videoStreamIndex),loudness:{mode:"measure_only"}};
  if(needsSourceAudio(draft.operation))request.sourceAudioStreamIndex=number(draft.sourceAudioStreamIndex);
  if(needsExternalAudio(draft.operation)){
    Object.assign(request,{audioAssetId:audio!.id,expectedAudioSha256:audio!.sha256,audioStreamIndex:number(draft.audioStreamIndex),offsetSeconds:number(draft.offsetSeconds),audioStartSeconds:number(draft.audioStartSeconds),audioGainDb:number(draft.audioGainDb)});
    if(draft.audioEndSeconds!=="")request.audioEndSeconds=number(draft.audioEndSeconds);
  }
  if(needsDurationPolicy(draft.operation))Object.assign(request,{shortAudio:draft.shortAudio,longAudio:draft.longAudio});
  if(draft.operation==="preserve"||draft.operation==="mix")request.sourceGainDb=number(draft.sourceGainDb);
  return request;
}

export type AudioRequirements={state:"ready"|"install_required";missing:string[];versions:{ffmpeg:string|null;ffprobe:string|null};instructions:string};
export type AudioOperation={id:string;project_id:string;created_by:string;operation:AudioOperationKind;state:string;video_asset_id:string;audio_asset_id:string|null;output_asset_id:string;attempt:number;receipt?:Record<string,unknown>|null;error?:string|null;created_at:string;updated_at:string};
export const audioOperationActive=(state:string)=>!["succeeded","failed","canceled"].includes(state);
