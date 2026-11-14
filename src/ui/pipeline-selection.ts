import type {Manifest} from "../workflow/manifest";

export function pipelineChoices(route:"video"|"motion",explicit:string|null,hasStart:boolean,hasEnd:boolean):string[] {
  if(route==="motion")return ["motion"];
  if(explicit)return [explicit];
  return hasStart?(hasEnd?["flf2v","i2v"]:["i2v"]):["t2v"];
}

/** Retained drafts are never uploaded or recorded if this workflow does not use them. */
export function workflowMedia<T>(manifest:Manifest,drafts:{start:T|null;end:T|null;motion:T|null}) {
  const file=manifest.inputs.start_image?drafts.start:null;
  const endFile=manifest.inputs.end_image?drafts.end:null;
  const motionFile=manifest.inputs.motion_video?drafts.motion:null;
  const complete=(!manifest.inputs.start_image||!!file)&&(!manifest.inputs.end_image||!!endFile)&&(!manifest.inputs.motion_video||!!motionFile);
  return {file,endFile,motionFile,complete};
}
