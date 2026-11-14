import {Box3,LoadingManager,Mesh,MeshStandardMaterial,SRGBColorSpace,TextureLoader,Vector3,type Object3D} from "three";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";
import {GLTFExporter} from "three/examples/jsm/exporters/GLTFExporter.js";
import {inspectGlb} from "./glb-document";
export type MeshChange={scale:number;rotation:number;center:boolean};
export function transformMesh(root:Object3D,change:MeshChange){
 if(!Number.isFinite(change.scale)||change.scale<0.01||change.scale>100||!Number.isFinite(change.rotation)||Math.abs(change.rotation)>360)throw new Error("Choose a valid scale and rotation.");
 root.scale.multiplyScalar(change.scale);root.rotation.y+=change.rotation*Math.PI/180;root.updateMatrixWorld(true);
 if(change.center){root.position.sub(new Box3().setFromObject(root).getCenter(new Vector3()));root.updateMatrixWorld(true);}
}
export function assertStaticMesh(root:Object3D){let meshes=0;root.traverse(node=>{const m=node as Mesh;if(m.isMesh){if((m as Mesh&{isSkinnedMesh?:boolean}).isSkinnedMesh)throw new Error("Rigged models are not supported by these tools.");meshes++;}});if(!meshes)throw new Error("The model contains no mesh.");}
export async function editGlb(bytes:Uint8Array,change:MeshChange,textureUrl?:string,onStage?:(stage:string)=>void){
 const doc=inspectGlb(bytes);if(doc.animations?.length)throw new Error("Animated models are not supported by these tools.");
 const manager=new LoadingManager();manager.setURLModifier(url=>{if(/^(blob:|data:)/.test(url))return url;throw new Error("External model resources are unsupported.");});
 onStage?.("Reading model");const gltf=await new GLTFLoader(manager).register(parser=>{parser.textureLoader=new TextureLoader(manager);return {name:"COMFYFIELD_local_images"};}).parseAsync(bytes.slice().buffer,"");const root=gltf.scene;const originals=new Set<any>();root.traverse(n=>{if((n as Mesh).isMesh){const m=n as Mesh;for(const mat of Array.isArray(m.material)?m.material:[m.material])originals.add(mat);}});
 try{
  assertStaticMesh(root);onStage?.("Updating geometry");transformMesh(root,change);
  if(textureUrl){
   let withoutUv=false;root.traverse(n=>{if((n as Mesh).isMesh&&!(n as Mesh).geometry.attributes.uv)withoutUv=true;});if(withoutUv)throw new Error("This mesh has no UV coordinates. Texture application requires an unwrapped model.");
   onStage?.("Applying texture");const texture=await new TextureLoader().loadAsync(textureUrl);if(texture.image.width>4096||texture.image.height>4096){texture.dispose();throw new Error("Texture images must be at most 4096 pixels per side.");}texture.flipY=false;texture.colorSpace=SRGBColorSpace;
   root.traverse(n=>{if(!(n as Mesh).isMesh)return;const m=n as Mesh;const mats=Array.isArray(m.material)?m.material:[m.material];m.material=mats.map(old=>{const next=(old as MeshStandardMaterial).clone();if(!('map' in next))throw new Error("This material cannot accept a base-color texture.");next.map=texture;next.needsUpdate=true;return next;});if(m.material.length===1)m.material=m.material[0];});
  }
  onStage?.("Encoding GLB");const data=await new GLTFExporter().parseAsync(root,{binary:true});if(!(data instanceof ArrayBuffer))throw new Error("GLB export failed.");return new Blob([data],{type:"model/gltf-binary"});
 }finally{const textures=new Set<any>();root.traverse(n=>{if(!(n as Mesh).isMesh)return;const m=n as Mesh;m.geometry.dispose();for(const mat of Array.isArray(m.material)?m.material:[m.material]){for(const value of Object.values(mat))if(value&&typeof value==='object'&&(value as any).isTexture)textures.add(value);mat.dispose();}});for(const mat of originals){for(const value of Object.values(mat))if(value&&typeof value==='object'&&(value as any).isTexture)textures.add(value);mat.dispose();}for(const t of textures)t.dispose();}
}
