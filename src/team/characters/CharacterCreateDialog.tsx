import {useEffect,useMemo,useRef,useState} from "react";
import {Button,Dialog,Meta,Notice,PanelSection,SearchField,TextField,Thumb,ThumbGrid} from "../../ds";
import {assetUrl,type Asset,type Call,type CharacterRecord,type CreatedCharacter,type Project,type Workspace} from "../api";
import {characterCreateBody,characterPath,requestCharacterDialogClose,updateReferenceSelection} from "./state";

export function CharacterCreateDialog({open,onClose,onCreated,workspace,project,assets,call}:{open:boolean;onClose:()=>void;onCreated:(record:CharacterRecord)=>void;workspace:Workspace;project:Project;assets:Asset[];call:Call}){
  const [name,setName]=useState(""),[description,setDescription]=useState(""),[selected,setSelected]=useState<string[]>([]),[search,setSearch]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[attempted,setAttempted]=useState(false);
  const input=useRef<HTMLInputElement>(null),intent=useRef<{fingerprint:string;key:string}|null>(null);
  useEffect(()=>{if(open)requestAnimationFrame(()=>input.current?.focus());else {setName("");setDescription("");setSelected([]);setSearch("");setError("");setAttempted(false);intent.current=null;}},[open]);
  const eligible=useMemo(()=>assets.filter(asset=>["image","reference"].includes(asset.media_type)),[assets]);
  const shown=useMemo(()=>{const query=search.trim().toLowerCase();return query?eligible.filter(asset=>asset.name.toLowerCase().includes(query)):eligible;},[eligible,search]);
  const valid=!!name.trim()&&selected.length>0&&!busy;
  const toggle=(id:string,value:boolean)=>setSelected(current=>updateReferenceSelection(current,id,value));
  const requestClose=()=>{requestCharacterDialogClose(busy,onClose);};
  async function create(){
    if(!valid){setAttempted(true);return;}
    setBusy(true);setError("");
    try{
      const fingerprint=JSON.stringify([name.trim(),description.trim(),selected]);
      if(intent.current?.fingerprint!==fingerprint)intent.current={fingerprint,key:crypto.randomUUID()};
      const result=await call<CreatedCharacter>(characterPath(workspace.id,project.id),"POST",characterCreateBody(name,description,selected,intent.current.key));
      intent.current=null;
      onCreated(result);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const nameError=attempted&&!name.trim()?"Enter a name.":undefined;
  const referenceError=attempted&&!selected.length?"Select at least one project or shared image.":"";
  return <Dialog open={open} title="New character" onClose={requestClose} footer={<><Button variant="ghost" disabled={busy} onClick={requestClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={()=>void create()}>{busy?"Creating":"Create character"}</Button></>}>
    {error&&<Notice inline priority={60} title="Character was not created" details={error}>Nothing was saved. The name and pictures are still here, so creating again reuses them with the same request.</Notice>}
    <TextField inputRef={input} label="Name" required maxLength={120} value={name} onChange={setName} error={nameError}/>
    <TextField label="Description" maxLength={200} value={description} onChange={setDescription} hint="Optional. One line about who this is."/>
    <PanelSection label="Reference images" meta={<Meta parts={[`${selected.length} of 16 selected`,"Locked once created"]}/>}>
      {eligible.length>8&&<SearchField label="Search reference images" value={search} onChange={setSearch} placeholder="Search images"/>}
      <ThumbGrid label="Reference images">
        {shown.map(asset=>{const checked=selected.includes(asset.id);return <Thumb key={asset.id} src={assetUrl(workspace.id,asset.id)} label={asset.name} info={<><span>{asset.name}</span><Meta>{asset.project_id===null?"Shared image":"Project image"}</Meta></>} selected={checked} disabled={!checked&&selected.length>=16} onSelect={()=>toggle(asset.id,!checked)}/>;})}
      </ThumbGrid>
      {/* A field problem stays in the form, in the design system's own notice (rule 36, rule 54). */}
      {referenceError&&<Notice inline title="Select at least one picture">{referenceError}</Notice>}
    </PanelSection>
  </Dialog>;
}
