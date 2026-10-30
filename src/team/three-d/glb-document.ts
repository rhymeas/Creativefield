/** Only self-contained GLB 2 files enter the local tools; no external resource fetches. */
export const MAX_MODEL_BYTES=64*1024*1024;
export function inspectGlb(bytes:Uint8Array){
 if(bytes.byteLength<20||bytes.byteLength>MAX_MODEL_BYTES)throw new Error("Use a GLB model smaller than 64 MB.");
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(v.getUint32(0,true)!==0x46546c67||v.getUint32(4,true)!==2||v.getUint32(8,true)!==bytes.byteLength)throw new Error("Invalid GLB 2 model.");
 const length=v.getUint32(12,true);
 if(v.getUint32(16,true)!==0x4e4f534a||length>4*1024*1024||20+length>bytes.byteLength)throw new Error("Invalid GLB document.");
 const doc=JSON.parse(new TextDecoder().decode(bytes.subarray(20,20+length)));
 if(doc.asset?.version!=="2.0")throw new Error("GLB 2 is required.");
 for(const group of [doc.buffers,doc.images])for(const item of group??[])if(item.uri&&!/^data:(application\/(octet-stream|gltf-buffer)|image\/(png|jpeg|webp));base64,/.test(item.uri))throw new Error("External GLB resources are unsupported. Embed textures and buffers first.");
 for(const image of doc.images??[])if(image.mimeType&&!/^image\/(png|jpeg|webp)$/.test(image.mimeType))throw new Error("Use embedded PNG, JPEG or WebP textures.");
 return doc;
}
