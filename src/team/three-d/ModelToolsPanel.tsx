import {lazy,Suspense,useCallback,useEffect,useRef,useState} from "react";

import {Button,Canvas,Checkbox,EmptyState,GenerateButton,LinkButton,Meta,Notice,Page,Panel,PanelSection,ShimmerText,SparkleLoader,Split,TextField,Toolbar,UploadSlot} from "../../ds";
import type {OrbitPreviewHandle} from "../../image/OrbitPreview";

import {assetUrl,composerAssets,workspacePath,type Asset,type Call,type Project,type Workspace} from "../api";

import {WorkflowDescription} from "../workflow-info";
import {LibraryChoice} from "../LibraryChoice";

import {TeamMediaInput} from "../TeamMediaInput";
import {threeDContinuationHash} from "./tools";

const Preview=lazy(()=>import("../../image/OrbitPreview").then(m=>({default:m.OrbitPreview})));

export function ModelToolsPanel({mode,workspace,project,call,canEdit,onChanged}:{mode:"mesh"|"texture"|"viewer";workspace:Workspace;project:Project;call:Call;canEdit:boolean;onChanged:()=>void}){

 const [assets,setAssets]=useState<Asset[]>([]),[source,setSource]=useState(location.hash.split("/")[2]??""),[texture,setTexture]=useState(""),[result,setResult]=useState<Asset>(),[scale,setScale]=useState("1"),[rotation,setRotation]=useState("0"),[center,setCenter]=useState(true),[busy,setBusy]=useState(""),[error,setError]=useState(""),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0),[cursor,setCursor]=useState<string|null>(null),[previewStatus,setPreviewStatus]=useState<"loading"|"ready"|"failed">("loading");

 const working=useRef(false),mounted=useRef(true),preview=useRef<OrbitPreviewHandle>(null);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const onPreviewStatus=useCallback((status:"loading"|"ready"|"failed")=>setPreviewStatus(status),[]);

 useEffect(()=>{let live=true;setLoading(true);void composerAssets(call,workspace.id,project.id,[source,texture].filter(Boolean)).then(page=>{if(live){setAssets(old=>[...new Map([...old,...page.items].map(a=>[a.id,a])).values()]);setCursor(page.nextCursor);setError("");}}).catch(e=>{if(live)setError((e as Error).message);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[workspace.id,project.id,call,retry]);

 const models=assets.filter(a=>a.media_type==="model3d"&&a.content_type==="model/gltf-binary"),images=assets.filter(a=>a.media_type==="image"&&a.content_type.startsWith("image/")),selected=models.find(a=>a.id===source),image=images.find(a=>a.id===texture),shown=result??selected;

 const valid=Number.isFinite(Number(scale))&&Number(scale)>=0.01&&Number(scale)<=100&&rotation.trim()!==""&&Number.isFinite(Number(rotation))&&Math.abs(Number(rotation))<=360;

 async function more(){try{const page=await call<{items:Asset[];nextCursor:string|null}>(workspacePath(workspace.id,`assets?projectId=${project.id}&cursor=${encodeURIComponent(cursor!)}`));setAssets(old=>[...new Map([...old,...page.items].map(a=>[a.id,a])).values()]);setCursor(page.nextCursor);}catch(e){setError((e as Error).message);}}

 async function upload(file:File|null,kind:"model3d"|"image"){

  if(!file||working.current||!canEdit)return;working.current=true;setBusy("Saving input to Library");setError("");

  try{if(kind==="model3d"&&(!/\.glb$/i.test(file.name)||file.size>64*1024*1024))throw new Error("Choose a self-contained GLB smaller than 64 MB.");const data=new FormData();data.append("file",kind==="model3d"?new File([file],file.name,{type:"model/gltf-binary"}):file);const a=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${project.id}&kind=${kind}`),"POST",data);if(mounted.current){setAssets(old=>[a,...old]);if(kind==="model3d"){setPreviewStatus("loading");setSource(a.id);setResult(undefined);}else setTexture(a.id);onChanged();}}catch(e){if(mounted.current)setError((e as Error).message);}finally{working.current=false;if(mounted.current)setBusy("");}

 }

 async function apply(){

  if(working.current||!canEdit||!selected||!valid||mode==="texture"&&!image)return;working.current=true;setBusy("Reading model");setError("");

  try{if(Number(selected.bytes)>64*1024*1024)throw new Error("Choose a GLB smaller than 64 MB.");if(image&&Number(image.bytes)>20*1024*1024)throw new Error("Choose a texture smaller than 20 MB.");const response=await fetch(assetUrl(workspace.id,selected.id));if(!response.ok)throw new Error("The source model could not be read.");const {editGlb}=await import("./model-tools");const blob=await editGlb(new Uint8Array(await response.arrayBuffer()),mode==="texture"?{scale:1,rotation:0,center:false}:{scale:Number(scale),rotation:Number(rotation),center},mode==="texture"?assetUrl(workspace.id,image!.id):undefined,stage=>{if(mounted.current)setBusy(stage);});

   if(!mounted.current)return;if(blob.size>64*1024*1024)throw new Error("The edited model exceeds 64 MB. Use a smaller model or texture.");setBusy("Saving result to Library");const form=new FormData();form.append("file",new File([blob],`${selected.name.replace(/\.glb$/i,"")}-${mode==="texture"?"textured":"edited"}.glb`,{type:"model/gltf-binary"}));const saved=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${project.id}&kind=model3d&parentId=${selected.id}`),"POST",form);if(mounted.current){setResult(saved);setAssets(old=>[saved,...old]);onChanged();}

  }catch(e){if(mounted.current)setError((e as Error).message);}finally{working.current=false;if(mounted.current)setBusy("");}

 }

 async function continueFromView(target:"edit"|"image"){
  const active=shown;if(working.current||!canEdit||!active||previewStatus!=="ready")return;working.current=true;setError("");
  try{
   const blob=await preview.current?.capturePng();if(!blob)throw new Error("The camera view is not ready yet.");setBusy("Saving camera view to Library");
   const form=new FormData(),name=active.name.replace(/\.glb$/i,"").replace(/[^a-z0-9._-]+/gi,"-").replace(/^-+|-+$/g,"")||"3d-model";
   form.append("file",new File([blob],`${name}-camera-view.png`,{type:"image/png"}));
   const saved=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${project.id}&kind=image&parentId=${active.id}`),"POST",form);onChanged();
   location.hash=threeDContinuationHash(target,saved.id);
  }catch(e){if(mounted.current)setError((e as Error).message);}finally{working.current=false;if(mounted.current)setBusy("");}
 }

 return <Page fill><Split><Panel footer={mode!=="viewer"?<GenerateButton label={mode==="texture"?"Apply texture":"Save mesh copy"} busy={!!busy} disabled={!!busy||!canEdit||!selected||!valid||mode==="texture"&&!image} disabledReason={!selected?"Choose a GLB model":!valid?"Check scale and rotation":mode==="texture"&&!image?"Choose a texture image":undefined} onClick={()=>void apply()}/>:undefined}>

  <WorkflowDescription title={mode==="texture"?"Textures":mode==="mesh"?"Mesh tools":"3D viewer"}><Meta>{mode==="texture"?"Uses the model’s existing UV coordinates. No UV unwrapping, texture generation or material baking. Static GLB only; rigged and animated models are unsupported.":mode==="mesh"?"Saves a new static GLB. No retopology, decimation, repair or rigging. The source stays in Library.":"Orbit the actual Library model. No node editor or generation starts here."}</Meta></WorkflowDescription>

  <UploadSlot label="GLB model" hint={selected?.name??"Self-contained static GLB · up to 64 MB"} accept=".glb,model/gltf-binary" disabled={!!busy||!canEdit} onFile={f=>void upload(f,"model3d")}/>

  <LibraryChoice chosen={!!selected} value={source} disabled={!!busy} options={models.map(a=>({value:a.id,label:a.name,icon:<Suspense fallback={null}><Preview compact url={assetUrl(workspace.id,a.id)}/></Suspense>}))} onChange={id=>{setPreviewStatus("loading");setSource(id);setResult(undefined);}}/>

  {loading&&<ShimmerText>Reading Library</ShimmerText>}{cursor&&<Button variant="ghost" onClick={()=>void more()}>More Library assets</Button>}

  {mode==="texture"?<><TeamMediaInput label="Base-color texture" type="image" hint="Applied to existing UVs" accept="image/png,image/jpeg,image/webp" file={null} selected={image} options={images} disabled={!!busy||!canEdit} canUpload={canEdit} workspace={workspace.id} onFile={f=>void upload(f,"image")} onSelect={setTexture} onUpload={()=>{}}/></>:mode==="mesh"?<><TextField label="Scale multiplier" type="number" value={scale} min={0.01} max={100} disabled={!!busy} onChange={setScale}/><TextField label="Y rotation (degrees)" type="number" value={rotation} min={-360} max={360} disabled={!!busy} onChange={setRotation}/><Checkbox checked={center} disabled={!!busy} onChange={setCenter}>Center at origin</Checkbox></>:null}

  {mode==="viewer"&&shown&&<PanelSection label="Continue with"><Toolbar><Button variant="secondary" disabled={previewStatus!=="ready"||!!busy} onClick={()=>void continueFromView("edit")}>Image edit</Button><Button variant="secondary" disabled={previewStatus!=="ready"||!!busy} onClick={()=>void continueFromView("image")}>Image to 3D</Button><Button variant="ghost" disabled={!!busy} onClick={()=>{location.hash=threeDContinuationHash("texture",shown.id);}}>Textures</Button><Button variant="ghost" disabled={!!busy} onClick={()=>{location.hash=threeDContinuationHash("mesh",shown.id);}}>Mesh tools</Button></Toolbar></PanelSection>}

  {error&&<Notice priority={50} title="3D tool needs attention" actions={<Button variant="secondary" onClick={()=>setRetry(n=>n+1)}>Refresh Library</Button>}>{error}</Notice>}

 </Panel><Canvas toolbarStart={shown?<Meta>{result?"Saved result":"Source preview"} · {shown.name}</Meta>:undefined} footer={shown?<LinkButton variant="secondary" href={assetUrl(workspace.id,shown.id,true)}>Download GLB</LinkButton>:undefined}>{busy?<EmptyState stage title={busy} icon={<SparkleLoader label={busy}/>} text="Working locally; progress follows the actual processing stage."/>:shown?<Suspense fallback={<SparkleLoader label="Loading 3D viewer"/>}><Preview ref={preview} key={shown.id} url={assetUrl(workspace.id,shown.id)} standalone onStatusChange={onPreviewStatus}/></Suspense>:<EmptyState stage title="Your 3D model appears here" text="Choose a GLB from Library or upload one to preview it."/>}</Canvas></Split></Page>;

}
