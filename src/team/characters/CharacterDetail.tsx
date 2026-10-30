import {useEffect,useRef,useState} from "react";
import {Block,Button,Collapsible,DataRow,Meta,Notice,PanelSection,SectionHeader,Skeleton,Thumb,ThumbGrid,Toolbar} from "../../ds";
import {assetUrl,workspacePath,type Asset,type Call,type CharacterRecord,type Workspace} from "../api";
import {characterPath,characterUsageCaption} from "./state";

type AssetState={asset:Asset|null;loaded:boolean};

/* A character is its name, its optional one-line description and its locked reference images.
   Identity generation does not exist, so this panel says what a character does today and offers the
   next step that runs: Scenes. Everything technical is folded away. */
export function CharacterDetail({record,loading,workspace,call,onRemove,onMakeScenes}:{record:CharacterRecord|null;loading:boolean;workspace:Workspace;call:Call;onRemove?:(id:string)=>void;onMakeScenes?:(id:string)=>void}){
  const [assets,setAssets]=useState<Record<string,AssetState>>({}),[removing,setRemoving]=useState(false),[removeError,setRemoveError]=useState("");
  const remove=async()=>{
    if(!record||removing)return;
    setRemoving(true);setRemoveError("");
    try{await call(characterPath(workspace.id,record.projectId,record.id),"DELETE");onRemove?.(record.id);}
    catch(e){setRemoveError((e as Error).message);}
    finally{setRemoving(false);}
  };
  const heading=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!record)return;heading.current?.focus();let current=true;setAssets({});void Promise.all(record.referencePack.references.map(async reference=>{
    try{const asset=await call<Asset>(workspacePath(workspace.id,`assets/${encodeURIComponent(reference.assetId)}`));return [reference.assetId,{asset,loaded:true}] as const;}
    catch{return [reference.assetId,{asset:null,loaded:true}] as const;}
  })).then(entries=>{if(current)setAssets(Object.fromEntries(entries));});return()=>{current=false;};},[record?.id,workspace.id,call]);
  if(loading)return <div className="cf-character-detail"><Block label="Character detail"><Skeleton height={24}/><Skeleton height={120}/></Block></div>;
  if(!record)return <div className="cf-character-detail"><Block label="Character detail"><Meta>Select a character to see its reference images.</Meta></Block></div>;
  const count=record.referencePack.references.length,description=record.description.trim();
  const created=new Date(record.createdAt).toLocaleDateString(undefined,{day:"numeric",month:"short",year:"numeric"});
  return <div className="cf-character-detail"><Block label={`${record.name} details`}>
    <div className="cf-character-detail-heading" ref={heading} tabIndex={-1}><SectionHeader large title={record.name} meta={<Meta>Created {created}</Meta>}/></div>
    {description&&<Meta>{description}</Meta>}
    {/* One true line: the only places a saved character runs today. No identity status, no dead requirement list. */}
    <Meta>Works in Scenes and image edit.</Meta>
    {/* Removing hides the character from the cast; its reference snapshots stay as the record of the
        shots it appeared in, which is why this says "Remove from cast" rather than "Delete". */}
    <Toolbar>
      {onMakeScenes&&<Button variant="primary" onClick={()=>onMakeScenes(record.id)}>Make scenes</Button>}
      {onRemove&&<Button variant="secondary" disabled={removing} onClick={()=>void remove()}>{removing?"Removing…":"Remove from cast"}</Button>}
    </Toolbar>
    {removeError&&<Notice inline priority={60} title="Could not remove the character">{removeError}</Notice>}
    <PanelSection label="Reference images" meta={<span title="A character's references are fixed when it is created and cannot be changed."><Meta parts={["Locked",String(count)]}/></span>}>
      <ThumbGrid label="Reference images">
        {record.referencePack.references.map(reference=>{const state=assets[reference.assetId],asset=state?.asset,name=asset?.name??`Reference ${reference.ordinal+1}`;return <Thumb key={reference.assetId} src={state?.loaded&&asset?assetUrl(workspace.id,reference.assetId):undefined} label={name} info={<><span>{name}</span><Meta>{asset?asset.project_id===null?"Shared image":"Project image":state?.loaded?"Unavailable":""}</Meta></>}/>;})}
      </ThumbGrid>
    </PanelSection>
    <Collapsible title="Details">
      {characterUsageCaption(record.usage)&&<><Meta>{characterUsageCaption(record.usage)} · {record.usage!.referenceRuns} verified reference {record.usage!.referenceRuns===1?"run":"runs"}</Meta><Meta>Completed storyboard shots traced through validated character references and generated input assets. Retakes count once per shot; untracked legacy uses are excluded. This does not evaluate visible identity.</Meta></>}
      <Meta>Identity consistency has not been evaluated.</Meta>
      {record.referencePack.references.map(reference=>{const asset=assets[reference.assetId]?.asset,short=`${reference.assetSha256.slice(0,12)}…${reference.assetSha256.slice(-8)}`;return <DataRow key={reference.assetId} title={asset?.name??`Reference ${reference.ordinal+1}`} meta={<span title={reference.assetSha256}><Meta parts={[reference.assetId,`SHA-256 ${short}`]}/></span>}/>;})}
    </Collapsible>
  </Block></div>;
}
