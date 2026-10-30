import {readFile,stat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {voiceWav,MAX_VOICE_WAV_BYTES} from "./voice-wav";
import {HttpError} from "./auth";
import type {CapabilityManifestV2,Invocation} from "../src/capabilities/types";
import {secondsToWanFrames} from "../src/workflow/build";
/** Reuses the bounded recorder format, avoiding unbounded compressed-audio decoding. */
export async function validateVoiceInput(file:string,sha256:string,start:number,duration:number){
  if((await stat(file)).size>MAX_VOICE_WAV_BYTES)throw new HttpError(422,"Use a saved microphone take or a mono PCM16 WAV of at most 60 seconds.");
  const bytes=await readFile(file),record=voiceWav(bytes);
  if(createHash("sha256").update(bytes).digest("hex")!==sha256)throw new HttpError(422,"The saved audio no longer matches its source hash.");
  if(!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<=0||start+duration>record.durationSeconds+.025)
    throw new HttpError(422,"The audio is shorter than the requested window. Shorten Duration or choose an earlier audio start.");
  return record;
}
/** Recheck the bound stored voice before any worker upload, including queued-time disk changes. */
export async function verifyVoiceInput(manifest:CapabilityManifestV2,invocation:Invocation,assets:{id:string;role:string;project_id:string|null;media_type:string;content_type:string;sha256:string;storage_key:string}[],projectId:string,file:(key:string)=>Promise<string>){
  if(!manifest.voiceContract)return;
  const audio=assets.find(a=>a.role===manifest.voiceContract!.audioInput);
  if(!audio||audio.id!==invocation.inputs[manifest.voiceContract.audioInput]||audio.project_id!==projectId||audio.media_type!=="audio"||!["audio/wav","audio/x-wav"].includes(audio.content_type)||!manifest.timing)throw new HttpError(422,"The submitted voice take no longer matches this project and input.");
  const duration=secondsToWanFrames(Number(invocation.controls.length),manifest.timing.fps)/manifest.timing.fps;
  await validateVoiceInput(await file(audio.storage_key),audio.sha256,Number(invocation.controls.audio_start??0),duration);
}
