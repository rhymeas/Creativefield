import type {CapabilityManifestV2,Control} from "./types";

/**
 * Size and time of a result (output size, aspect ratio, duration, number of images) sit in the panel's main row,
 * never under Advanced (DS rule 66). Every panel asks this one function which controls those are, so they render
 * in the row and are left out of the Advanced dialog.
 */
export function frameControls(manifest:Pick<CapabilityManifestV2,"controls">){
  const live=(control:Control)=>!control.disabledReason;
  const size=manifest.controls.find(c=>(c.id==="megapixels"||c.id==="resolution")&&c.type==="select"&&live(c));
  /* A custom canvas switch (Qwen edit) makes its aspect ratio part of that option, so it stays with it. */
  const aspect=manifest.controls.some(c=>c.id==="custom_size")?undefined:manifest.controls.find(c=>c.id==="aspect_ratio"&&c.type==="select"&&!!c.options?.length&&live(c));
  const length=manifest.controls.find(c=>c.id==="length")??manifest.controls.find(c=>["seconds","duration","clip_seconds"].includes(c.id)&&["number","integer","select"].includes(c.type)&&live(c));
  const count=manifest.controls.find(c=>(c.id==="batch_size"||c.runCount)&&c.type==="integer"&&c.min!==undefined&&c.max!==undefined&&c.max-c.min<=8&&live(c));
  const ids=[size,aspect,length,count].filter((c):c is Control=>!!c).map(c=>c.id);
  return {size,aspect,length,count,ids};
}

/** The choices of a small whole-number control, e.g. Images 1 to 4. */
export const countOptions=(control:Control)=>Array.from({length:(control.max??1)-(control.min??1)+1},(_,index)=>(control.min??1)+index);
