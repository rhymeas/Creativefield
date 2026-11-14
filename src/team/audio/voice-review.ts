import type {Asset} from "../api";
import {secondsToWanFrames} from "../../workflow/build";
export type VoiceProvenance={capability_id:string;invocation:{controls:Record<string,unknown>;inputs:Record<string,string>;audioPolicy?:string};inputs:{id:string;role:string;sha256:string}[];outputs:{id:string}[]};
/** A result is reviewed against its submitted voice window, never the current composer draft. */
export function voiceReviewWindow(p:VoiceProvenance,source:Asset,output:Asset,projectId:string,outputId:string){
  const input=p.inputs?.find(a=>a.role==="source_audio"),start=Number(p.invocation?.controls.audio_start??0),length=Number(p.invocation?.controls.length),rate=String(output.metadata?.frameRate??"").split("/"),fps=Number(rate[0])/Number(rate[1]??1),actualDuration=Number(output.metadata?.durationSeconds);
  if(p.capability_id!=="wan21-infinitetalk"||!input||input.id!==source.id||input.sha256!==source.sha256||p.invocation?.inputs.source_audio!==source.id||source.project_id!==projectId||output.project_id!==projectId||output.id!==outputId||!p.outputs?.some(a=>a.id===outputId)||source.media_type!=="audio"||!["audio/wav","audio/x-wav"].includes(source.content_type)||!output.content_type.startsWith("video/")||!Number.isFinite(start)||start<0||start>59||!Number.isFinite(length)||length<1||length>3.2||fps!==25)throw Error("The result and its submitted voice window do not match.");
  const duration=secondsToWanFrames(length,25)/25;if(!Number.isFinite(actualDuration)||Math.abs(actualDuration-duration)>1/25+.025)throw Error("The result duration does not match its submitted voice window.");
  return {startSeconds:start,durationSeconds:duration,fps:25};
}
