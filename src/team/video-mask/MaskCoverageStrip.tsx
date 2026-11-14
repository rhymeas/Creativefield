import {Button,InfoButton,StatusText,Toolbar} from "../../ds";
import {flaggedMaskFrames,type MaskCoverage} from "../../capabilities/mask-coverage";

export function MaskCoverageStrip({report,value,onChange}:{report:MaskCoverage;value:number;onChange:(frame:number)=>void}){
  const pixels=report.width*report.height,flagged=flaggedMaskFrames(report);
  return <>
    <div className="cf-mask-coverage" role="group" aria-label="Tracking coverage">
      {report.frames.map((frame,index)=>{const state=frame.selectedPixels===0?"empty mask":frame.selectedPixels===pixels?"whole image selected":"partial selection";return <Button key={index} variant={value===index?"primary":"ghost"} aria-pressed={value===index} aria-label={`Frame ${index+1}: ${state}`} title={`Frame ${index+1}: ${state}`} tabIndex={value===index?0:-1} onClick={()=>onChange(index)} onKeyDown={event=>{const next=event.key==="Home"?0:event.key==="End"?report.frames.length-1:event.key==="ArrowRight"?Math.min(report.frames.length-1,index+1):event.key==="ArrowLeft"?Math.max(0,index-1):null;if(next===null)return;event.preventDefault();onChange(next);(event.currentTarget.parentElement?.children[next] as HTMLButtonElement|undefined)?.focus();}}><StatusText tone={flagged.includes(index)?"warn":"idle"}>·</StatusText></Button>;})}
    </div>
    <Toolbar>{flagged.length>0&&<Button variant="secondary" onClick={()=>onChange(flagged.find(frame=>frame>value)??flagged[0])}>Review flagged frames</Button>}<InfoButton title="Tracking coverage">Each mark comes from the actual decoded mask. Amber marks have no selected pixels or select the whole frame. Click a mark to inspect that frame; arrow keys move between marks. Coverage does not establish tracking accuracy: check edges and occlusions yourself. An object can be out of view. Reject and adjust tracking or upload a corrected mask when needed.</InfoButton></Toolbar>
  </>;
}
