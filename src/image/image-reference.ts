import {workspacePath, type Asset, type Call} from '../team/api';

/** Resolve dropped assets beyond the current library page before using them. */
export async function resolveImageReference(id:string, assets:readonly Asset[], workspace:string, project:string, call?:Call):Promise<Asset>{
  const asset=assets.find(item=>item.id===id) ?? (call ? await call<Asset>(workspacePath(workspace,`assets/${encodeURIComponent(id)}`)) : undefined);
  if(!asset || asset.id!==id || asset.project_id!==project || asset.media_type!=='image' || !['image/png','image/jpeg','image/webp'].includes(asset.content_type))
    throw new Error('Choose a PNG, JPEG or WebP image from this project.');
  return asset;
}
