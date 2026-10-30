import {Fragment,useEffect,useState} from "react";
import {Button,Dialog,Meta,Notice,Params,ParamButton,PromptField,Row,TextField} from "../ds";
import {Clock,RectangleHorizontal} from "lucide-react";
import type {CapabilityManifestV2,Control} from "../capabilities/types";
import type {Asset,ReusableElement} from "./api";
import {TeamChoice} from "./TeamChoice";
import {TeamMediaInput} from "./TeamMediaInput";
import {characterElementOptions,elementBinding} from "./element-selection";
import {chooseWorkflow,type Shot} from "./storyboard-state";

type ShotAudio=Shot["settings"]["audioPolicy"];
const shotAudioLabels:Record<ShotAudio,string>={mute:"Mute",preserve:"Keep the model's sound",replace:"Use the voice track",mix:"Mix with the source sound"};
/** A mute-only workflow has no sound to choose, so the row is left out entirely. */
export function shotAudioChoices(m:CapabilityManifestV2):Array<{value:ShotAudio;label:string}>{
  return m.audioPolicies.some(p=>p!=="mute")?m.audioPolicies.map(p=>({value:p,label:shotAudioLabels[p]})):[];
}

export function StoryboardShotEditor({shot,manifests,assets,elements,workspace,disabled,files,onChange,onFile,onUpload}:{shot:Shot;manifests:CapabilityManifestV2[];assets:Asset[];elements:ReusableElement[];workspace:string;disabled:boolean;files:Record<string,File|null>;onChange:(s:Shot)=>void;onFile:(role:string,file:File|null)=>void;onUpload:(role:string)=>void}){
  const g=shot.settings.generation,m=manifests.find(m=>m.id===g?.capabilityId),[numeric,setNumeric]=useState(false),[durationOpen,setDurationOpen]=useState(false);
  useEffect(()=>{if(disabled){setNumeric(false);setDurationOpen(false);}},[disabled]);
  function control(id:string,value:string|number|boolean){if(!g)return;onChange({...shot,settings:{...shot.settings,generation:{...g,controls:{...g.controls,[id]:value}}}});}
  function renderControl(c:Control){if(!g)return null;const value=g.controls[c.id]??c.default??"";if(c.disabledReason)return <Notice key={c.id} inline title={c.label}>{c.disabledReason}</Notice>;if(c.type==="string")return <PromptField key={c.id} label={c.label} compact value={String(value)} placeholder={c.label} onChange={v=>control(c.id,v)}/>;if(c.type==="boolean")return <Row key={c.id} label={c.label} value={String(value)} display={value?"On":"Off"} options={[{value:"true",label:"On"},{value:"false",label:"Off"}]} onChange={v=>control(c.id,v==="true")}/>;if(c.type==="select")return <Row key={c.id} label={c.label} value={String(value)} display={String(value||"Choose")} options={(c.options??[]).map(v=>({value:String(v),label:String(v)}))} onChange={v=>control(c.id,c.options?.find(option=>String(option)===v)??v)}/>;return <TextField key={c.id} label={c.label} type="number" min={c.min} max={c.max} step={c.step??(c.type==="integer"?1:"any")} value={String(value)} onChange={v=>control(c.id,v===""?"":Number(v))}/>;}
  const length=m?.controls.find(c=>c.id==="length"),seed=m?.controls.find(c=>c.id==="seed"),sizes=Object.entries(m?.resolutions??{}),size=sizes.find(([,s])=>s.width===g?.controls.width&&s.height===g?.controls.height),advancedControls=m?.controls.filter(c=>!["prompt","length","width","height","seed","two_people"].includes(c.id))??[],audioChoices=m?shotAudioChoices(m):[];
  return <fieldset disabled={disabled} className="cf-fieldset ds-fieldset">
    <TextField label="Shot title" value={shot.settings.title??""} onChange={title=>onChange({...shot,settings:{...shot.settings,title}})}/>
    <TeamChoice label="Shot workflow" variant="model" display={m?.title.split(" (")[0]??"Choose a workflow"} subtitle={m?.description??"Select a local generation workflow for this shot."} value={m?.id??""} options={manifests.map(m=>({value:m.id,label:m.title,note:m.description}))} disabled={disabled} onChange={id=>{const selected=manifests.find(m=>m.id===id);if(selected)onChange(chooseWorkflow(shot,selected));}}/>
    {m&&g&&<>
      {m.inputs.map(p=>{
        const label=p.id==="start_image"?"Start image":p.id==="end_image"?"End image":p.label,binding=shot.settings.elementInputs[p.id],element=elements.find(item=>item.id===binding?.elementId),elementAsset=element?.assets.find(item=>item.id===binding?.assetId);
        const characters=p.type==="image"?characterElementOptions(elements,p):[];
        /* A placed character replaces direct media for this port; "Use direct media" releases it again. */
        function placeCharacter(value:string){const elementInputs={...shot.settings.elementInputs},chosen=elementBinding(value);if(chosen)elementInputs[p.id]=chosen;else delete elementInputs[p.id];onChange({...shot,assets:shot.assets.filter(a=>a.role!==p.id),settings:{...shot.settings,elementInputs}});}
        return <Fragment key={p.id}>
          {element&&elementAsset?<Meta>{label}: {element.name} · {elementAsset.name}</Meta>:<TeamMediaInput label={label} type={p.type} file={files[p.id]??null} selected={assets.find(a=>a.id===shot.assets.find(a=>a.role===p.id)?.assetId)} options={assets.filter(a=>a.content_type.startsWith(`${p.type}/`))} disabled={disabled} canUpload={!disabled} workspace={workspace} onFile={f=>onFile(p.id,f)} onSelect={id=>onChange({...shot,assets:[...shot.assets.filter(a=>a.role!==p.id),...(id?[{role:p.id,assetId:id}]:[])]})} onUpload={()=>onUpload(p.id)}/>}
          {characters.length>0&&<TeamChoice label="Saved character" display={element?.name??"Choose"} value={binding?`${binding.elementId}:${binding.assetId}`:""} disabled={disabled} options={[{value:"",label:"Use direct media",note:"Choose or upload a project asset"},...characters]} onChange={placeCharacter}/>}
        </Fragment>;
      })}
      <PromptField label="Shot prompt" placeholder="Describe this shot" value={shot.prompt} onChange={prompt=>onChange({...shot,prompt})}/>
      <Params><ParamButton<string|number> disabled={disabled} title="Shot duration" icon={<Clock size={16}/>} label={`${shot.durationSeconds}s`} value={shot.durationSeconds} options={[...Array.from({length:Math.floor((length?.max??10)-(length?.min??1))+1},(_,i)=>({value:i+(length?.min??1),label:`${i+(length?.min??1)} seconds`})),{value:"custom",label:"Custom duration…"}]} onChange={v=>{if(v==="custom")setDurationOpen(true);else onChange({...shot,durationSeconds:v});}}/></Params>
      <Row subtle label="Advanced settings" display={size?.[0]??"Optional controls"} disabled={disabled} onClick={()=>setNumeric(true)}/>
    </>}
    {shot.settings.cameraHint&&<Notice title="Unbound camera hint" actions={<><Button variant="secondary" disabled={disabled} onClick={()=>onChange({...shot,prompt:[shot.prompt,shot.settings.cameraHint].filter(Boolean).join("\n"),settings:{...shot.settings,cameraHint:""}})}>Move hint into prompt</Button><Button variant="secondary" disabled={disabled} onClick={()=>onChange({...shot,settings:{...shot.settings,cameraHint:""}})}>Clear camera hint</Button></>}>{shot.settings.cameraHint}</Notice>}
    <Dialog wide open={numeric&&!disabled&&!!m&&!!g} title="Advanced shot settings" onClose={()=>setNumeric(false)} footer={<Button variant="primary" onClick={()=>setNumeric(false)}>Done</Button>}><div className="cf-form">{sizes.length>0&&<ParamButton disabled={disabled} title="Shot frame size" icon={<RectangleHorizontal size={16}/>} label={size?.[0]??"Choose size"} value={size?.[0]??""} onChange={id=>{const s=m!.resolutions![id];onChange({...shot,settings:{...shot.settings,generation:{...g!,controls:{...g!.controls,width:s.width,height:s.height}}}});}} options={sizes.map(([id,s])=>({value:id,label:id,note:`${s.width} × ${s.height}`}))}/>}{seed&&<TextField label="Seed" type="number" step={1} min={seed.min} max={seed.max} value={String(g?.controls.seed??seed.default??"")} onChange={v=>control("seed",v===""?"":Number(v))}/>}{advancedControls.map(renderControl)}{audioChoices.length>0&&<Row label="Shot audio" display={shotAudioLabels[shot.settings.audioPolicy]} value={shot.settings.audioPolicy} options={audioChoices} onChange={p=>onChange({...shot,settings:{...shot.settings,audioPolicy:p}})} disabled={disabled}/>}</div></Dialog>
    <Dialog open={durationOpen&&!disabled} title="Shot duration" onClose={()=>setDurationOpen(false)} footer={<Button variant="primary" onClick={()=>setDurationOpen(false)}>Done</Button>}><TextField label="Duration in seconds" type="number" step="any" min={length?.min} max={length?.max} value={String(shot.durationSeconds)} onChange={v=>onChange({...shot,durationSeconds:v===""?"":Number(v)})}/></Dialog>
  </fieldset>;
}
