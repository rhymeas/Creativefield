import {useCallback,useEffect,useState} from "react";
import {ArrowLeft,ArrowRight,FileText,Trash2,UserRound} from "lucide-react";
import {AddButton,Button,CastCard,Dialog,DropTarget,EmptyState,GenerateButton,IconButton,InfoButton,Meta,Notice,Panel,PanelSection,PickerRow,PromptField,ShimmerText,Toolbar,useToast} from "../../ds";
import type {CapabilityManifestV2} from "../../capabilities/types";
import {assetUrl,workspacePath,type Call,type CharacterRecord,type Project,type ReusableElement,type User,type Workspace} from "../api";
import {TeamChoice} from "../TeamChoice";
import {characterPath} from "../characters/state";
import {eligible,type Board} from "../storyboard-state";
import {MAX_SCENES,sceneDurationSeconds,buildCastShotPayloads,characterWorkflowReady,castDraftWithScenes,normalizeCastDraft,reorderCast,toggleCastMember,emptyInfluencerDraft,estimateSeconds,influencerDraftKey,influencerErrors,shotPlan,splitScript,storedInfluencerDraft,type InfluencerDraft} from "./state";
import "./influencer.css";

type Props={user:User;workspace:Workspace;project:Project;catalogue:CapabilityManifestV2[];call:Call;authorized:boolean;canEdit:boolean;onOpenStoryboard:()=>void;onOpenCharacters?:()=>void};

export function InfluencerStudio(props:Props){
  return <InfluencerWorkspace key={`${props.user.id}:${props.workspace.id}:${props.project.id}`} {...props}/>;
}

