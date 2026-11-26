import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from "react";
import {AmbientLight,Box3,Color,DirectionalLight,LoadingManager,Material,Mesh,MeshBasicMaterial,MeshStandardMaterial,PerspectiveCamera,Scene,Sphere,TextureLoader,Vector3,WebGLRenderer,type Object3D} from "three";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";
import {Button,Meta,PillMenu,ShimmerText,SliderField,SparkleLoader,StatusText} from "../ds";
import {inspectGlb} from "../team/three-d/glb-document";
import {orbitPosition} from "./true-angles";

const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value));

export type OrbitPreviewHandle={capturePng:()=>Promise<Blob>};

/* How the mesh is drawn. Textured keeps the file's own materials; the others replace them for inspection only. */
export type OrbitShading="textured"|"shaded"|"solid"|"wireframe";
const SHADINGS:{id:OrbitShading;label:string}[]=[{id:"textured",label:"Textured"},{id:"shaded",label:"Shaded"},{id:"solid",label:"Solid"},{id:"wireframe",label:"Wireframe"}];

/* Camera presets snap the orbit to a fixed angle; "free" is what dragging or the sliders leave behind. */
const VIEWS:{id:string;label:string;azimuth:number|null;elevation:number|null}[]=[
  {id:"free",label:"Free camera",azimuth:null,elevation:null},
  {id:"front",label:"Front",azimuth:0,elevation:0},
  {id:"right",label:"Right",azimuth:90,elevation:0},
  {id:"back",label:"Back",azimuth:180,elevation:0},
  {id:"left",label:"Left",azimuth:-90,elevation:0},
  {id:"iso-front-right",label:"Isometric front right",azimuth:45,elevation:25},
  {id:"iso-front-left",label:"Isometric front left",azimuth:-45,elevation:25},
  {id:"iso-back-right",label:"Isometric back right",azimuth:135,elevation:25},
  {id:"iso-back-left",label:"Isometric back left",azimuth:-135,elevation:25},
];

/* Backdrop = one of the design-system surface tokens, read at draw time so the tint follows the theme. */
const BACKDROPS:{id:string;label:string}[]=[{id:"--surface-page",label:"Page"},{id:"--surface-panel",label:"Panel"},{id:"--surface-control",label:"Control"}];

/* Lenses are a choice, not a typed field (DS rule 66). The 24 mm sensor height sets the vertical field of view. */
const LENSES=[24,35,45,85];
const DEFAULT_LENS=45;
const verticalFov=(mm:number)=>2*Math.atan(12/mm)*180/Math.PI;

