import {planOpenJutsuShots, type OpenJutsuShotWindow} from "./openjutsu-shot-plan";
import type {OpenJutsuTracking} from "./openjutsu-tracking";

/** Internal experimental coordinator. It does not submit jobs or persist state by itself.
 * All source intervals are in normalized 24 fps frames and use an exclusive end. */
export type SwapSegment = {sourceStart:number; sourceEnd:number; output:string; outputStart:number};
export type ConfirmedCuts = {frames:number[]; evidence:"confirmed"};
export type SwapRender = {output:string; outputStart:number; outputFrames:number; tracking:OpenJutsuTracking; targetConfirmed:boolean};
export type SwapEvent =
  | {kind:"reference"; reference:string}
  | {kind:"target"; startFrame:number; target:string}
  | {kind:"render"; startFrame:number; endFrame:number; attempt:number; output:string}
  | {kind:"accepted"; segment:SwapSegment}
  | {kind:"tracking_lost"; atFrame:number}
  | {kind:"assembled"; output:string};

export type SwapOperations = {
  /** Must preserve source identity or reject an ambiguous reference. */
  prepareReference:(signal:AbortSignal)=>Promise<string>;
  /** Raw FFmpeg candidates are not confirmed cuts and must not be passed here. */
  confirmCuts:(signal:AbortSignal)=>Promise<ConfirmedCuts>;
  /** Re-identify the selected person at this frame, or throw on ambiguity. */
  locateTarget:(startFrame:number, signal:AbortSignal)=>Promise<string>;
  /** Implementations must remove any padded frames using outputStart/outputFrames. */
  render:(args:{window:OpenJutsuShotWindow;reference:string;target:string;attempt:number;signal:AbortSignal})=>Promise<SwapRender>;
  /** Original audio source is passed explicitly; the implementer must mux it continuously. */
  assemble:(args:{segments:SwapSegment[];originalAudioSource:string;frameCount:number;fps:24;signal:AbortSignal})=>Promise<{output:string;frames:number;audioSource:string}>;
  onEvent?:(event:SwapEvent)=>Promise<void>|void;
};

export class OpenJutsuOrchestrationError extends Error {
  constructor(message:string, readonly completed:SwapSegment[]){super(message);this.name="OpenJutsuOrchestrationError";}
}

function validateCoverage(segments:SwapSegment[],frameCount:number):void{
  let frame=0;
  for(const segment of segments){
    if(segment.sourceStart!==frame||segment.sourceEnd<=frame||segment.sourceEnd>frameCount||!segment.output||!Number.isSafeInteger(segment.outputStart)||segment.outputStart<0)
      throw new Error("Rendered segments do not cover the source timeline exactly.");
    frame=segment.sourceEnd;
  }
  if(frame!==frameCount)throw new Error("Rendered segments do not cover the source timeline exactly.");
}

/** Sequential and bounded by the caller's explicit render budget. On tracking loss the valid
 * prefix is retained and only the remainder is retried with a freshly located target. No
 * output is assembled if tracking, target identity or frame coverage cannot be established. */
export async function orchestrateOpenJutsu(input:{frameCount:number;originalAudioSource:string;maxRenders:number;maxWindowFrames?:number;signal:AbortSignal},ops:SwapOperations):Promise<{output:string;segments:SwapSegment[]}> {
  const accepted:SwapSegment[]=[];
  const fail=(message:string):never=>{throw new OpenJutsuOrchestrationError(message,accepted.map(segment=>({...segment})));};
  const check=()=>{if(input.signal.aborted)fail("OpenJutsu was canceled; completed segments remain available.");};
  const emit=async(event:SwapEvent)=>{check();await ops.onEvent?.(event);check();};
  if(!input.originalAudioSource||!Number.isSafeInteger(input.maxRenders)||input.maxRenders<1||input.maxRenders>128)fail("An original audio source and bounded render budget are required.");
  check();
  const reference=await ops.prepareReference(input.signal);check();
  if(!reference)fail("A single, unambiguous character reference is required.");
  await emit({kind:"reference",reference});
  const cuts=await ops.confirmCuts(input.signal);check();
  if(!cuts||cuts.evidence!=="confirmed"||!Array.isArray(cuts.frames))fail("Scene cuts could not be confirmed.");
  let windows:OpenJutsuShotWindow[];
  try{windows=planOpenJutsuShots(input.frameCount,cuts.frames,input.maxWindowFrames);}catch{fail("The source timeline or scene cuts are invalid.");}
  let renders=0;
  for(const window of windows!){
    let cursor=window.startFrame,attempt=0;
    while(cursor<window.endFrame){
      check();if(renders>=input.maxRenders)fail("The render budget was reached before the whole video could be verified.");
      const target=await ops.locateTarget(cursor,input.signal);check();
      if(!target)fail(`The selected person could not be identified at frame ${cursor}.`);
      await emit({kind:"target",startFrame:cursor,target});
      const current={...window,startFrame:cursor,startsAtCut:cursor===window.startFrame&&window.startsAtCut};
      const result=await ops.render({window:current,reference,target,attempt,signal:input.signal});renders++;check();
      if(!result?.output||!Number.isSafeInteger(result.outputStart)||result.outputStart<0||!Number.isSafeInteger(result.outputFrames)||result.outputFrames<result.outputStart+(window.endFrame-cursor))fail("The rendered clip does not contain the requested source frames.");
      await emit({kind:"render",startFrame:cursor,endFrame:window.endFrame,attempt,output:result.output});
      if(result.targetConfirmed!==true)fail("The rendered target could not be confirmed.");
      if(!result.tracking||!["continuous","lost"].includes(result.tracking.state))fail("Tracking status is unavailable; the result was not assembled.");
      const lost=result.tracking.lostFrames;
      if(!Array.isArray(lost)||lost.some(frame=>!Number.isSafeInteger(frame)||frame<0||frame>=window.endFrame-cursor)||result.tracking.state==="continuous"&&lost.length||result.tracking.state==="lost"&&!lost.length)fail("Tracking report does not match the rendered interval.");
      const firstLoss=lost.length?Math.min(...lost):window.endFrame-cursor;
      if(firstLoss>0){
        const segment={sourceStart:cursor,sourceEnd:cursor+firstLoss,output:result.output,outputStart:result.outputStart};
        accepted.push(segment);await emit({kind:"accepted",segment});cursor+=firstLoss;
      }
      if(lost.length){await emit({kind:"tracking_lost",atFrame:cursor});attempt++;}
    }
  }
  try{validateCoverage(accepted,input.frameCount);}catch(e){fail((e as Error).message);}
  check();const finished=await ops.assemble({segments:accepted.map(segment=>({...segment})),originalAudioSource:input.originalAudioSource,frameCount:input.frameCount,fps:24,signal:input.signal});check();
  if(!finished?.output||finished.frames!==input.frameCount||finished.audioSource!==input.originalAudioSource)fail("The assembled video did not preserve the complete timeline and original audio source.");
  await emit({kind:"assembled",output:finished.output});
  return {output:finished.output,segments:accepted};
}
