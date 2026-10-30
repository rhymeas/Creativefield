type StorageReader={getItem:(key:string)=>string|null};
export const sceneAnchorKey=(workspace:string,project:string)=>`comfyfield:scene-anchor:${workspace}:${project}`;
export const videoProbeKey=(workspace:string,project:string)=>`comfyfield:video-probe:${workspace}:${project}`;
/** A mode change is a new experiment; never relabel a cached Replacement result. */
export function videoProbeContext({video,references,prompt,worker,personIndex=0,sceneImageId}:{video:string;references:string[];prompt:string;worker:string;personIndex?:number;sceneImageId?:string}){
  return JSON.stringify({video,references,prompt,worker,...(references.length===1?{personIndex}:{}),...(sceneImageId?{sceneImageId,sceneMode:"animation"}:{})});
}
/** Restore only this project's inputs; a stored run never submits a new job. */
function readDraft(storage:StorageReader|null,key:string,worker:string,single=false){
  try{
    const saved=JSON.parse(storage?.getItem(key)??"null");
    const c=JSON.parse(saved?.context??"null"),uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
    if(!c||c.worker!==worker||typeof c.video!=="string"||!uuid.test(c.video)||!Array.isArray(c.references)||!(c.references.length===2||(single&&c.references.length===1))||!c.references.every((id:unknown)=>typeof id==="string"&&uuid.test(id))||typeof c.prompt!=="string")return null;
    if(c.sceneImageId!==undefined&&(typeof c.sceneImageId!=="string"||!uuid.test(c.sceneImageId)))return null;
    return {video:c.video as string,faces:(c.references as string[]).map((asset,index)=>({asset,index:c.references.length===1&&c.personIndex===1?1:index})),prompt:c.prompt as string,...(c.sceneImageId?{sceneImageId:c.sceneImageId as string}:{})};
  }catch{return null;}
}
export const sceneAnchorDraft=(storage:StorageReader|null,workspace:string,project:string,worker:string)=>readDraft(storage,sceneAnchorKey(workspace,project),worker);
export const videoProbeDraft=(storage:StorageReader|null,workspace:string,project:string,worker:string)=>readDraft(storage,videoProbeKey(workspace,project),worker,true);
