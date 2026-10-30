import sharp from "sharp";
import {SCENE_VIDEO_PROBE_ID} from "../src/capabilities/replace-video-probe";
import type {Invocation} from "../src/capabilities/types";
import {fileSha256AndBytes} from "./video-extension-media";

type SceneAsset={id:string;sha256:string;bytes:string|number;media_type:string;storage_key:string};
/** Freeze the exact existing image. This never creates or edits a reference. */
export async function admitSceneReference(asset:Omit<SceneAsset,"bytes">&{bytes?:string|number},file:string){
  const disk=await fileSha256AndBytes(file);
  if(asset.media_type!=="image"||asset.sha256!==disk.sha256||(asset.bytes!==undefined&&Number(asset.bytes)!==disk.bytes))throw new Error("The scene image is missing or changed; choose it again");
  const info=await sharp(file,{limitInputPixels:16777216}).metadata();
  if(!info.width||!info.height||(info.pages??1)!==1)throw new Error("Choose a single scene image");
  return {version:1 as const,assetId:asset.id,sha256:disk.sha256,bytes:disk.bytes,width:info.width,height:info.height};
}

/** Both native and SDK execution check the admission receipt before uploads. */
export async function verifySceneReference(capability:string,invocation:Invocation,assets:SceneAsset[],file:(key:string)=>Promise<string>){
  if(capability!==SCENE_VIDEO_PROBE_ID)return;
  const receipt=invocation.sceneReference,a=assets.find(a=>a.id===invocation.inputs.scene_image);
  if(!receipt||receipt.version!==1||!a||a.id!==receipt.assetId||a.sha256!==receipt.sha256||Number(a.bytes)!==receipt.bytes)throw new Error("The frozen scene reference changed before execution");
  const disk=await fileSha256AndBytes(await file(a.storage_key));
  if(disk.sha256!==receipt.sha256||disk.bytes!==receipt.bytes)throw new Error("The frozen scene reference bytes changed before execution");
}
