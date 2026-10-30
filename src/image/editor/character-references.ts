import type {CapabilityManifestV2} from "../../capabilities/types";
import {assetMatchesPort} from "../../capabilities/assets";
import type {CharacterRecord} from "../../team/api";

export type CharacterEditBindings=Record<string,{elementId:string;assetId:string}>;

/** Preserve the saved pack's order and identity. The server still resolves
 * membership, ownership, media type and immutable asset hashes at admission. */
/** Qwen Image 2.1 addresses inputs as <image1>, <image2>...; without those
tokens it can turn a multi-reference pack into a contact-sheet-like output. */
export function identityReferenceInstruction(count:number){
  if(count<1)return "";
  const references=Array.from({length:Math.min(count,3)},(_,index)=>`<image${index+2}>`);
  return `Use <image1> as the scene to edit. ${references.join(", ")} ${references.length===1?"is a reference view":"are reference views"} of the same person. Use all reference views together for identity, face, hair and clothing. Generate exactly one coherent scene, not a grid, collage, storyboard or multiple panels. Keep <image1>'s composition and unchanged regions.`;
}

/** Qwen's multi-image conditioning can treat several references as panels.
 * A three-view sheet gives the model one reference image with all identity
 * angles, so the scene request remains a single image. */
export function identityReferenceSheetInstruction(count:number){
  if(count<2)return identityReferenceInstruction(count);
  return `Use <image1> as the scene to edit. <image2> is a single reference sheet containing ${Math.min(count,3)} views of the same person. Use the sheet only for identity, face, hair, clothing and scale. Generate exactly one coherent photograph of one person in one scene, not a grid, collage, storyboard or multiple panels. Keep <image1>'s composition and unchanged regions.`;
}

export function characterEditBindings(record:CharacterRecord,manifest:CapabilityManifestV2,projectId:string):CharacterEditBindings{
  if(record.projectId!==projectId)throw new Error("Choose a character from this project.");
  const references=[...record.referencePack.references].sort((a,b)=>a.ordinal-b.ordinal);
  if(record.referencePack.version!==1||!record.elementId||!references.length)throw new Error("This character has no usable reference pack.");
  if(references.length>3)throw new Error("This edit supports up to three reference images. Choose a character with a smaller reference pack.");
  if(new Set(references.map(ref=>ref.assetId)).size!==references.length||references.some((ref,index)=>ref.ordinal!==index))throw new Error("This character's reference order is invalid.");
  return Object.fromEntries(references.map((reference,index)=>{
    const id=index===0?"reference_image":`reference_image_${index+1}`,port=manifest.inputs.find(port=>port.id===id);
    if(!port)throw new Error("The selected workflow cannot use this character's full reference pack.");
    if(reference.assetProjectId!==null&&reference.assetProjectId!==projectId)throw new Error("A character reference belongs to another project.");
    if(!assetMatchesPort({media_type:reference.assetMediaType,content_type:reference.assetContentType},port))throw new Error("A character reference is incompatible with this workflow.");
    return [id,{elementId:record.elementId,assetId:reference.assetId}];
  }));
}