/** Live inspection of the real GLB. The eight fixed views remain the source for painting. */
export const OrbitPreview=forwardRef<OrbitPreviewHandle,{url:string;standalone?:boolean;compact?:boolean;onStatusChange?:(status:"loading"|"ready"|"failed")=>void}>(function OrbitPreview({url,standalone=false,compact=false,onStatusChange},ref){
  const canvas=useRef<HTMLCanvasElement>(null),draw=useRef<(azimuth:number,elevation:number)=>void>(()=>{}),paint=useRef<(shading:OrbitShading)=>void>(()=>{}),tint=useRef<(token:string)=>void>(()=>{}),lensSet=useRef<(mm:number)=>void>(()=>{});
  const drag=useRef<{x:number;y:number;azimuth:number;elevation:number}|null>(null);
  const [azimuth,setAzimuth]=useState(0),[elevation,setElevation]=useState(0);
  const [shading,setShading]=useState<OrbitShading>("textured"),[view,setView]=useState("free");
  const [backdrop,setBackdrop]=useState("--surface-page"),[lens,setLens]=useState(DEFAULT_LENS);
  const [status,setStatus]=useState<"loading"|"ready"|"failed">("loading");

  useImperativeHandle(ref,()=>({capturePng:()=>new Promise<Blob>((resolve,reject)=>{
    if(status!=="ready"||!canvas.current){reject(new Error("Wait for the camera view to finish loading."));return;}
    canvas.current.toBlob(blob=>blob?resolve(blob):reject(new Error("The camera view could not be captured.")),"image/png");
  })}),[status]);
  useEffect(()=>onStatusChange?.(status),[onStatusChange,status]);

  useEffect(()=>{
    const element=canvas.current;
    if(!element)return;
    let disposed=false,renderer:WebGLRenderer|undefined,subject:Object3D|undefined,restore:()=>void=()=>{},inspection:Material[]=[];
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
        let radius=sphere.radius/Math.sin((camera.fov*Math.PI/180)/2)*1.08;
        /* A new lens changes the field of view, so the orbit distance that frames the model changes with it. */
        lensSet.current=mm=>{camera.fov=verticalFov(mm);camera.updateProjectionMatrix();radius=sphere.radius/Math.sin((camera.fov*Math.PI/180)/2)*1.08;};
        tint.current=token=>{const value=getComputedStyle(element).getPropertyValue(token).trim();if(value)scene.background=new Color(value);};
        renderer=new WebGLRenderer({canvas:element,antialias:true,preserveDrawingBuffer:true});
        renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
        renderer.setSize(compact?160:640,compact?160:640,false);
        draw.current=(az,el)=>{
          camera.position.set(...orbitPosition(az,el,radius));
          camera.lookAt(0,0,0);
          renderer!.render(scene,camera);
        };
        /* The inspection materials are shared by every mesh of this model and disposed with it. */
        const meshes:Mesh[]=[];subject.traverse(node=>{if((node as Mesh).isMesh)meshes.push(node as Mesh);});
        const originals=new Map<Mesh,Material|Material[]>(meshes.map(mesh=>[mesh,mesh.material]));
        const clay=new MeshStandardMaterial({color:0xb9bdc3,roughness:0.85,metalness:0});
        const flat=new MeshBasicMaterial({color:0xb9bdc3});
        const wire=new MeshBasicMaterial({color:0xe6e8ea,wireframe:true});
        inspection=[clay,flat,wire];
        restore=()=>{for(const mesh of meshes)mesh.material=originals.get(mesh)!;};
        paint.current=mode=>{
          for(const mesh of meshes)mesh.material=mode==="textured"?originals.get(mesh)!:mode==="shaded"?clay:mode==="solid"?flat:wire;
        };
        paint.current(shading);
        draw.current(azimuth,elevation);
        setStatus("ready");
      }catch{
        if(!disposed)setStatus("failed");
      }
    })();
    return()=>{
      disposed=true;draw.current=()=>{};paint.current=()=>{};tint.current=()=>{};lensSet.current=()=>{};renderer?.dispose();restore();
      for(const material of inspection)material.dispose();
      subject?.traverse(node=>{const mesh=node as Mesh;if(mesh.isMesh){mesh.geometry.dispose();for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){for(const value of Object.values(material))if(value&&typeof value=== "object"&&(value as {isTexture?:boolean}).isTexture)(value as {dispose:()=>void}).dispose();material.dispose();}}});
    };
  }, [url,compact]);

  useEffect(()=>{if(status==="ready"){lensSet.current(lens);tint.current(backdrop);paint.current(shading);draw.current(azimuth,elevation);}},[azimuth,elevation,shading,backdrop,lens,status]);

  function pickView(id:string){
    const next=VIEWS.find(item=>item.id===id);if(!next)return;
    setView(id);
    if(next.azimuth!==null&&next.elevation!==null){setAzimuth(next.azimuth);setElevation(next.elevation);}
  }

  return <div className="cf-orbit-preview" data-compact={compact||undefined} data-standalone={standalone||undefined}>
    <div className="cf-orbit-preview__stage">
    <canvas ref={canvas} role="img" aria-label="Interactive 3D orbit preview of the generated mesh" className="ds-orbit-preview"
      onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);drag.current={x:event.clientX,y:event.clientY,azimuth,elevation};setView("free");}}
      onPointerMove={event=>{if(!drag.current)return;setAzimuth(clamp(drag.current.azimuth-(event.clientX-drag.current.x)*0.45,-180,180));setElevation(clamp(drag.current.elevation+(event.clientY-drag.current.y)*0.3,-30,40));}}
      onPointerUp={event=>{drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
      onPointerCancel={()=>{drag.current=null;}}/>
    {standalone&&status==="ready"&&<>
      <div className="cf-orbit-preview__tools">
        <PillMenu name="Shading" label={SHADINGS.find(item=>item.id===shading)?.label??"Textured"} items={SHADINGS} value={shading} onPick={id=>setShading(id as OrbitShading)}/>
        <PillMenu name="Background" label={BACKDROPS.find(item=>item.id===backdrop)?.label??"Page"} items={BACKDROPS} value={backdrop} onPick={setBackdrop}/>
      </div>
      <div className="cf-orbit-preview__views">
        <PillMenu name="Camera" label={VIEWS.find(item=>item.id===view)?.label??"Free camera"} items={VIEWS.map(({id,label})=>({id,label}))} value={view} onPick={pickView}/>
        <PillMenu name="Lens" label={`${lens} mm`} items={LENSES.map(mm=>({id:String(mm),label:`${mm} mm`}))} value={String(lens)} onPick={id=>setLens(Number(id))}/>
      </div>
    </>}
    </div>
    {!compact&&<><SliderField label="Orbit" unit="°" min={-180} max={180} value={azimuth} onChange={value=>{setView("free");setAzimuth(value);}}/>
    <SliderField label="Height" unit="°" min={-30} max={40} value={elevation} onChange={value=>{setView("free");setElevation(value);}}/>
    <div className="cf-orbit-preview__meta">
      <Meta>Drag the mesh or use the sliders. {standalone?"This is the actual model geometry.":"This is the real geometry; painting still uses the eight saved views."}</Meta>
      <Button variant="ghost" onClick={()=>{setView("free");setAzimuth(0);setElevation(0);}}>Reset view</Button>
    </div></>}
    {!compact&&status==="loading"&&<><SparkleLoader label="Loading 3D model"/><ShimmerText>Loading the 3D model</ShimmerText></>}
    {!compact&&status==="failed"&&<StatusText tone="warn">The 3D model could not be previewed here. {standalone?"Check that this is a supported self-contained GLB.":"The eight saved views are still available."}</StatusText>}
  </div>;
});
