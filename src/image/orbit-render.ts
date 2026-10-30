import {AmbientLight,Box3,Color,DirectionalLight,Mesh,MeshStandardMaterial,PerspectiveCamera,Scene,Sphere,Vector3,WebGLRenderer,type Object3D} from "three";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";
import {orbitPosition} from "./true-angles";

export type OrbitView={id:string;azimuth:number;elevation:number};
export type OrbitRender={id:string;blob:Blob;url:string};

/** Renders the GLB from each view: centered, framed by its bounding sphere, neutral studio light, plain background. */
export async function renderOrbitViews(glbUrl:string,views:readonly OrbitView[],size=768):Promise<OrbitRender[]>{
  const gltf=await new GLTFLoader().loadAsync(glbUrl);
  const subject:Object3D=gltf.scene;
  // A textured mesh (TRELLIS.2) keeps its own materials; an untextured one gets an even clay so the shape reads clearly.
  let textured=false;
  subject.traverse(node=>{const material=(node as Mesh).material as MeshStandardMaterial|undefined;if((node as Mesh).isMesh&&material?.map)textured=true;});
  if(!textured)subject.traverse(node=>{if((node as Mesh).isMesh)(node as Mesh).material=new MeshStandardMaterial({color:0xb8b8b8,roughness:0.85,metalness:0});});
  const box=new Box3().setFromObject(subject),center=box.getCenter(new Vector3()),sphere=box.getBoundingSphere(new Sphere());
  subject.position.sub(center);
  const scene=new Scene();scene.background=new Color(0xe9e9e9);scene.add(subject);
  scene.add(new AmbientLight(0xffffff,0.55));
  const key=new DirectionalLight(0xffffff,1.6);key.position.set(2,3,4);scene.add(key);
  const fill=new DirectionalLight(0xffffff,0.5);fill.position.set(-3,1,-2);scene.add(fill);
  const camera=new PerspectiveCamera(30,1,0.01,1000);
  const radius=sphere.radius/Math.sin((camera.fov*Math.PI/180)/2)*1.08;
  const canvas=document.createElement("canvas");
  const renderer=new WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});
  renderer.setSize(size,size,false);
  const out:OrbitRender[]=[];
  try{
    for(const view of views){
      camera.position.set(...orbitPosition(view.azimuth,view.elevation,radius));
      camera.lookAt(0,0,0);
      renderer.render(scene,camera);
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("A view could not be encoded.")),"image/png"));
      out.push({id:view.id,blob,url:URL.createObjectURL(blob)});
    }
  }catch(error){for(const r of out)URL.revokeObjectURL(r.url);throw error;}
  finally{renderer.dispose();subject.traverse(node=>{const mesh=node as Mesh;if(mesh.isMesh){mesh.geometry.dispose();const material=mesh.material as MeshStandardMaterial;material.map?.dispose();material.dispose();}});}
  return out;
}
