/** A drag payload for bundled example media, never an arbitrary remote URL. */
export const EXAMPLE_DRAG = "application/x-comfyfield-example";
/** A drag may advertise a concrete MIME type or a media family such as image/*. */
export function acceptsMediaType(accept:string,type:string):boolean {
  const mime=type.toLowerCase();
  return !!mime&&accept.split(",").some(item=>{const rule=item.trim().toLowerCase();return rule==="*/*"||rule===mime||rule.endsWith("/*")&&mime.startsWith(rule.slice(0,-1))||mime.endsWith("/*")&&rule.startsWith(mime.slice(0,-1));});
}
export async function readExampleFile(path:string,accept:string):Promise<File>{
  if(!/^\/(?:reels|examples|examples\/pool)\/[\w-][\w.-]*$/.test(path))throw new Error("This example cannot be used here.");
  const response=await fetch(path);
  if(!response.ok)throw new Error("The example could not be loaded.");
  const blob=await response.blob(),name=path.split("/").pop()??"example";
  const allowed=accept.split(",").some(item=>{const rule=item.trim().toLowerCase();return rule==="*/*"||rule.startsWith(".")?rule==="*/*"||name.toLowerCase().endsWith(rule):rule.endsWith("/*")?blob.type.startsWith(rule.slice(0,-1)):blob.type===rule;});
  if(!allowed)throw new Error("This media does not match the input. Choose a compatible file.");
  return new File([blob],name,{type:blob.type});
}
