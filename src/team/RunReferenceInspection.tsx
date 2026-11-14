import {useEffect,useRef,useState} from "react";
import {Block,Button,Dialog,FrameStrip,Meta,Notice,ResultGrid,ResultTile,ShimmerText} from "../ds";
import {assetUrl,workspacePath,type Call,type Run} from "./api";
import type {ApiGraph} from "../workflow/build";
import {downloadJson} from "./TeamLibrary";

/** Existing input/output evidence plus an explicit export of the saved preparation
 * graph. Opening this view performs GETs only; it never submits a model job. */
export function RunReferenceInspection({workspace,run,call}:{workspace:string;run:Run;call:Call}){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [inspection,setInspection]=useState<{runId:string;graph:ApiGraph}|null>(null);
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>()=>controller.current?.abort(),[workspace,run.id]);
  async function show(){
    setOpen(true);setError("");setInspection(null);setBusy(true);
    controller.current?.abort();const abort=new AbortController();controller.current=abort;
    try{
      const result=await call<{runId:string;graph:ApiGraph}>(workspacePath(workspace,`runs/${run.id}/reference-inspection`),"GET",undefined,{signal:abort.signal});
      if(!abort.signal.aborted)setInspection(result);
    }catch(e){if(!abort.signal.aborted)setError((e as Error).message);}
    finally{if(!abort.signal.aborted)setBusy(false);}
  }
  function close(){controller.current?.abort();setBusy(false);setOpen(false);}
  const inputs=run.invocation?.inputs??{};
  const references=["character_image","character_image_2"].flatMap((role,i)=>inputs[role]?[{src:assetUrl(workspace,inputs[role]),label:`Original reference ${i+1}`}]:[]);
  const roles:Record<string,string>={reference_frame:"Reference frame",reference_mask:"Reference mask",source_mask:"Clip mask",first_frame:"First generated frame"};
  const captured=((run as Run&{extras?:Array<{role:string;assetId:string}>}).extras??[]).filter(e=>roles[e.role]).map(e=>({src:assetUrl(workspace,e.assetId),label:roles[e.role]}));
  return <>
    <Button variant="secondary" onClick={()=>void show()}>Inspect references</Button>
    <Dialog wide open={open} title="Reference inspection" onClose={close} footer={<>
      {inspection&&<Button variant="secondary" onClick={()=>downloadJson(inspection.graph,`comfyfield-reference-inspection-${run.id}.json`)}>Export inspection</Button>}
      <Button variant="ghost" onClick={close}>Close</Button>
    </>}>
      <Block>
        {references.length>0&&<FrameStrip label="Uploaded references" items={references}/>}
        {captured.length>0&&<FrameStrip label="Captured model inputs" items={captured}/>}
        <ResultGrid count={inputs.source_video&&run.output_ids[0]?2:1} aspect={0} label="Source and existing result">
          {inputs.source_video&&<ResultTile caption="Submitted source"><video controls preload="metadata" src={assetUrl(workspace,inputs.source_video)} aria-label="Submitted source video"/></ResultTile>}
          {run.output_ids[0]&&<ResultTile caption="Existing result"><video controls preload="metadata" src={assetUrl(workspace,run.output_ids[0])} aria-label="Existing result video"/></ResultTile>}
        </ResultGrid>
        {!captured.length&&<Meta>Prepared reference images and identity masks were not saved with this run. The images above are the original uploads.</Meta>}
        {busy&&<ShimmerText>Reading saved preparation…</ShimmerText>}
        {inspection&&<Meta>Export saves the reference images and masks from this run’s first window when queued in ComfyUI. Tracking uses the GPU; video generation and upscaling are excluded. Exporting alone starts no job.</Meta>}
        {error&&<Notice priority={30} inline title="Inspection export unavailable">{error}</Notice>}
      </Block>
    </Dialog>
  </>;
}
