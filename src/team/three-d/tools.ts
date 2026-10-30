/* Native generation contracts are exposed in the studio; legacy template links retain recovery. */
export const THREE_D_TOOLS = [
  {id:"viewer",title:"3D viewer",text:"Preview local models, lighting and materials."},
  {id:"image",title:"Image to 3D",text:"Turn a subject image into a model with local 3D workflows."},
  {id:"text",title:"Text to 3D",text:"Create an image from text, then turn it into a 3D model."},
  {id:"texture",title:"Textures",text:"Apply a Library image to an existing UV-mapped GLB."},
  {id:"mesh",title:"Mesh tools",text:"Scale, rotate and center a static GLB; save a copy."},
  {id:"workflows",title:"3D workflows",text:"Choose a local workflow in the native generation panel."},
] as const;
export type ThreeDTool = typeof THREE_D_TOOLS[number]["id"];
export function threeDTool(value:string|undefined):ThreeDTool|null {
  return THREE_D_TOOLS.some(tool=>tool.id===value)?value as ThreeDTool:null;
}

export type ThreeDContinuation="edit"|"image"|"texture"|"mesh";
export function threeDContinuationHash(action:ThreeDContinuation,assetId:string){
  if(!assetId)throw new Error("A Library asset is required for a 3D continuation.");
  if(action==="edit")return `imageedit/${assetId}`;
  if(action==="image")return `3d/image/auto/${assetId}`;
  return `3d/${action}/${assetId}`;
}

/** Tools with a native generation contract or an existing model viewer. */
export const NATIVE_THREE_D_TOOLS=THREE_D_TOOLS;
