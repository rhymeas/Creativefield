import {Collapsible,PanelSection,PromptField,SliderField,TextField,ToggleRow} from "../../ds";
import type {VideoEditDraft} from "./state";

export function ForwardExtensionFields({draft,ready,disabled,onChange,maxGenerationFrames=81}:{draft:VideoEditDraft;ready:boolean;disabled:boolean;maxGenerationFrames?:number;onChange:(next:VideoEditDraft)=>void}){
  const extending=Number(draft.extensionFrames??0)>0;
  if(!ready&&!extending)return null;
  const overlap=Number(draft.overlapFrames??5),maximum=Math.max(.25,Math.floor((maxGenerationFrames-(Number.isFinite(overlap)?overlap:5))/4)/4);
  return <PanelSection label="Continue the shot">
    <ToggleRow label="Extend ending" hint="Keep the selected source range and generate its continuation" checked={extending} disabled={disabled} onChange={value=>onChange({...draft,extensionFrames:value?"8":"0",overlapFrames:draft.overlapFrames??"5"})}/>
    {extending&&<>
      <SliderField label="Extend by" unit="s" min={.25} max={maximum} step={.25} value={Number(draft.extensionFrames)/16} disabled={disabled} onChange={value=>onChange({...draft,extensionFrames:String(Math.round(value*16))})}/>
      <PromptField label="Continuation" placeholder="Describe the same subjects, setting and movement in the next frames" value={draft.prompt??""} disabled={disabled} onChange={prompt=>onChange({...draft,prompt})}/>
      <Collapsible title="Advanced"><TextField label="Overlap frames" type="number" value={String(overlap)} disabled={disabled} onChange={value=>onChange({...draft,overlapFrames:value})}/></Collapsible>
    </>}
  </PanelSection>;
}