function InfluencerWorkspace({user,workspace,project,catalogue,call,authorized,canEdit,onOpenStoryboard,onOpenCharacters}:Props){
  const draftKey=influencerDraftKey(user.id,workspace.id,project.id);
  const [characters,setCharacters]=useState<CharacterRecord[]|null>(null),[draft,setDraft]=useState<InfluencerDraft>(()=>{try{const value=JSON.parse(localStorage.getItem(draftKey)??"null");return normalizeCastDraft(storedInfluencerDraft(value)?value:emptyInfluencerDraft);}catch{return normalizeCastDraft(emptyInfluencerDraft);}});
  const [error,setError]=useState(""),[busy,setBusy]=useState(false),[created,setCreated]=useState<Board|null>(null),[pasting,setPasting]=useState(false),[pasted,setPasted]=useState(""),[elements,setElements]=useState<ReusableElement[]>([]),[workflowId,setWorkflowId]=useState(draft.workflowId??""),toast=useToast();
  const locked=busy||!authorized||!canEdit,d=normalizeCastDraft(draft);
  const refresh=useCallback(async()=>{
    const [records,elementRecords]=await Promise.all([call<CharacterRecord[]>(characterPath(workspace.id,project.id)),call<ReusableElement[]>(workspacePath(workspace.id,`elements?projectId=${encodeURIComponent(project.id)}`))]);
    setCharacters(records);setElements(elementRecords);setError("");
  },[call,project.id,workspace.id]);
  useEffect(()=>{let active=true;void refresh().catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};},[refresh]);
  useEffect(()=>{try{localStorage.setItem(draftKey,JSON.stringify(draft));}catch{setError("Keep this page open: the cast draft could not be saved in this browser.");}},[draft,draftKey]);
  if(!characters)return error
    ?<Notice priority={80} title="The scene builder didn't load" actions={<Button variant="secondary" onClick={()=>void refresh().catch(e=>setError((e as Error).message))}>Try again</Button>} details={error}>Reading the saved characters failed, so nothing could be planned. Trying again reads them once more; your draft is untouched.</Notice>
    :<ShimmerText>Loading the scene builder…</ShimmerText>;
  const cast=d.castIds.map(id=>characters.find(c=>c.id===id)).filter((c):c is CharacterRecord=>!!c),issues=influencerErrors(d,characters);
  const workflows=catalogue.filter(eligible).filter(m=>cast.length>0&&cast.every(c=>characterWorkflowReady(m,elements.find(e=>e.id===c.elementId)))),workflow=workflowId?workflows.find(m=>m.id===workflowId):workflows.find(m=>m.id==="wan22-ti2v-5b")??workflows[0];
  if(cast.length&&!workflow)issues.push("No qualified workflow can use the selected cast references. Remove an unavailable reference or choose another cast member.");
  const plan=shotPlan(d,characters,workflow);
  const canCreate=issues.length===0&&!!workflow&&canEdit&&authorized,viewer=workspace.role==="viewer";
  const orderedCharacters=[...cast,...characters.filter(c=>!d.castIds.includes(c.id))],pastedScenes=splitScript(pasted);
  function update(next:InfluencerDraft){if(locked)return;const normalized=normalizeCastDraft(next);setDraft({...normalized,characterId:normalized.castIds[0]??""});setCreated(null);}
  function setScenes(next:string[]){update(castDraftWithScenes(d,next.map((text,i)=>({...(d.scenes[i]??{key:crypto.randomUUID(),characterId:d.castIds[0]??""}),text}))));}
  function assign(index:number,id:string){if(!characters!.some(c=>c.id===id))return;const ids=d.castIds.includes(id)?d.castIds:[...d.castIds,id];if(ids.length>16)return;update(castDraftWithScenes({...d,castIds:ids,characterId:ids[0]??""},d.scenes.map((s,i)=>i===index?{...s,characterId:id}:s)));}
  async function submit(){if(busy||!canCreate||!workflow||created)return;setBusy(true);setError("");
    try{const shots=buildCastShotPayloads(d,characters!,elements,workflow),name=`${cast.map(c=>c.name).join(" + ")} storyboard`.slice(0,120);
      const board=await call<Board>(workspacePath(workspace.id,"storyboards"),"POST",{projectId:project.id,name});
      await call(workspacePath(workspace.id,`storyboards/${board.id}/shots`),"PUT",{revision:board.revision,shots});setCreated(board);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <div className="cf-influencer">
    <Panel header={<div className="cf-composer-heading cf-panel-tools"><InfoButton title="How scenes become a storyboard"><Meta>Choose saved cast members and assign one to each scene. Its actual Element references feed that scene's video workflow.</Meta><Meta>The current video workflows do not expose separate per-person placement controls. Multi-person floor positions are unavailable.</Meta><Meta>Create storyboard saves stable shots and reference bindings. Voice and lip-sync are separate features.</Meta></InfoButton></div>} footer={<div className="cf-form">
      {!viewer&&<GenerateButton label={busy?"Creating storyboard":created?"Storyboard saved":"Create storyboard"} busy={busy} disabled={busy||!authorized||!!created} aria-disabled={!busy&&!canCreate||undefined} aria-describedby={!canCreate?"influencer-create-hint":undefined} onClick={()=>void submit()}/>}
      {!canCreate&&!busy&&<Meta><span id="influencer-create-hint">{viewer?"Viewer access is read-only.":!canEdit?"Editing is unavailable until the team server and session are ready.":issues[0]??"Select cast and assign a scene."}</span></Meta>}
      {created&&<Button variant="secondary" onClick={onOpenStoryboard}>Open in Storyboard</Button>}
    </div>}>
      {/* Viewer access is said once, in the footer hint beside the hidden action (rule 42). */}
      {!canEdit&&!viewer&&<Notice priority={90} consequence title="Editing unavailable">Your draft stays locked until the team server and session are ready.</Notice>}
      {error&&<Notice priority={60} title="The scene builder didn't finish" actions={<Button variant="secondary" disabled={busy} onClick={()=>void refresh().catch(e=>setError((e as Error).message))}>Try again</Button>} details={error}>The last request did not complete, so nothing new was saved. Trying again repeats it once.</Notice>}
      {characters.length?<>
        <PanelSection label="Cast"><div className="cf-influencer__cast">{orderedCharacters.map(record=>{const reference=record.referencePack.references[0],index=d.castIds.indexOf(record.id),sceneCount=d.scenes.filter(s=>s.characterId===record.id&&s.text.trim()).length;return <CastCard key={record.id} name={record.name} portrait={reference?assetUrl(workspace.id,reference.assetId):undefined} meta={record.description||"Saved character"} stats={`${record.referencePack.references.length} ref${record.referencePack.references.length===1?"":"s"} · ${sceneCount} scene${sceneCount===1?"":"s"}`} selected={index>=0} onActivate={locked?undefined:()=>update(toggleCastMember(d,record.id))} draggable={!locked} onDragStart={event=>{event.dataTransfer.setData("text/plain",`character:${record.id}`);event.dataTransfer.effectAllowed="copy";}} actions={index>=0?<Toolbar><IconButton label={`Move ${record.name} earlier in cast`} disabled={locked||index===0} onClick={()=>update(reorderCast(d,index,index-1))}><ArrowLeft size={14}/></IconButton><IconButton label={`Move ${record.name} later in cast`} disabled={locked||index===d.castIds.length-1} onClick={()=>update(reorderCast(d,index,index+1))}><ArrowRight size={14}/></IconButton><IconButton label={`Remove ${record.name} from cast`} disabled={locked} onClick={()=>update(toggleCastMember(d,record.id))}><Trash2 size={14}/></IconButton></Toolbar>:undefined}/>;})}</div><Meta>{d.castIds.length} selected cast members · {d.scenes.filter(s=>s.text.trim()).length} planned shots · one character reference pack per shot. Separate per-person placement is unavailable for these workflows.</Meta>{d.castIds.some(id=>!characters.some(c=>c.id===id))&&<Notice priority={30} title="Cast member unavailable" actions={<Button variant="secondary" disabled={locked} onClick={()=>update({...d,castIds:d.castIds.filter(id=>characters.some(c=>c.id===id))})}>Remove unavailable members</Button>}>Saved scene assignments are preserved; choose a valid member for each affected scene.</Notice>}</PanelSection>
        <PanelSection label="Workflow">{workflows.length?<PickerRow><TeamChoice label="Workflow" display={workflow?.title??"Choose a workflow"} value={workflow?.id??""} options={workflows.map(m=>({value:m.id,label:m.title,note:"One assigned character reference pack per shot"}))} disabled={locked} onChange={id=>{setWorkflowId(id);update({...d,workflowId:id});}}/></PickerRow>:<Meta>Select cast members with available image references for a qualified image-to-video workflow.</Meta>}</PanelSection>
        <PanelSection label="Script"><Button variant="secondary" disabled={locked} onClick={()=>setPasting(true)}><FileText size={12}/>Paste a script</Button></PanelSection>
        <PanelSection label="Shot plan" meta={plan.shots.length?<Meta>about {plan.totalSeconds} s</Meta>:undefined}>{plan.shots.length?plan.shots.map(shot=><Meta key={shot.key}>Shot {shot.shot} · {shot.characterName} · about {shot.seconds} s</Meta>):<Meta>Add a scene to see the plan.</Meta>}</PanelSection>
      </>:<EmptyState icon={<UserRound size={18}/>} title="No characters yet" text="A scene builder needs saved reference images first." action={<Button variant="secondary" onClick={()=>{if(onOpenCharacters)onOpenCharacters();else location.hash="characters";}}>Open Characters</Button>}/>}
    </Panel>
    <DropTarget label="Add a cast member" hint="Drop adds a member to the selected cast. Assign them to an individual scene." disabled={locked} onDrop={value=>{const id=value.startsWith("character:")?value.slice(10):"";if(characters.some(c=>c.id===id)&&!d.castIds.includes(id))update(toggleCastMember(d,id));}}>
      <InfluencerSceneList scenes={d.scenes.map(s=>s.text)} sceneKeys={d.scenes.map(s=>s.key)} cast={cast.map(c=>({id:c.id,name:c.name}))} assignments={d.scenes.map(s=>s.characterId)} durationForScene={text=>sceneDurationSeconds(text,workflow)} disabled={locked||!characters.length} onChange={setScenes} onRemove={index=>update(castDraftWithScenes(d,d.scenes.filter((_,i)=>i!==index)))} onAssign={assign}/>
    </DropTarget>
    <Dialog open={pasting&&!locked} title="Paste a script" onClose={()=>setPasting(false)} footer={<><Button variant="ghost" onClick={()=>setPasting(false)}>Cancel</Button><Button variant="primary" disabled={!pasted.trim()||pastedScenes.length>MAX_SCENES} onClick={()=>{update(castDraftWithScenes(d,pastedScenes.map(text=>({key:crypto.randomUUID(),text,characterId:d.castIds[0]??""}))));setPasted("");setPasting(false);toast(d.castIds.length?"Script split into scenes":"Script split. Select a character to assign the scenes.");}}>Split into scenes</Button></>}><PromptField label="Script" value={pasted} placeholder={"Scene one text.\n\nScene two text."} onChange={setPasted}/><Meta>A blank line starts a new scene. {pastedScenes.length}/{MAX_SCENES} scenes; longer scripts must be shortened before splitting.</Meta></Dialog>
  </div>;
}

export function InfluencerSceneList({scenes,sceneKeys,characterName,cast=[],assignments=[],durationForScene,disabled=false,onChange,onRemove,onAssign}:{scenes:string[];sceneKeys?:string[];characterName?:string;cast?:Array<{id:string;name:string}>;assignments?:string[];durationForScene?:(scene:string)=>number;disabled?:boolean;onChange?:(next:string[])=>void;onRemove?:(index:number)=>void;onAssign?:(index:number,id:string)=>void}){
  const edit=!!onChange&&!disabled;
  return <section className="cf-influencer__scenes" aria-label={characterName?`Scenes for ${characterName}`:"Scenes"}>
    {scenes.length?<>{scenes.map((scene,index)=><DropTarget key={sceneKeys?.[index]??index} label={`Drop a character onto scene ${index+1}`} hint="This scene uses one assigned reference pack." disabled={!edit||!onAssign} onDrop={value=>{if(value.startsWith("character:"))onAssign?.(index,value.slice(10));}}><div className="cf-influencer__scene">
      {onAssign&&<TeamChoice label={`Scene ${index+1} cast`} display={cast.find(c=>c.id===assignments[index])?.name??"Assign a cast member"} value={assignments[index]??""} options={cast.map(c=>({value:c.id,label:c.name}))} disabled={!edit} onChange={id=>onAssign(index,id)}/>}
      <PromptField compact label={`Scene ${index+1}`} value={scene} placeholder="What happens in this scene" disabled={!edit} onChange={value=>onChange?.(scenes.map((text,i)=>i===index?value:text))} tools={<Toolbar><Meta>{durationForScene?.(scene)??estimateSeconds(scene)}s</Meta>{edit&&<IconButton label={`Remove scene ${index+1}`} onClick={()=>onRemove?onRemove(index):onChange?.(scenes.filter((_,i)=>i!==index))}><Trash2 size={14}/></IconButton>}</Toolbar>}/>
    </div></DropTarget>)}{edit&&scenes.length<MAX_SCENES&&<AddButton onClick={()=>onChange?.([...scenes,""])}>Add scene</AddButton>}</>:<EmptyState stage icon={<FileText size={18}/>} title="No scenes yet" text="Add a scene, or paste a full script with blank lines between scenes." action={edit?<Button variant="primary" onClick={()=>onChange?.([""])}>Add first scene</Button>:undefined}/>}
  </section>;
}
