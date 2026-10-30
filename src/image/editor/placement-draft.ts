import {z} from "zod";

export const placementScopeSchema=z.object({userId:z.uuid(),workspaceId:z.uuid(),projectId:z.uuid(),assetId:z.uuid()}).strict();
export type PlacementScope=z.infer<typeof placementScopeSchema>;
export const placementDraftSchema=placementScopeSchema.extend({version:z.literal(1),characterId:z.uuid(),capabilityId:z.string().min(1).max(120),capabilityVersion:z.string().min(1).max(40),width:z.number().int().min(1).max(2048),height:z.number().int().min(1).max(2048),sceneHash:z.string().regex(/^[a-f0-9]{64}$/),mask:z.string().max(2000000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/).nullable(),prompt:z.string().max(8000)}).strict();
export type PlacementDraft=z.infer<typeof placementDraftSchema>;
export const placementDraftKey=(scope:PlacementScope)=>`comfyfield.placement.${scope.userId}.${scope.workspaceId}.${scope.projectId}.${scope.assetId}`;
export function readPlacementDraft(raw:string|null,scope:PlacementScope):PlacementDraft|null{
  try{
    if(!raw||raw.length>2020000)return null;
    const draft=placementDraftSchema.parse(JSON.parse(raw));
    if((Object.keys(scope) as Array<keyof PlacementScope>).some(key=>draft[key]!==scope[key]))return null;
    if(draft.mask){
      const bytes=Uint8Array.from(atob(draft.mask.split(",")[1].slice(0,44)),char=>char.charCodeAt(0));
      if(bytes.length<24||![137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value))return null;
      const view=new DataView(bytes.buffer);
      if(view.getUint32(16)!==draft.width||view.getUint32(20)!==draft.height)return null;
    }
    return draft;
  }catch{return null;}
}
