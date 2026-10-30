import type {Port} from "./types";

/** A physical video is not a semantic mask unless the server validated it as one. */
export function assetMatchesPort(asset:{media_type:string;content_type:string},port:Port):boolean {
  if(port.type==="mask"||port.type==="layer"||port.type==="reference")
    return asset.media_type===port.type&&asset.content_type.startsWith(`${port.representation??"image"}/`);
  return asset.media_type===port.type&&asset.content_type.startsWith(`${port.type}/`);
}
