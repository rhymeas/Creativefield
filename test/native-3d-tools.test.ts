import {afterAll,beforeAll,describe,it,expect,vi} from "vitest";
import {Box3,BoxGeometry,Group,Mesh,MeshStandardMaterial,Vector3} from "three";
import {GLTFExporter} from "three/examples/jsm/exporters/GLTFExporter.js";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";
import {inspectGlb} from "../src/team/three-d/glb-document";
import {editGlb,transformMesh} from "../src/team/three-d/model-tools";
import {textReferenceWorkflows} from "../src/team/three-d/TextTo3DPanel";
import {readFileSync} from "node:fs";
export function jsonGlb(doc:unknown){const json=new TextEncoder().encode(JSON.stringify(doc)),n=Math.ceil(json.length/4)*4,bytes=new Uint8Array(20+n);bytes.fill(32,20);const v=new DataView(bytes.buffer);v.setUint32(0,0x46546c67,true);v.setUint32(4,2,true);v.setUint32(8,bytes.length,true);v.setUint32(12,n,true);v.setUint32(16,0x4e4f534a,true);bytes.set(json,20);return bytes;}
describe("native 3D tools",()=>{
 beforeAll(()=>vi.stubGlobal("FileReader",class {result:unknown;onloadend?:()=>void;readAsArrayBuffer(blob:Blob){void blob.arrayBuffer().then(b=>{this.result=b;this.onloadend?.();});}}));afterAll(()=>vi.unstubAllGlobals());
 it("rejects corrupt and externally linked GLBs before loading",()=>{
  expect(()=>inspectGlb(new Uint8Array(12))).toThrow();
  for(const uri of ["https://example.test/a.bin","file:///private.bin","../private.bin","data:image/svg+xml;base64,AA=="])expect(()=>inspectGlb(jsonGlb({asset:{version:"2.0"},buffers:[{uri}]}))).toThrow(/External/);
 });
 it("transforms geometry deterministically and rejects invalid values",()=>{const root=new Group();root.add(new Mesh(new BoxGeometry(),new MeshStandardMaterial()));root.position.set(5,2,4);transformMesh(root,{scale:2,rotation:90,center:true});expect(new Box3().setFromObject(root).getCenter(new Vector3()).length()).toBeLessThan(0.00001);expect(root.scale.x).toBe(2);expect(()=>transformMesh(root,{scale:NaN,rotation:0,center:false})).toThrow();});
 it("exports a new usable GLB without changing the source bytes",async()=>{const root=new Group();root.add(new Mesh(new BoxGeometry(),new MeshStandardMaterial()));const original=new Uint8Array(await new GLTFExporter().parseAsync(root,{binary:true}) as ArrayBuffer),copy=original.slice();const blob=await editGlb(original,{scale:3,rotation:0,center:true});expect(original).toEqual(copy);const bytes=new Uint8Array(await blob.arrayBuffer());expect(inspectGlb(bytes).meshes).toHaveLength(1);const parsed=await new GLTFLoader().parseAsync(bytes.buffer,"");expect(new Box3().setFromObject(parsed.scene).getSize(new Vector3()).x).toBeCloseTo(3);});
 it("does not pretend to unwrap meshes or process animations",async()=>{const root=new Group(),geo=new BoxGeometry();geo.deleteAttribute("uv");root.add(new Mesh(geo,new MeshStandardMaterial()));const bytes=new Uint8Array(await new GLTFExporter().parseAsync(root,{binary:true}) as ArrayBuffer);await expect(editGlb(bytes,{scale:1,rotation:0,center:false},"data:image/png;base64,AA==")).rejects.toThrow(/UV/);await expect(editGlb(jsonGlb({asset:{version:"2.0"},animations:[{}]}),{scale:1,rotation:0,center:false})).rejects.toThrow(/Animated/);});
 it("text references use only implemented local prompt-only image workflows",()=>{const pack=(id:string)=>JSON.parse(readFileSync(`native-workflows/${id}/manifest.json`,"utf8"));expect(textReferenceWorkflows([pack("flux2-klein-t2i"),pack("qwen-image-21-edit"),pack("hunyuan3d-21")]).map(m=>m.id)).toEqual(["flux2-klein-t2i"]);});
});
