import {ComfyLow} from '@comfyorg/sdk/low';
import type {OwnedInput} from './types';

/** Input uploads are separate from generation. The key is sent only to this fixed Comfy origin. */
export async function uploadRouterInput(input:OwnedInput,authorization:string,artifactOrigins:readonly string[]):Promise<string>{
 if(!['video/mp4','video/quicktime'].includes(input.contentType)||input.bytes>200*1024*1024)throw new Error('Use an MP4 or MOV up to 200 MB');
 const data:Uint8Array[]=[];let size=0;for await(const c of await input.open()){const b=Buffer.from(c);size+=b.length;if(size>200*1024*1024)throw new Error('Video too large');data.push(new Uint8Array(b));}
 const origin='https://cloud.comfy.org';
 const client=new ComfyLow(`${origin}/api/v2`,authorization.replace(/^Bearer /,''),{timeoutMs:120000,fetch:async(url,options)=>{
  const target=new URL(String(url));if(target.origin!==origin||!target.pathname.startsWith('/api/v2/assets'))throw new Error('Upload destination denied');
  return fetch(url,{...options,redirect:'manual'});
 }});
 const asset=await client.postAssets(new Blob(data,{type:input.contentType}),input.contentType,input.contentType==='video/mp4'?'source.mp4':'source.mov');const result=await client.getAssetContentUrl(asset.id);const url=new URL(result.url);if(!artifactOrigins.includes(url.origin)||url.protocol!=='https:'||url.username||url.password||url.hash||url.origin===origin)throw new Error('Comfy did not provide a public input URL');return url.href;
}
