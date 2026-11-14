/** The shape a run asked for, as width / height; undefined when its controls do not say. */
export function runShape(controls?:Record<string,unknown>){
  const width=controls?.width,height=controls?.height;
  if(typeof width==="number"&&typeof height==="number"&&width>0&&height>0)return width/height;
  const ratio=/^\s*(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)/.exec(String(controls?.aspect_ratio??""));
  return ratio&&Number(ratio[1])>0&&Number(ratio[2])>0?Number(ratio[1])/Number(ratio[2]):undefined;
}
