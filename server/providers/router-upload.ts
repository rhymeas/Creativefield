import {ComfyLow} from '@comfyorg/sdk/low';
import type {OwnedInput} from './types';

/** Input uploads are separate from generation. The key is sent only to this fixed Comfy origin. */
export async function uploadRouterInput(input:OwnedInput,authorization:string,artifactOrigins:readonly string[]):Promise<string>{
 /* Videos for the video models; PNG/JPEG/WebP for models that take a picture by URL (Stable Fast 3D). */
 const names:Record<string,string>={'video/mp4':'source.mp4','video/quicktime':'source.mov','image/png':'source.png','image/jpeg':'source.jpg','image/webp':'source.webp'};
 if(!names[input.contentType]||input.bytes>200*1024*1024)throw new Error('Use an MP4, MOV, PNG, JPEG or WebP up to 200 MB');
 const data:Uint8Array[]=[];let size=0;for await(const c of await input.open()){const b=Buffer.from(c);size+=b.length;if(size>200*1024*1024)throw new Error('File too large');data.push(new Uint8Array(b));}
 const origin='https://cloud.comfy.org';
 /* The SDK adds /api/v2 itself; a base that already ends in it doubled the path, so every upload was refused. */
 const client=new ComfyLow(origin,authorization.replace(/^Bearer /,''),{timeoutMs:120000,fetch:async(url,options)=>{
  const target=new URL(String(url));if(target.origin!==origin||!target.pathname.startsWith('/api/v2/assets'))throw new Error('Upload destination denied');
  return fetch(url,{...options,redirect:'manual'});
 }});
 const asset=await client.postAssets(new Blob(data,{type:input.contentType}),input.contentType,names[input.contentType]);const result=await client.getAssetContentUrl(asset.id);const url=new URL(result.url);if(!artifactOrigins.includes(url.origin)||url.protocol!=='https:'||url.username||url.password||url.hash||url.origin===origin)throw new Error('Comfy did not provide a public input URL');return url.href;
}
