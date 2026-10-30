import {statfs} from "node:fs/promises";
import path from "node:path";
/** Reports the configured volume only; never scans folders or moves user data. */
export async function storageVolume(directory:string|undefined):Promise<{volume:string;freeBytes:number}|null>{
  if(!directory)return null;
  try{const stats=await statfs(directory);return {volume:path.parse(path.resolve(directory)).root,freeBytes:stats.bavail*stats.bsize};}catch{return null;}
}
