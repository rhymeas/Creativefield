import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from "react";
import {AmbientLight,Box3,Color,DirectionalLight,LoadingManager,Mesh,PerspectiveCamera,Scene,Sphere,TextureLoader,Vector3,WebGLRenderer,type Object3D} from "three";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";
import {Button,Meta,ShimmerText,SliderField,SparkleLoader,StatusText} from "../ds";
import {inspectGlb} from "../team/three-d/glb-document";
import {orbitPosition} from "./true-angles";

const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value));

export type OrbitPreviewHandle={capturePng:()=>Promise<Blob>};

/** Live inspection of the real GLB. The eight fixed views remain the source for painting. */
export const OrbitPreview=forwardRef<OrbitPreviewHandle,{url:string;standalone?:boolean;compact?:boolean;onStatusChange?:(status:"loading"|"ready"|"failed")=>void}>(function OrbitPreview({url,standalone=false,compact=false,onStatusChange},ref){
  const canvas=useRef<HTMLCanvasElement>(null),draw=useRef<(azimuth:number,elevation:number)=>void>(()=>{});
  const drag=useRef<{x:number;y:number;azimuth:number;elevation:number}|null>(null);
  const [azimuth,setAzimuth]=useState(0),[elevation,setElevation]=useState(0);
  const [status,setStatus]=useState<"loading"|"ready"|"failed">("loading");

  useImperativeHandle(ref,()=>({capturePng:()=>new Promise<Blob>((resolve,reject)=>{
    if(status!=="ready"||!canvas.current){reject(new Error("Wait for the camera view to finish loading."));return;}
    canvas.current.toBlob(blob=>blob?resolve(blob):reject(new Error("The camera view could not be captured.")),"image/png");
  })}),[status]);
  useEffect(()=>onStatusChange?.(status),[onStatusChange,status]);

  useEffect(()=>{
    const element=canvas.current;
    if(!element)return;
    let disposed=false,renderer:WebGLRenderer|undefined,subject:Object3D|undefined;
    setStatus("loading");
    void (async()=>{
      try{
        const response=await fetch(url);if(!response.ok)throw new Error("Model unavailable");const bytes=new Uint8Array(await response.arrayBuffer());inspectGlb(bytes);const manager=new LoadingManager();manager.setURLModifier(resource=>{if(/^(blob:|data:)/.test(resource))return resource;throw new Error("External model resources are unsupported");});
        const gltf=await new GLTFLoader(manager).register(parser=>{parser.textureLoader=new TextureLoader(manager);return {name:"COMFYFIELD_local_images"};}).parseAsync(bytes.buffer,"");
        if(disposed)return;
        subject=gltf.scene;
        const box=new Box3().setFromObject(subject),center=box.getCenter(new Vector3()),sphere=box.getBoundingSphere(new Sphere());
        subject.position.sub(center);
        const scene=new Scene(),surface=getComputedStyle(element).backgroundColor;
        scene.background=surface?new Color(surface):null;scene.add(subject);
        scene.add(new AmbientLight(0xffffff,0.55));
        const key=new DirectionalLight(0xffffff,1.6);key.position.set(2,3,4);scene.add(key);
        const fill=new DirectionalLight(0xffffff,0.5);fill.position.set(-3,1,-2);scene.add(fill);
        const camera=new PerspectiveCamera(30,1,0.01,1000);
        const radius=sphere.radius/Math.sin((camera.fov*Math.PI/180)/2)*1.08;
        renderer=new WebGLRenderer({canvas:element,antialias:true,preserveDrawingBuffer:true});
        renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
        renderer.setSize(compact?160:640,compact?160:640,false);
        draw.current=(az,el)=>{
          camera.position.set(...orbitPosition(az,el,radius));
          camera.lookAt(0,0,0);
          renderer!.render(scene,camera);
        };
        draw.current(azimuth,elevation);
        setStatus("ready");
      }catch{
        if(!disposed)setStatus("failed");
      }
    })();
    return()=>{
      disposed=true;draw.current=()=>{};renderer?.dispose();
      subject?.traverse(node=>{const mesh=node as Mesh;if(mesh.isMesh){mesh.geometry.dispose();for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){for(const value of Object.values(material))if(value&&typeof value=== "object"&&(value as {isTexture?:boolean}).isTexture)(value as {dispose:()=>void}).dispose();material.dispose();}}});
    };
  }, [url,compact]);

  useEffect(()=>{if(status==="ready")draw.current(azimuth,elevation);},[azimuth,elevation,status]);

  return <div className="cf-orbit-preview" data-compact={compact||undefined}>
    <canvas ref={canvas} role="img" aria-label="Interactive 3D orbit preview of the generated mesh" className="ds-orbit-preview"
      onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);drag.current={x:event.clientX,y:event.clientY,azimuth,elevation};}}
      onPointerMove={event=>{if(!drag.current)return;setAzimuth(clamp(drag.current.azimuth-(event.clientX-drag.current.x)*0.45,-180,180));setElevation(clamp(drag.current.elevation+(event.clientY-drag.current.y)*0.3,-30,40));}}
      onPointerUp={event=>{drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
      onPointerCancel={()=>{drag.current=null;}}/>
    {!compact&&<><SliderField label="Orbit" unit="°" min={-180} max={180} value={azimuth} onChange={value=>setAzimuth(value)}/>
    <SliderField label="Height" unit="°" min={-30} max={40} value={elevation} onChange={value=>setElevation(value)}/>
    <div className="cf-orbit-preview__meta">
      <Meta>Drag the mesh or use the sliders. {standalone?"This is the actual model geometry.":"This is the real geometry; painting still uses the eight saved views."}</Meta>
      <Button variant="ghost" onClick={()=>{setAzimuth(0);setElevation(0);}}>Reset view</Button>
    </div></>}
    {!compact&&status==="loading"&&<><SparkleLoader label="Loading 3D model"/><ShimmerText>Loading the 3D model</ShimmerText></>}
    {!compact&&status==="failed"&&<StatusText tone="warn">The 3D model could not be previewed here. {standalone?"Check that this is a supported self-contained GLB.":"The eight saved views are still available."}</StatusText>}
  </div>;
});
