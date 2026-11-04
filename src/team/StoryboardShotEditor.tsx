import {Fragment,useEffect,useRef,useState} from "react";
import {Button,Dialog,Notice,Params,ParamButton,PromptField,Row,TextField} from "../ds";
import {Clock,RectangleHorizontal} from "lucide-react";
import type {CapabilityManifestV2,Control} from "../capabilities/types";
import type {Asset,ReusableElement} from "./api";
import {TeamChoice} from "./TeamChoice";
import {TeamMediaInput} from "./TeamMediaInput";
import {characterElementOptions,elementBinding} from "./element-selection";
import {chooseWorkflow,storyboardCreationModels,type Shot} from "./storyboard-state";
import {insertReferenceMention} from "./prompt-reference";
import {readCameraPose,supportsH3PromptCamera,writeCameraPose} from "./camera-route";
import {CameraPoseField} from "../ds/CameraMovePicker";
import {assetUrl} from "./api";
import "../image/image.css";
import "../ds/reference-tag.css";

type ShotAudio=Shot["settings"]["audioPolicy"];
const shotAudioLabels:Record<ShotAudio,string>={mute:"Mute",preserve:"Keep the model's sound",replace:"Use the voice track",mix:"Mix with the source sound"};
/** A mute-only workflow has no sound to choose, so the row is left out entirely. */
export function shotAudioChoices(m:CapabilityManifestV2):Array<{value:ShotAudio;label:string}>{
  return m.audioPolicies.some(p=>p!=="mute")?m.audioPolicies.map(p=>({value:p,label:shotAudioLabels[p]})):[];
}

export function StoryboardModelChoice({shot,manifests,disabled,onChange}:{shot:Shot;manifests:CapabilityManifestV2[];disabled:boolean;onChange:(shot:Shot)=>void}){
  const m=manifests.find(item=>item.id===shot.settings.generation?.capabilityId);
  const choices=storyboardCreationModels(manifests);
  return <TeamChoice label="Shot workflow" variant="model" display={m?.title.split(" (")[0]??"Choose a workflow"} subtitle={m?.description??"Select a local generation workflow for this shot."} value={m?.id??""} options={choices.map(item=>({value:item.id,label:item.title,note:item.description}))} disabled={disabled} onChange={id=>{const selected=choices.find(item=>item.id===id);if(selected)onChange(chooseWorkflow(shot,selected));}}/>;
}

