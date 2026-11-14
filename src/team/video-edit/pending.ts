import type {VideoEditDraft} from "./state";

/** Freeze the complete body before POST so an uncertain response cannot produce a second job. */
export type PendingVideoEdit={key:string;draft:VideoEditDraft;body:Record<string,unknown>};
export const pendingVideoEditKey=(userId:string,workspaceId:string,projectId:string)=>`comfyfield:video-edit:${userId}:${workspaceId}:${projectId}`;
export function readPendingVideoEdit(storage:Pick<Storage,"getItem">,key:string):PendingVideoEdit|null{
  try{const value=JSON.parse(storage.getItem(key)??"null");
    if(!value||typeof value.key!=="string"||value.body?.idempotencyKey!==value.key||typeof value.draft?.videoAssetId!=="string"||value.body?.sourceAssetId!==value.draft.videoAssetId)return null;
    return value;
  }catch{return null;}
}
