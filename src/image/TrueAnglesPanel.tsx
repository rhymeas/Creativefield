import {useEffect,useRef,useState} from "react";
import {Button,CameraAngleSheet,ContactSheet,Dialog,InfoButton,Meta,Notice,SegmentedTabs,StatusText,Toolbar} from "../ds";
import {assetUrl,workspacePath,type Asset,type Call,type Project,type Run,type Workspace} from "../team/api";
import {activeRun} from "../team/state";
import {freezeTrueAngles,meshCapability,meshRunRequest,paintRunRequest,pendingPaints,recoverTrueAngles,retryPaint,trueAnglesStorageKey,MESH_CAPABILITIES,TRUE_VIEWS,type MeshCapabilityId,type TrueAngles,type TrueViewId} from "./true-angles";
import {renderOrbitViews} from "./orbit-render";
import {OrbitPreview} from "./OrbitPreview";

const FAILED=["failed","canceled","cancelled"];

/** F01 true angles: real geometry from a 3D model of the source, each view painted to match the source. */
export function TrueAnglesPanel({workspace,project,userId,workerId,call,sourceAssetId,disabled,onChanged}:{workspace:Workspace;project:Project;userId:string;workerId:string;call:Call;sourceAssetId?:string;disabled?:boolean;onChanged:()=>void}){
  const scope={workspaceId:workspace.id,projectId:project.id,userId,workerId},storageKey=trueAnglesStorageKey(scope),mounted=useRef(true),working=useRef(false);
  const load=()=>{try{return sourceAssetId?recoverTrueAngles(JSON.parse(sessionStorage.getItem(storageKey)??"null"),scope,sourceAssetId):null;}catch{return null;}};
  const [state,setState]=useState<TrueAngles|null>(load);
  const [runs,setRuns]=useState<Record<string,Run>>({}),[selected,setSelected]=useState<TrueViewId[]>(["left-45","right-45"]);
  const [busy,setBusy]=useState(""),[error,setError]=useState(""),[sheet,setSheet]=useState(false);
  const [model,setModel]=useState<MeshCapabilityId>(MESH_CAPABILITIES[0].id);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(state&&state.sourceAssetId!==sourceAssetId){setState(null);setRuns({});return;}if(!state&&sourceAssetId){const saved=load();if(saved)setState(saved);}},[sourceAssetId]);
  const persist=(next:TrueAngles)=>{sessionStorage.setItem(storageKey,JSON.stringify(next));setState(next);};
  const ids=state?[state.meshRunId,...Object.values(state.paintRunIds)].filter((id):id is string=>!!id):[];
  // Follow submitted runs only while one is still working.
  useEffect(()=>{
    if(!ids.length)return;let live=true,timer=0;
    const tick=async()=>{
      const next:Record<string,Run>={};
      await Promise.all(ids.map(async id=>{try{next[id]=await call<Run>(workspacePath(workspace.id,`runs/${id}`));}catch{}}));
      if(!live||!mounted.current)return;
      setRuns(old=>({...old,...next}));
      if(Object.values(next).some(run=>activeRun(run.state)))timer=window.setTimeout(tick,3000);
    };
    void tick();return()=>{live=false;window.clearTimeout(timer);};
  },[ids.join()]);
  const mesh=state?.meshRunId?runs[state.meshRunId]:undefined,meshAsset=mesh?.state==="succeeded"?mesh.output_ids[0]:undefined;
  // Once the model exists, render all eight views from it and keep them as images linked to the source.
  useEffect(()=>{
    if(!state||!meshAsset||Object.keys(state.renders).length||working.current)return;
    working.current=true;setBusy("render");setError("");
    (async()=>{
      try{
        const views=await renderOrbitViews(assetUrl(workspace.id,meshAsset),TRUE_VIEWS);
        const renders:TrueAngles["renders"]={};
        for(const view of views){
          const form=new FormData();form.append("file",new File([view.blob],`true-angle-${view.id}.png`,{type:"image/png"}));
          const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${encodeURIComponent(project.id)}&kind=image&parentId=${encodeURIComponent(state.sourceAssetId)}`),"POST",form);
          renders[view.id as TrueViewId]=asset.id;URL.revokeObjectURL(view.url);
        }
        if(mounted.current){persist({...state,renders});onChanged();}
      }catch(e){if(mounted.current)setError(`The 3D views could not be rendered: ${(e as Error).message}`);}
      finally{working.current=false;if(mounted.current)setBusy("");}
    })();
  },[meshAsset,state?.id]);
  async function buildModel(){
    if(working.current||!sourceAssetId)return;working.current=true;setBusy("mesh");setError("");
    try{
      // A failed model gets a fresh request (new key), otherwise the server would hand back the failed run.
      const next=!state||meshFailed?freezeTrueAngles(sourceAssetId,scope,undefined,model):state.meshRunId?state:{...state,meshCapabilityId:model};persist(next);
      const run:Run=await call<Run>(workspacePath(workspace.id,"runs"),"POST",meshRunRequest(next));
      persist({...next,meshRunId:run.id});setRuns(old=>({...old,[run.id]:run}));onChanged();
    }catch(e){setError((e as Error).message);}finally{working.current=false;if(mounted.current)setBusy("");}
  }
  async function paint(){
    if(working.current||!state)return;working.current=true;setBusy("paint");setError("");
    let current=state;
    try{
      for(const view of pendingPaints(current,selected,paintFailed)){
        if(!mounted.current)break;
        if(paintFailed(view))current=retryPaint(current,view);
        const run:Run=await call<Run>(workspacePath(workspace.id,"runs"),"POST",paintRunRequest(current,view));
        current={...current,paintRunIds:{...current.paintRunIds,[view]:run.id}};persist(current);setRuns(old=>({...old,[run.id]:run}));onChanged();
      }
    }catch(e){if(mounted.current)setError(`${(e as Error).message} Painting again resends only the views that were not accepted.`);}
    finally{working.current=false;if(mounted.current)setBusy("");}
  }
  function reset(){try{sessionStorage.removeItem(storageKey);}catch{}setState(null);setRuns({});setError("");}
  function paintRun(view:TrueViewId){return state?.paintRunIds[view]?runs[state.paintRunIds[view]!]:undefined;}
  function paintFailed(view:TrueViewId){const run=paintRun(view);return !!run&&FAILED.includes(run.state);}
  const items=TRUE_VIEWS.map(view=>{
    const run=paintRun(view.id),painted=run?.state==="succeeded"?run.output_ids[0]:undefined,render=state?.renders[view.id];
    const status=painted?`Painted${run?.take?` · Take ${run.take}`:""}`:run&&activeRun(run.state)?"Painting":run&&FAILED.includes(run.state)?(run.state==="failed"?"Paint failed":"Canceled"):render?"Geometry":undefined;
    return {id:view.id,label:view.label,src:painted?assetUrl(workspace.id,painted):render?assetUrl(workspace.id,render):undefined,status};
  });
  const meshWorking=!!mesh&&activeRun(mesh.state),meshFailed=!!mesh&&FAILED.includes(mesh.state),rendered=!!state&&Object.keys(state.renders).length>0;
  const toPaint=state?pendingPaints(state,selected,paintFailed):[];
  const anyWorking=!!busy||meshWorking||Object.values(state?.paintRunIds??{}).some(id=>runs[id]&&activeRun(runs[id].state));
  const source=sourceAssetId?assetUrl(workspace.id,sourceAssetId):undefined;
  return <div className="cf-form">
    {!state?.meshRunId&&!anyWorking&&<SegmentedTabs label="3D model" value={model} onChange={value=>setModel(value as MeshCapabilityId)} items={MESH_CAPABILITIES.map(item=>({id:item.id,label:item.label}))}/>}
    <Toolbar>
      {!disabled&&sourceAssetId&&!anyWorking&&(!state?.meshRunId||meshFailed)&&<Button variant="secondary" onClick={()=>void buildModel()}>{meshFailed?"Build 3D model again":"Build 3D model"}</Button>}
      {rendered&&!anyWorking&&toPaint.length>0&&!disabled&&<Button variant="secondary" onClick={()=>void paint()}>{`Paint ${toPaint.length} ${toPaint.length===1?"view":"views"}`}</Button>}
      {items.some(item=>item.src)&&<Button variant="secondary" onClick={()=>setSheet(true)}>Contact sheet</Button>}
      {state&&!anyWorking&&<Button variant="ghost" onClick={reset}>Start over</Button>}
      <InfoButton title="True angles"><Meta>A local 3D model turns the subject into a mesh, and each angle is rendered from that real geometry, so the viewpoint is exact. TRELLIS.2 builds the mesh with its own colors and materials, so its views can be used directly; painting is optional. Hunyuan3D builds shape only, so each chosen view is painted to match your image with the local Qwen guided edit, which can change small details. Works best with one clear subject. Hunyuan3D 2.1 is not licensed in the EU, the UK or South Korea; TRELLIS.2 has no such limit.</Meta></InfoButton>
      {mesh&&<StatusText tone={mesh.state==="succeeded"?"ok":meshFailed?"warn":"active"}>{`${meshCapability(state?.meshCapabilityId).label.split(" ·")[0]} · ${mesh.state==="succeeded"?"ready":meshFailed?"failed":"building"}${mesh.take?` · Take ${mesh.take}`:""}`}</StatusText>}
      {busy==="render"&&<StatusText tone="active">Rendering views</StatusText>}
    </Toolbar>
    {!sourceAssetId?<Meta>Choose a source image to build its 3D model.</Meta>:disabled&&!state&&<Meta>The local worker is not ready yet.</Meta>}
    {rendered&&meshAsset&&<OrbitPreview url={assetUrl(workspace.id,meshAsset)}/>}
    {rendered&&<CameraAngleSheet items={items} source={{src:source}} selected={selected} disabled={anyWorking} onChange={next=>setSelected(next as TrueViewId[])} label="True camera angles"/>}
    {rendered&&toPaint.length===0&&!anyWorking&&<Meta>Select views that are not painted yet to paint them.</Meta>}
    {(error||meshFailed)&&<Notice title="The 3D model didn't finish" actions={<Button variant="secondary" disabled={!sourceAssetId||busy==="mesh"} onClick={()=>void buildModel()}>Try again</Button>} details={error||mesh?.error||undefined}>{error||"Building the 3D model stopped before it produced anything. Trying again uses this picture; a picture with one clear subject works best."}</Notice>}
    <Dialog wide open={sheet} title="True angles contact sheet" onClose={()=>setSheet(false)} footer={<Button variant="secondary" onClick={()=>setSheet(false)}>Close</Button>}>
      <ContactSheet items={[{src:source,label:"Original"},...items.filter(item=>item.src).map(item=>({src:item.src,label:`${item.label} · ${item.status}`}))]} fileName="true-angles-contact-sheet.png"/>
    </Dialog>
  </div>;
}