export function StoryboardShotEditor({shot,manifests,assets,elements,workspace,projectId,disabled,files,onChange,onFile,onUpload,onLoadMore,loadingMore,loadMoreError,hideModelChoice=false,picture}:{shot:Shot;/** The shot's current picture (its frame or start image), shown when aiming the camera. */picture?:string;manifests:CapabilityManifestV2[];assets:Asset[];elements:ReusableElement[];workspace:string;projectId?:string;disabled:boolean;files:Record<string,File|null>;onChange:(s:Shot)=>void;onFile:(role:string,file:File|null)=>void;onUpload:(role:string)=>void;onLoadMore?:()=>void;loadingMore?:boolean;loadMoreError?:string;hideModelChoice?:boolean}){
  const g=shot.settings.generation,m=manifests.find(m=>m.id===g?.capabilityId),[numeric,setNumeric]=useState(false),[durationOpen,setDurationOpen]=useState(false);
  const promptRef=useRef<HTMLTextAreaElement>(null);
  const startPicture=shot.assets.find(a=>a.role==="start_image")?.assetId;
  const imagePorts=m?.inputs.filter(p=>p.type==="image"&&(shot.assets.some(a=>a.role===p.id)||shot.settings.elementInputs[p.id]))??[];
  function mentionImage(id:string){const index=imagePorts.findIndex(p=>p.id===id);if(index<0||disabled)return;const area=promptRef.current,result=insertReferenceMention(shot.prompt,area?.selectionStart??shot.prompt.length,area?.selectionEnd??shot.prompt.length,`@Image ${index+1}`);onChange({...shot,prompt:result.value});requestAnimationFrame(()=>{promptRef.current?.focus();promptRef.current?.setSelectionRange(result.caret,result.caret);});}
  useEffect(()=>{if(disabled){setNumeric(false);setDurationOpen(false);}},[disabled]);
  function control(id:string,value:string|number|boolean){if(!g)return;onChange({...shot,settings:{...shot.settings,generation:{...g,controls:{...g.controls,[id]:value}}}});}
  function renderControl(c:Control){if(!g)return null;const value=g.controls[c.id]??c.default??"";if(c.disabledReason)return <Notice key={c.id} inline title={c.label}>{c.disabledReason}</Notice>;if(c.type==="string")return <PromptField key={c.id} label={c.label} compact value={String(value)} placeholder={c.label} onChange={v=>control(c.id,v)}/>;if(c.type==="boolean")return <Row key={c.id} label={c.label} value={String(value)} display={value?"On":"Off"} options={[{value:"true",label:"On"},{value:"false",label:"Off"}]} onChange={v=>control(c.id,v==="true")}/>;if(c.type==="select")return <Row key={c.id} label={c.label} value={String(value)} display={String(value||"Choose")} options={(c.options??[]).map(v=>({value:String(v),label:String(v)}))} onChange={v=>control(c.id,c.options?.find(option=>String(option)===v)??v)}/>;return <TextField key={c.id} label={c.label} type="number" min={c.min} max={c.max} step={c.step??(c.type==="integer"?1:"any")} value={String(value)} onChange={v=>control(c.id,v===""?"":Number(v))}/>;}
  const length=m?.controls.find(c=>c.id==="length"),seed=m?.controls.find(c=>c.id==="seed"),sizeControl=m?.controls.find(c=>["resolution","megapixels"].includes(c.id)&&c.type==="select"&&!c.disabledReason),sizes=Object.entries(m?.resolutions??{}),size=sizes.find(([,s])=>s.width===g?.controls.width&&s.height===g?.controls.height),advancedControls=m?.controls.filter(c=>!["prompt","length","width","height","seed","two_people",...(sizeControl?[sizeControl.id]:[])].includes(c.id))??[],audioChoices=m?shotAudioChoices(m):[];
  return <fieldset disabled={disabled} className="cf-fieldset ds-fieldset">
    {!hideModelChoice&&<StoryboardModelChoice shot={shot} manifests={manifests} disabled={disabled} onChange={onChange}/>}
    {m&&g&&<>
      {m.inputs.map(p=>{
        const label=p.id==="start_image"?"Start image":p.id==="end_image"?"End image":p.label,binding=shot.settings.elementInputs[p.id],element=elements.find(item=>item.id===binding?.elementId),elementAsset=element?.assets.find(item=>item.id===binding?.assetId);
        const characters=p.type==="image"?characterElementOptions(elements,p):[];
        /* A placed character replaces direct media for this port; "Use direct media" releases it again. */
        function placeCharacter(value:string){const elementInputs={...shot.settings.elementInputs},chosen=elementBinding(value);if(chosen)elementInputs[p.id]=chosen;else delete elementInputs[p.id];onChange({...shot,assets:shot.assets.filter(a=>a.role!==p.id),settings:{...shot.settings,elementInputs}});}
        const selected=assets.find(a=>a.id===shot.assets.find(a=>a.role===p.id)?.assetId),imageIndex=imagePorts.findIndex(port=>port.id===p.id);
        return <Fragment key={p.id}>
          {element&&elementAsset?<Button variant="ghost" disabled={disabled} onClick={()=>mentionImage(p.id)}>{label}: {element.name} · {elementAsset.name}{imageIndex>=0?` · @Image ${imageIndex+1}`:""}</Button>:<div className="cf-image-input"><TeamMediaInput projectId={projectId} onReferenceClick={p.type==="image"&&imageIndex>=0&&!files[p.id]?()=>mentionImage(p.id):undefined} onLoadMore={onLoadMore} loadingMore={loadingMore} loadMoreError={loadMoreError} label={label} type={p.type} file={files[p.id]??null} selected={selected} options={assets.filter(a=>a.content_type.startsWith(`${p.type}/`))} disabled={disabled} canUpload={!disabled} workspace={workspace} onFile={f=>onFile(p.id,f)} onSelect={id=>onChange({...shot,assets:[...shot.assets.filter(a=>a.role!==p.id),...(id?[{role:p.id,assetId:id}]:[])]})} onUpload={()=>onUpload(p.id)}/>{p.type==="image"&&selected&&!files[p.id]&&imageIndex>=0&&<Button variant="ghost" className="cf-image-reference-tag" disabled={disabled} aria-label={`Insert @Image ${imageIndex+1} into prompt`} onClick={()=>mentionImage(p.id)}>@Image {imageIndex+1}</Button>}</div>}
          {characters.length>0&&<TeamChoice label="Saved character" display={element?.name??"Choose"} value={binding?`${binding.elementId}:${binding.assetId}`:""} disabled={disabled} options={[{value:"",label:"Use direct media",note:"Choose or upload a project asset"},...characters]} onChange={placeCharacter}/>}
        </Fragment>;
      })}
      <PromptField textareaRef={promptRef} tokens={imagePorts.map((_,index)=>`@Image ${index+1}`)} label="Shot prompt" placeholder="Describe this shot" value={shot.prompt} onChange={prompt=>onChange({...shot,prompt})}/>
      {supportsH3PromptCamera(m)&&<CameraPoseField inline label="Camera" value={readCameraPose(shot.prompt)} src={picture??(startPicture?assetUrl(workspace,startPicture):undefined)} disabled={disabled} onChange={pose=>onChange({...shot,prompt:writeCameraPose(shot.prompt,pose)})}/>}
      <Params>{sizeControl?<ParamButton<string|number> disabled={disabled} title="Shot frame size" icon={<RectangleHorizontal size={16}/>} label={String(g.controls[sizeControl.id]??sizeControl.default??"Choose size")} value={(g.controls[sizeControl.id]??sizeControl.default??"") as string|number} onChange={value=>control(sizeControl.id,value)} options={(sizeControl.options??[]).map(value=>({value,label:String(value)}))}/>:sizes.length>0&&<ParamButton disabled={disabled} title="Shot frame size" icon={<RectangleHorizontal size={16}/>} label={size?.[0]??"Choose size"} value={size?.[0]??""} onChange={id=>{const s=m.resolutions![id];onChange({...shot,settings:{...shot.settings,generation:{...g,controls:{...g.controls,width:s.width,height:s.height}}}});}} options={sizes.map(([id,s])=>({value:id,label:id,note:`${s.width} × ${s.height}`}))}/>}<ParamButton<string|number> disabled={disabled} title="Shot duration" icon={<Clock size={16}/>} label={`${shot.durationSeconds}s`} value={shot.durationSeconds} options={[...Array.from({length:Math.floor((length?.max??10)-(length?.min??1))+1},(_,i)=>({value:i+(length?.min??1),label:`${i+(length?.min??1)} seconds`})),{value:"custom",label:"Custom duration…"}]} onChange={v=>{if(v==="custom")setDurationOpen(true);else onChange({...shot,durationSeconds:v});}}/></Params>
      <Row subtle label="Advanced settings" display="Optional controls" disabled={disabled} onClick={()=>setNumeric(true)}/>
    </>}
    {shot.settings.cameraHint&&<Notice title="Unbound camera hint" actions={<><Button variant="secondary" disabled={disabled} onClick={()=>onChange({...shot,prompt:[shot.prompt,shot.settings.cameraHint].filter(Boolean).join("\n"),settings:{...shot.settings,cameraHint:""}})}>Move hint into prompt</Button><Button variant="secondary" disabled={disabled} onClick={()=>onChange({...shot,settings:{...shot.settings,cameraHint:""}})}>Clear camera hint</Button></>}>{shot.settings.cameraHint}</Notice>}
    <Dialog className="ds-advanced-dialog" wide open={numeric&&!disabled&&!!m&&!!g} title="Advanced shot settings" onClose={()=>setNumeric(false)} footer={<Button variant="primary" onClick={()=>setNumeric(false)}>Done</Button>}><div className="cf-form">{seed&&<TextField label="Seed" type="number" step={1} min={seed.min} max={seed.max} value={String(g?.controls.seed??seed.default??"")} onChange={v=>control("seed",v===""?"":Number(v))}/>}{advancedControls.map(renderControl)}{audioChoices.length>0&&<Row label="Shot audio" display={shotAudioLabels[shot.settings.audioPolicy]} value={shot.settings.audioPolicy} options={audioChoices} onChange={p=>onChange({...shot,settings:{...shot.settings,audioPolicy:p}})} disabled={disabled}/>}</div></Dialog>
    <Dialog open={durationOpen&&!disabled} title="Shot duration" onClose={()=>setDurationOpen(false)} footer={<Button variant="primary" onClick={()=>setDurationOpen(false)}>Done</Button>}><TextField label="Duration in seconds" type="number" step="any" min={length?.min} max={length?.max} value={String(shot.durationSeconds)} onChange={v=>onChange({...shot,durationSeconds:v===""?"":Number(v)})}/></Dialog>
  </fieldset>;
}
