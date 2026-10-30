import {useState} from "react";
import {Block,Button,ClampText,CompareWipe,Dialog,DriftOverlay,InfoButton,LinkButton,MaskOverlay,Meta,Notice,ResultGrid,StatusText,Toolbar} from "../../ds";
import type {PreservationRecord} from "../../capabilities/edit-preservation";
import {assetUrl,workspacePath,type Run} from "../../team/api";
import {RunDevelop} from "../../team/RunDevelop";

export type PrecisionResult={runId:string;record:PreservationRecord};

export function PrecisionReview({open,onClose,workspaceId,run,result,onCancel,onKeep,onRetake,working,errorMessage}:{open:boolean;onClose:()=>void;workspaceId:string;run:Run|null;result:PrecisionResult|null;onCancel:()=>Promise<void>;onKeep?:()=>Promise<void>;onRetake?:()=>Promise<void>;working?:boolean;errorMessage?:string}){
  const [overlay,setOverlay]=useState<"mask"|"drift"|null>("mask");
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const act=async(action:()=>Promise<void>)=>{setBusy(true);setError("");try{await action();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const p=result?.record,qa=p?.qa;
  const problem=error||errorMessage||(!p&&run?.state==="failed"?(run.error??"The worker did not publish a preservation result."):"");
  const cancellable=run&&["pending","submitting","submission_unknown","queued","running"].includes(run.state);
  return <Dialog wide open={open} title="Precision edit review" onClose={onClose} footer={<Toolbar>
    {cancellable&&<Button variant="secondary" disabled={busy} onClick={()=>void act(onCancel)}>Cancel</Button>}
    {onRetake&&!working&&run&&["succeeded","failed","canceled"].includes(run.state)&&<Button variant="secondary" disabled={busy} onClick={()=>void onRetake()}>Retake</Button>}
    {p&&onKeep&&<Button variant="primary" disabled={busy} onClick={()=>void act(onKeep)}>Keep candidate</Button>}
    <Button variant="secondary" onClick={onClose}>Close</Button>
  </Toolbar>}>
    <Block>
      {problem&&<Notice inline title="Precision edit needs attention" priority={90}>{problem}</Notice>}
      {p&&qa?<>
        <Toolbar>
          <Button variant="secondary" aria-pressed={overlay==="mask"} onClick={()=>{setError("");setOverlay(old=>old==="mask"?null:"mask");}}>Show mask</Button>
          <Button variant="secondary" aria-pressed={overlay==="drift"} onClick={()=>{setError("");setOverlay(old=>old==="drift"?null:"drift");}}>Show drift</Button>
          <LinkButton variant="secondary" href={assetUrl(workspaceId,p.finalAssetId,true)}>Download PNG</LinkButton>
          <LinkButton variant="secondary" href={`/api/v1${workspacePath(workspaceId,`runs/${result.runId}/provenance`)}`} download={`precision-${result.runId}.json`}>Provenance JSON</LinkButton>
          <InfoButton title="Preservation details"><ClampText text={p.report}/><Meta>Drift: sRGB8 RGB channels; delta &gt; 2/255; effective-mask pixels &gt; 0/255 excluded. Tolerance: 0.1 % of protected pixels. Alpha is not measured.</Meta></InfoButton>
        </Toolbar>
        {qa.withinTolerance?<StatusText tone="ok">Protected · {qa.driftPercent!.toFixed(3)} % drift</StatusText>
          :!problem&&<Notice inline title={qa.protectedPixels?"Edit leaked outside the mask":"Mask leaves no protected region"} priority={80}>
            {qa.protectedPixels?`${qa.driftPercent!.toFixed(3)} % of protected pixels exceed the declared channel tolerance. Review the drift overlay before keeping this result.`:"This mask does not allow a protected-region measurement. The result is retained for review."}
          </Notice>}
        <CompareWipe before={assetUrl(workspaceId,p.sourceAssetId)} after={assetUrl(workspaceId,p.finalAssetId)}
          overlay={overlay==="mask"?<MaskOverlay src={assetUrl(workspaceId,p.effectiveMaskAssetId)} onError={()=>setError("The effective mask could not be loaded.")}/>
            :overlay==="drift"?<DriftOverlay src={`/api/v1${workspacePath(workspaceId,`runs/${result.runId}/preservation/drift`)}`} onError={()=>setError("The drift overlay could not be loaded; its measurement is still recorded in provenance.")}/>:undefined}/>
      </>:run?<ResultGrid count={1} aspect={1} label="Precision run"><RunDevelop workspaceId={workspaceId} run={run}/></ResultGrid>:<StatusText tone="idle">Preparing aligned inputs</StatusText>}
    </Block>
  </Dialog>;
}
