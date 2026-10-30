import {useCallback,useEffect,useMemo,useState} from "react";
import {CHARACTER_DRAG_TYPE} from "../../image/editor/character-placement";
import {characterUsageCaption} from "./state";
import {Image,Plus} from "lucide-react";
import {AddButton,Block,Button,CastCard,EmptyState,LinkButton,Meta,Notice,Panel,SectionHeader,Skeleton,Split,useToast} from "../../ds";
import {assetUrl,workspacePath,type AssetPage,type Call,type CharacterRecord,type Project,type Workspace} from "../api";
import {CharacterCreateDialog} from "./CharacterCreateDialog";
import {CharacterDetail} from "./CharacterDetail";
import {characterEmptyAction,characterPath,keepCharacterSelection} from "./state";

export function TeamCharacters({workspace,project,call,authorized,canCreate,onCount,onMakeScenes}:{workspace:Workspace;project:Project;call:Call;authorized:boolean;canCreate:boolean;onCount?:(count:number)=>void;onMakeScenes?:(id:string)=>void}){
  const [records,setRecords]=useState<CharacterRecord[]>([]),[selectedId,setSelectedId]=useState(""),[selected,setSelected]=useState<CharacterRecord|null>(null),[assets,setAssets]=useState<AssetPage>({items:[],nextCursor:null});
  const [loading,setLoading]=useState(true),[detailLoading,setDetailLoading]=useState(false),[creating,setCreating]=useState(false),[error,setError]=useState("");
  const toast=useToast();
  const load=useCallback(async()=>{if(!authorized)return;setLoading(true);setError("");try{
    const [characters,media]=await Promise.all([call<CharacterRecord[]>(characterPath(workspace.id,project.id)),(async()=>{
      const items:AssetPage["items"]=[];let cursor:string|null=null;
      do {const page:AssetPage=await call<AssetPage>(workspacePath(workspace.id,`assets?limit=200${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`));items.push(...page.items);cursor=page.nextCursor;}while(cursor);
      return {items:items.filter(asset=>asset.project_id===project.id||asset.project_id===null),nextCursor:null};
    })()]);
    setRecords(characters);setAssets(media);setSelectedId(id=>keepCharacterSelection(characters,id));onCount?.(characters.length);
  }catch(e){setError((e as Error).message);}finally{setLoading(false);}},[authorized,call,workspace.id,project.id]);
  useEffect(()=>{setRecords([]);setSelectedId("");setSelected(null);setAssets({items:[],nextCursor:null});setCreating(false);onCount?.(0);void load();},[workspace.id,project.id,load]);
  useEffect(()=>{if(!authorized||!selectedId){setSelected(null);return;}let current=true;setSelected(null);setDetailLoading(true);void call<CharacterRecord>(characterPath(workspace.id,project.id,selectedId)).then(record=>{if(current&&record.projectId===project.id)setSelected(record);}).catch(e=>{if(current){setSelected(null);setError((e as Error).message);}}).finally(()=>{if(current)setDetailLoading(false);});return()=>{current=false;};},[authorized,call,workspace.id,project.id,selectedId]);
  const images=useMemo(()=>assets.items.filter(asset=>["image","reference"].includes(asset.media_type)),[assets.items]);
  const emptyActionKind=characterEmptyAction(canCreate,images.length);
  const createButton=emptyActionKind==="create"?<AddButton onClick={()=>setCreating(true)}>New character</AddButton>:emptyActionKind==="add-image"?<LinkButton variant="secondary" href="#library/assets">Add an image in Library</LinkButton>:undefined;
  const emptyAction=emptyActionKind==="create"?<Button variant="primary" onClick={()=>setCreating(true)}><Plus size={14}/>New character</Button>:emptyActionKind==="add-image"?<LinkButton variant="secondary" href="#library">Add an image in Library</LinkButton>:undefined;
  function created(record:CharacterRecord){const next=[record,...records.filter(item=>item.id!==record.id)];setCreating(false);setRecords(next);onCount?.(next.length);setSelectedId(record.id);toast("Character created");}
  if(!loading&&records.length===0)return <>
    {error&&<Notice priority={80} title="Characters didn't load" actions={<Button variant="secondary" onClick={()=>void load()}>Check again</Button>} details={error}>Nothing was changed. Checking again reads the characters and their pictures again.</Notice>}
    <div className="ds-page--narrow"><Block label="Characters"><SectionHeader large title="Characters"/><EmptyState stage icon={<Image size={18}/>} title="No characters yet" text={images.length?"A character is a named, fixed set of images.":"A character is built from images. Add one to the Library first."} action={emptyAction}/></Block></div>
    <CharacterCreateDialog open={creating} onClose={()=>setCreating(false)} onCreated={created} workspace={workspace} project={project} assets={images} call={call}/>
  </>;
  return <>
    {error&&<Notice priority={80} title="Characters didn't load" actions={<Button variant="secondary" onClick={()=>void load()}>Check again</Button>} details={error}>Nothing was changed. Checking again reads the characters and their pictures again.</Notice>}
    <Split>
      <div className="cf-character-list"><Panel>{loading?<><Skeleton height={64}/><Skeleton height={64}/></>:records.length?<div className="cf-character-cards" aria-label="Characters">{records.map(record=>{const cover=record.referencePack.references[0];return <CastCard key={record.id} name={record.name} portrait={cover?assetUrl(workspace.id,cover.assetId):undefined} stats={<Meta parts={[`${record.referencePack.references.length} ${record.referencePack.references.length===1?"ref":"refs"}`,characterUsageCaption(record.usage)]}/>} selected={record.id===selectedId} draggable={canCreate&&authorized} onDragStart={event=>{event.dataTransfer.setData(CHARACTER_DRAG_TYPE,record.id);event.dataTransfer.setData("text/plain",`character:${record.id}`);event.dataTransfer.effectAllowed="copy";}} onActivate={()=>setSelectedId(record.id)}/>;})}</div>:null} {records.length>0&&createButton}</Panel></div>
      {(loading||records.length>0)&&<CharacterDetail record={selected} loading={detailLoading} workspace={workspace} call={call} onRemove={()=>{setSelectedId("");setSelected(null);void load();}} onMakeScenes={onMakeScenes}/>}
    </Split>
    <CharacterCreateDialog open={creating} onClose={()=>setCreating(false)} onCreated={created} workspace={workspace} project={project} assets={images} call={call}/>
  </>;
}
