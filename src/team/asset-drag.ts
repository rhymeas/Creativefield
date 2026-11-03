import {ASSET_DRAG,ASSET_TYPE_DRAG} from "../ds";
import type {Asset} from "./api";

/** Add the real MIME type to a Thumb drag when its project asset is known. */
export function addKnownAssetDragType(data:Pick<DataTransfer,"getData"|"setData">,assets:Asset[]):void {
  const asset=assets.find(item=>item.id===data.getData(ASSET_DRAG));
  if(asset?.content_type)data.setData(ASSET_TYPE_DRAG,asset.content_type);
}
