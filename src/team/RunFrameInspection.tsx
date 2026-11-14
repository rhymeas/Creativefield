import {useEffect,useRef,useState} from "react";
import {Button,Collapsible,InbetweenRail,Meta,Notice} from "../ds";
import {ApiError,assetUrl,workspacePath,type Call} from "./api";
import {downloadJson} from "./TeamLibrary";

export type FrameInspection={version:number;runId:string;sourceAssetId:string;sourceSha256:string;firstInputAssetId:string;lastInputAssetId:string;frameCount:number;durationSeconds:number;frames:Array<{index:number;assetId:string;sha256:string}>;measurement:{firstSourceDelta:{meanAbsoluteRgb8:number};lastSourceDelta:{meanAbsoluteRgb8:number};duplicatePairs:Array<{from:number;to:number}>;adjacent:Array<{from:number;to:number;meanAbsoluteRgb8:number}>}};
export function RunFrameInspection({workspace,runId,call,authorized,canEdit}:{workspace:string;runId:string;call:Call;authorized:boolean;canEdit:boolean}){
  const [result,setResult]=useState<FrameInspection|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const alive=useRef(true),controller=useRef<AbortController|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
  useEffect(()=>{if(!authorized)return;const abort=new AbortController();setResult(null);void call<FrameInspection|null>(workspacePath(workspace,`runs/${runId}/frames`),"GET",undefined,{signal:abort.signal}).then(value=>{if(!abort.signal.aborted)setResult(value);}).catch(e=>{if(!abort.signal.aborted&&!(e instanceof ApiError&&e.status===404))setError((e as Error).message);});return()=>abort.abort();},[authorized,call,workspace,runId]);
  async function inspect(){if(busy||!canEdit||!authorized)return;setBusy(true);setError("");const abort=new AbortController();controller.current=abort;
    try{const value=await call<FrameInspection>(workspacePath(workspace,`runs/${runId}/frames`),"POST",{},{signal:abort.signal,timeoutMs:120000});if(alive.current)setResult(value);}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy(false);}
  }
  const largest=result?.measurement.adjacent.reduce((a,b)=>a.meanAbsoluteRgb8>b.meanAbsoluteRgb8?a:b);
  return <div className="cf-form">
    {!result?<Button variant="secondary" disabled={!canEdit||!authorized||busy} onClick={()=>void inspect()}>{busy?"Extracting actual frames…":"Inspect generated frames"}</Button>:<>
      <InbetweenRail first={assetUrl(workspace,result.firstInputAssetId)} last={assetUrl(workspace,result.lastInputAssetId)} frames={result.frameCount} images={result.frames.map(f=>assetUrl(workspace,f.assetId))} imageFrameIndices={result.frames.map(f=>f.index)} label="Extracted output frames" caption={`${result.frames.length} sampled images from ${result.frameCount} decoded frames · ${result.durationSeconds.toFixed(3)}s at 16 FPS. Bookends show the frozen input images.`}/>
      <Collapsible title="Frame diagnostics"><div className="cf-form">
        <Meta>{result.measurement.duplicatePairs.length} adjacent frame pairs with matching decoded hashes. {largest?`Largest sampled RGB change: frame ${largest.from} → ${largest.to}, ${largest.meanAbsoluteRgb8.toFixed(2)} / 255.`:""}</Meta>
        <Meta>First / last input RGB difference: {result.measurement.firstSourceDelta.meanAbsoluteRgb8.toFixed(2)} / {result.measurement.lastSourceDelta.meanAbsoluteRgb8.toFixed(2)} (0–255). Centered bilinear reference fit; these diagnostics do not score semantic quality or guarantee a seamless transition.</Meta>
        <Button variant="ghost" onClick={()=>downloadJson(result,`comfyfield-frames-${runId}.json`)}>Download frame report</Button>
      </div></Collapsible>
    </>}
    {error&&<Notice priority={60} title="The frames could not be read" actions={<Button variant="secondary" disabled={busy||!canEdit||!authorized} onClick={()=>void inspect()}>Inspect again</Button>} details={error}>Nothing was changed. Inspecting again reads the same run and keeps any finished inspection.</Notice>}
  </div>;
}
