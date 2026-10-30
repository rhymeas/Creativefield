import type {CapabilityManifestV2} from "../src/capabilities/types";
import {expectedGenerationFrames,hasQualifiedDurationMapping,secondsForSourceFrames} from "../src/capabilities/timing";
import {HttpError} from "./auth";

/** Plan an exact output cut and enough source frames without changing legacy rounding. */
export function storyboardTiming(manifest:CapabilityManifestV2,seconds:number,outputFps:number){
  const length=manifest.controls.find(c=>c.id==="length"),timing=manifest.timing;
  if(!length||!timing||!hasQualifiedDurationMapping(manifest))
    throw new HttpError(422,"This storyboard workflow has no qualified frame-duration binding");
  const min=length.min??timing.minSeconds,max=length.max??timing.maxSeconds;
  if(!Number.isFinite(outputFps)||outputFps<=0)throw new HttpError(422,"Invalid assembly frame rate");
  if(!Number.isFinite(seconds)||seconds<min||seconds>max)throw new HttpError(422,`Shot duration must be between ${min} and ${max} seconds`);
  const frames=Math.round(seconds*outputFps),effectiveDurationSeconds=frames/outputFps;
  if(frames<1)throw new HttpError(422,"Shot duration must include at least one output frame");
  const requiredSourceFrames=Math.ceil(effectiveDurationSeconds*timing.fps-1e-9);
  let controlSeconds=seconds,generationFrames=expectedGenerationFrames(manifest,controlSeconds);
  if(generationFrames<requiredSourceFrames){
    controlSeconds=Math.min(max,Math.max(min,secondsForSourceFrames(manifest,requiredSourceFrames)));
    generationFrames=expectedGenerationFrames(manifest,controlSeconds);
  }
  if(generationFrames<requiredSourceFrames)throw new HttpError(422,"The selected workflow cannot cover this shot duration at the assembly frame rate; shorten the shot or select another workflow");
  return {frames,effectiveDurationSeconds,controlSeconds,generationFrames,generationFps:timing.fps,generationDurationSeconds:generationFrames/timing.fps};
}
