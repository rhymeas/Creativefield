import {useCallback,useEffect,useRef,useState,type ReactNode} from "react";
import {ArrowLeft,ArrowRight,Clapperboard,Trash2} from "lucide-react";
import {Button,ContactSheet,DataRow,Dialog,EmptyState,GenerateButton,IconButton,Meta,TextField,Notice,Panel,PromptField,Row,SectionHeader,ShotStrip,ShotTile,StatusText,Toolbar,Tooltip,type ContactSheetItem} from "../ds";
import type {CapabilityManifestV2} from "../capabilities/types";
import {ApiError,assetUrl,composerAssets,loadAiText,mergeAssets,workspacePath,type AiTextProviderStatus,type Asset,type Call,type Project,type ReusableElement,type User,type Worker,type Workspace} from "./api";
import {StoryboardStills,approvedTakes,type StillTake} from "./StoryboardStills";
import {plainProblem} from "./problems";
import {workerReadiness} from "./state";
import {TeamChoice} from "./TeamChoice";
import {StoryboardShotEditor} from "./StoryboardShotEditor";
import {StoryboardResults} from "./StoryboardResults";
import {downloadJson} from "./TeamLibrary";
import {boardDraftKey,boardRequirements,eligible,equalShots,fromBoard,moveShot,newShot,outputSizes,saveOutcome,shotErrors,shotPayload,storedDraft,transitionProblem,type AssemblyReadiness,type Board,type BoardDraft,type RenderIntent,type SaveIntent,type Shot} from "./storyboard-state";

type Props={user:User;workspace:Workspace;project:Project;catalogue:CapabilityManifestV2[];workers:Worker[];call:Call;authorized:boolean;canEdit:boolean};
type PlannedShot={title:string;prompt:string;durationSeconds:number;shotIntent?:string;cameraIntent?:string};
type PremisePlan={provider:AiTextProviderStatus["id"];model:string;shots:PlannedShot[]};
const providerWords:Record<AiTextProviderStatus["id"],string>={"local-comfy":"Local ComfyUI","openai-compatible":"API key",chatgpt:"ChatGPT"};
/** Where a plan ran, then the model that wrote it. A model name that already says where is not repeated. */
function planSource(plan:PremisePlan){return plan.model.includes(" · ")?plan.model:`${providerWords[plan.provider]} · ${plan.model}`;}
type JoinChoice="cut"|"crossfade-0.5"|"crossfade-1";
/** Assembly refuses a fade with fewer than two shots or one longer than the shortest shot, so a
 *  join it cannot build is never offered. */
export function joinChoices(shots:Array<{durationSeconds:number|string}>):JoinChoice[]{
  const choices:JoinChoice[]=["cut","crossfade-0.5","crossfade-1"];
  return choices.filter(value=>!transitionProblem(shots,value==="cut"?undefined:{kind:"crossfade",seconds:Number(value.slice("crossfade-".length))}));
}
function readStored(key:string,session=false):unknown{try{return JSON.parse((session?sessionStorage:localStorage).getItem(key)??"null");}catch{return null;}}
function scriptSentences(script:string){return script.split(/\n+/).map(text=>text.trim()).filter(Boolean);}
export function TeamStoryboard(props:Props){
  const {workspace,project,call,authorized,canEdit}=props;
  const [boards,setBoards]=useState<Board[]>([]),[id,setId]=useState(""),[board,setBoard]=useState<Board|null>(null),[error,setError]=useState(""),[refresh,setRefresh]=useState(0),[creating,setCreating]=useState(false),[name,setName]=useState(""),[busy,setBusy]=useState(false);
  const current=useRef(true),close=useCallback(()=>setCreating(false),[]);
  /* A failed board read is said in everyday words, and checking again is its one fix (rule 36). */
  const problem=error?plainProblem(error):null;
  const [removingBoard,setRemovingBoard]=useState(false),closeRemoveBoard=useCallback(()=>setRemovingBoard(false),[]);
  useEffect(()=>{current.current=true;return()=>{current.current=false;};},[]);
  useEffect(()=>{if(!authorized)setCreating(false);},[authorized]);
  useEffect(()=>{if(!authorized)return;let active=true;void call<Board[]>(workspacePath(workspace.id,"storyboards")).then(all=>{if(!active)return;const list=all.filter(b=>b.project_id===project.id);setBoards(list);setId(old=>list.some(b=>b.id===old)?old:list[0]?.id??"");}).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};},[call,workspace.id,project.id,authorized,refresh]);
  useEffect(()=>{if(!id||!authorized)return;let active=true;void call<Board>(workspacePath(workspace.id,`storyboards/${id}`)).then(b=>{if(!active)return;if(b.project_id!==project.id)throw new Error("Storyboard does not belong to this project.");setBoard(b);}).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};},[id,workspace.id,project.id,call,authorized]);
  async function create(e:React.FormEvent){e.preventDefault();if(busy||!canEdit)return;setBusy(true);try{const b=await call<Board>(workspacePath(workspace.id,"storyboards"),"POST",{projectId:project.id,name});if(current.current){setBoards(list=>[b,...list]);setId(b.id);setName("");setCreating(false);setError("");}}catch(e){if(current.current){setError(`${(e as Error).message} Refresh boards before trying creation again; the first request may have succeeded.`);setCreating(false);setRefresh(v=>v+1);}}finally{if(current.current)setBusy(false);}}
  /* A board could be created and never removed. Its renders and stills are the record of what was
     produced, so removal archives it: the board leaves the picker, the films stay. */
  async function removeBoard(){if(!id||busy||!canEdit)return;setBusy(true);try{await call(workspacePath(workspace.id,`storyboards/${encodeURIComponent(id)}`),"DELETE");if(current.current){setBoards(list=>list.filter(b=>b.id!==id));setId("");setRemovingBoard(false);setError("");}}catch(e){if(current.current){setError(`${(e as Error).message} Reload the boards before trying again.`);setRemovingBoard(false);}}finally{if(current.current)setBusy(false);}}
  // The board picker lives in the panel header of the board (rule 19), not in an extra bar.
  const picker=<><TeamChoice label="Storyboard" variant="pill" display={boards.find(b=>b.id===id)?.name??"Choose a board"} value={id} options={[...boards.map(b=>{const created=(b as Board&{created_at?:string}).created_at,count=b.shots?.length;return {value:b.id,label:b.name,note:[created?new Date(created).toLocaleDateString(undefined,{day:"2-digit",month:"short"}):null,count?`${count} ${count===1?"shot":"shots"}`:`revision ${b.revision}`].filter(Boolean).join(" · ")}}),...(canEdit?[{value:"__new__",label:"New board…"}]:[])]} disabled={!authorized||busy} onChange={v=>v==="__new__"?setCreating(true):setId(v)}/>{canEdit&&id&&<IconButton label="Remove this storyboard" disabled={!!busy} onClick={()=>setRemovingBoard(true)}><Trash2 size={16}/></IconButton>}</>;
  return <>
    {problem&&<Notice priority={60} title={problem.title||"Storyboard request failed"} actions={<Button variant="secondary" onClick={()=>setRefresh(v=>v+1)}>Check again</Button>} details={problem.details}>{problem.text}</Notice>}
    <Dialog open={removingBoard&&authorized} title="Remove this storyboard?" onClose={closeRemoveBoard} footer={<><Button variant="secondary" onClick={closeRemoveBoard}>Keep it</Button><Button disabled={!!busy} onClick={()=>void removeBoard()}>Remove from the list</Button></>}>The board and its rendered films stay in the workspace; it stops appearing in the picker.</Dialog>
    {board&&board.id===id?<BoardEditor key={board.id} {...props} board={board} picker={picker}/>:(id?<Meta>Reading the saved revision.</Meta>:<EmptyState stage icon={<Clapperboard size={18}/>} title="No storyboards yet" text="Plan shots, render them locally and assemble one video in this shared project." action={canEdit?<Button variant="primary" onClick={()=>setCreating(true)}>Create storyboard</Button>:undefined}/>)}
    <Dialog open={creating&&authorized} title="New storyboard" onClose={close}><form className="cf-form" onSubmit={create}><TextField label="Board name" autoFocus required maxLength={120} value={name} onChange={setName} disabled={busy}/><Button type="submit" disabled={!name.trim()||busy}>Create board</Button></form></Dialog>
  </>;
}

export function BoardEditor({board,picker,user,workspace,project,catalogue,workers,call,authorized,canEdit}:Props&{board:Board;picker?:ReactNode}){
  const storageKey=boardDraftKey(user.id,workspace.id,project.id,board.id),cached=readStored(storageKey),initial=fromBoard(board);
  if(storedDraft(cached)){initial.workerId=cached.workerId;initial.assembly=cached.assembly;}
  const [draft,setDraft]=useState<BoardDraft>(initial),[baseline,setBaseline]=useState(initial.shots),[selected,setSelected]=useState(initial.shots[0]?.key??"");
  const [recovery,setRecovery]=useState<BoardDraft|null>(()=>storedDraft(cached)&&(cached.revision!==board.revision||!equalShots(cached.shots,initial.shots))?cached:null);
  const [pendingSave,setPendingSave]=useState<SaveIntent|null>(()=>{const v=readStored(`${storageKey}:save`,true) as SaveIntent;return v&&Number.isInteger(v.revision)&&Array.isArray(v.shots)?v:null;});
  const [pendingRender,setPendingRender]=useState<RenderIntent|null>(()=>{const v=readStored(`${storageKey}:render`,true) as RenderIntent;return v&&typeof v.idempotencyKey==="string"&&Number.isInteger(v.revision)&&v.assembly?v:null;});
  const [stills,setStills]=useState<StillTake[]>([]),[stillAssets,setStillAssets]=useState<string[]>([]);
  const receiveStillAssets=useCallback((ids:string[])=>setStillAssets(old=>JSON.stringify(old)===JSON.stringify(ids)?old:ids),[]);
  const [shotOutputs,setShotOutputs]=useState<Record<string,string>>({}),[renderOpen,setRenderOpen]=useState(false);
  const [assets,setAssets]=useState<Asset[]>([]),[elements,setElements]=useState<ReusableElement[]>([]),[files,setFiles]=useState<Record<string,Record<string,File|null>>>({}),[requirements,setRequirements]=useState<AssemblyReadiness|null>(null);
  const [busy,setBusy]=useState(""),[error,setError]=useState(""),[conflict,setConflict]=useState(0),[notice,setNotice]=useState(""),[announcement,setAnnouncement]=useState(""),[removing,setRemoving]=useState(false),[posterOpen,setPosterOpen]=useState(false),[version,setVersion]=useState(0), [script,setScript]=useState(""),[premise,setPremise]=useState(""),[plan,setPlan]=useState<PremisePlan|null>(null),[planBusy,setPlanBusy]=useState(false),[planError,setPlanError]=useState(""),[textProvider,setTextProvider]=useState<AiTextProviderStatus["id"]|null>(null);
  const alive=useRef(true),shotButtons=useRef(new Map<string,HTMLButtonElement>()),closeRemove=useCallback(()=>setRemoving(false),[]);
  /* Everyday words for the raw message; the code waits behind Details. */
  const failure=error?plainProblem(error):null,planFailure=planError?plainProblem(planError):null;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(!authorized)setRemoving(false);},[authorized]);
  useEffect(()=>{if(announcement)shotButtons.current.get(selected)?.focus();},[announcement,selected]);
  useEffect(()=>{if(recovery)return;try{localStorage.setItem(storageKey,JSON.stringify(draft));}catch{setError("Browser draft storage is unavailable. Keep this page open until saved.");}},[draft,storageKey,recovery]);
  const selectedAssets=JSON.stringify([...new Set([...draft.shots.flatMap(s=>s.assets.map(a=>a.assetId)),...stillAssets])].sort());
  useEffect(()=>{if(!authorized)return;let active=true;void composerAssets(call,workspace.id,project.id,JSON.parse(selectedAssets)).then(page=>{if(active)setAssets(page.items);}).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};},[call,workspace.id,project.id,authorized,selectedAssets]);
  useEffect(()=>{if(!authorized)return;let active=true;void call<ReusableElement[]>(workspacePath(workspace.id,`elements?projectId=${encodeURIComponent(project.id)}`)).then(records=>{if(active)setElements(records);}).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};},[call,workspace.id,project.id,authorized]);
  useEffect(()=>{if(!authorized)return;let active=true;void call<AssemblyReadiness>(workspacePath(workspace.id,"storyboard-requirements")).then(r=>{if(active)setRequirements(r);}).catch(e=>{if(active){setRequirements(null);setError((e as Error).message);}});return()=>{active=false;};},[call,workspace.id,authorized,version]);
  // Where planning runs, so the caption only claims "local" when that is the provider. An unreadable
  // choice leaves the claim out instead of guessing.
  useEffect(()=>{if(!authorized)return;let active=true;void loadAiText(call,workspace.id).then(settings=>{if(active)setTextProvider(settings.active??null);}).catch(()=>{if(active)setTextProvider(null);});return()=>{active=false;};},[call,workspace.id,authorized]);
  // A board without a known worker takes the first one ready for its shots, so rendering never stalls on an unset choice.
  useEffect(()=>{if(workers.some(w=>w.id===draft.workerId))return;const pick=workers.find(w=>w.enabled&&!boardRequirements(draft.shots,catalogue,w).length)??workers.find(w=>w.enabled);if(pick)setDraft(d=>({...d,workerId:pick.id}));},[workers,draft.workerId]);
  const manifests=catalogue.filter(eligible),shot=draft.shots.find(s=>s.key===selected),index=draft.shots.findIndex(s=>s.key===selected),dirty=!equalShots(draft.shots,baseline),localPlan=textProvider==="local-comfy";
  const hasFiles=Object.values(files).some(f=>Object.values(f).some(Boolean)),locked=!canEdit||!!busy||!!pendingRender||!!pendingSave||!!recovery;
  useEffect(()=>{if(locked)setRenderOpen(false);},[locked]);
  /* A text-only shot animates its approved still through the image-to-video sibling of the
     same family; the server resolves the same sibling when it prepares the run. */
  const startImagePort=(m?:CapabilityManifestV2)=>!!m?.inputs.some(p=>p.id==="start_image"&&p.type==="image");
  const animatableFor=(s:Shot)=>{const current=catalogue.find(m=>m.id===s.settings.generation?.capabilityId);if(startImagePort(current))return current;const base=current?.id.endsWith("-t2v")?current.id.slice(0,-4):undefined;return base?catalogue.find(m=>m.id===base&&startImagePort(m)):undefined;};
  const approvals=approvedTakes(draft.shots,stills),approvedCount=draft.shots.filter(s=>approvals[s.key]).length,allApproved=draft.shots.length>0&&draft.shots.every(s=>approvals[s.key]&&!!animatableFor(s));
  const effectiveShots=allApproved?draft.shots.map(s=>{const capability=animatableFor(s)!;return {...s,assets:[...s.assets.filter(a=>a.role!=="start_image"),{role:"start_image",assetId:approvals[s.key].approved_asset_id!}],settings:{...s.settings,generation:s.settings.generation?{...s.settings.generation,capabilityId:capability.id,version:capability.version}:s.settings.generation,elementInputs:Object.fromEntries(Object.entries(s.settings.elementInputs).filter(([role])=>role!=="start_image"))}};}):draft.shots;
  const saveInvalid=draft.shots.some(s=>(s.settings.title?.length??0)>500||!Number.isFinite(Number(s.durationSeconds))||Number(s.durationSeconds)<=0||Number(s.durationSeconds)>120)||draft.shots.length>32||draft.shots.reduce((n,s)=>n+Number(s.durationSeconds),0)>300||hasFiles;
  const missingPrompt=draft.shots.findIndex(s=>!s.prompt.trim());
  const planInvalid=saveInvalid||missingPrompt>=0;
  const invalid=effectiveShots.flatMap((s,i)=>shotErrors(s,catalogue,assets,elements).map(e=>`Shot ${i+1}: ${e}`));
  if(draft.shots.length>32||draft.shots.reduce((n,s)=>n+Number(s.durationSeconds),0)>300)invalid.push("Use no more than 32 shots and 300 seconds.");
  if(hasFiles)invalid.push("Upload the chosen media before saving or rendering.");
  // A stored fade can stop fitting after an edit; it is refused here, before shots are generated.
  const joinProblem=transitionProblem(draft.shots,draft.assembly.transition);
  if(joinProblem)invalid.push(joinProblem);
  const missing=boardRequirements(draft.shots,catalogue,workers.find(w=>w.id===draft.workerId)),canRender=canEdit&&!busy&&!recovery&&!pendingSave&&!dirty&&!conflict&&draft.shots.length>0&&!invalid.length&&!missing.length&&requirements?.state==="ready";
  function persistIntent(kind:"save"|"render",value:SaveIntent|RenderIntent|null){try{if(value)sessionStorage.setItem(`${storageKey}:${kind}`,JSON.stringify(value));else sessionStorage.removeItem(`${storageKey}:${kind}`);}catch{setError("Request tracking is available only while this page stays open.");}if(kind==="save")setPendingSave(value as SaveIntent|null);else setPendingRender(value as RenderIntent|null);}
  function updateShot(next:Shot){setDraft(d=>({...d,shots:d.shots.map(s=>s.key===next.key?next:s)}));}
  /** A new shot inherits the storyboard's cast reference when one shot already carries it,
   *  so an added shot keeps the same character instead of falling back to plain text-to-video. */
  function castBase(){const donor=draft.shots.find(s=>s.settings.elementInputs.start_image&&s.settings.generation);const cast=donor?manifests.find(m=>m.id===donor.settings.generation!.capabilityId):undefined;return donor&&cast?{donor,cast}:undefined;}
  function newShotInheriting(base?:CapabilityManifestV2){const inherited=castBase();const shot=newShot(base);return inherited?{...shot,settings:{...shot.settings,elementInputs:{start_image:{...inherited.donor.settings.elementInputs.start_image}}}}:shot;}
  function add(){const next=newShotInheriting(castBase()?.cast??manifests.find(m=>m.category==="t2v"));setDraft(d=>({...d,shots:[...d.shots,next]}));setSelected(next.key);}
  const scriptParts=scriptSentences(script),room=Math.max(0,32-draft.shots.length);
  function planFromScript(){if(locked||!scriptParts.length||!room)return;const base=castBase()?.cast??manifests.find(m=>m.id==="wan22-ti2v-5b"&&workers.some(w=>workerReadiness(m,w).state==="ready"))??manifests.find(m=>m.category==="i2v"&&workers.some(w=>workerReadiness(m,w).state==="ready"))??manifests.find(m=>m.category==="t2v")??manifests[0];const additions=scriptParts.slice(0,room).map(text=>{const shot=newShotInheriting(base);return {...shot,settings:{...shot.settings,title:text}};});setDraft(d=>({...d,shots:[...d.shots,...additions]}));setSelected(additions[0].key);setNotice("Shot cards added. Review and save before rendering.");}
  async function planPremise(){if(locked||!canEdit||planBusy||!premise.trim())return;setPlanBusy(true);setPlanError("");try{setPlan(await call<PremisePlan>(workspacePath(workspace.id,"storyboard-plan"),"POST",{premise:premise.trim(),count:3}));}catch(e){setPlanError((e as Error).message);}finally{if(alive.current)setPlanBusy(false);}}
  function applyPremisePlan(){if(!plan||locked||!room)return;const base=castBase()?.cast??manifests.find(m=>m.id==="wan22-ti2v-5b"&&workers.some(w=>workerReadiness(m,w).state==="ready"))??manifests.find(m=>m.category==="i2v"&&workers.some(w=>workerReadiness(m,w).state==="ready"))??manifests.find(m=>m.category==="t2v")??manifests[0];const additions=plan.shots.slice(0,room).map(p=>{const shot=newShotInheriting(base);const notes=[p.shotIntent&&`Shot: ${p.shotIntent}.`,p.cameraIntent&&`Camera: ${p.cameraIntent}.`].filter(Boolean).join(" ");return {...shot,prompt:notes?`${p.prompt}\n\n${notes}`:p.prompt,durationSeconds:Math.max(1,Math.min(10,Number(p.durationSeconds)||1)),settings:{...shot.settings,title:p.title}};});setDraft(d=>({...d,shots:[...d.shots,...additions]}));setSelected(additions[0].key);setPlan(null);setPremise("");setNotice(`${additions.length} planned shot${additions.length===1?"":"s"} added. Review titles and prompts before saving.`);}
  function move(to:number){if(!shot)return;setDraft(d=>({...d,shots:moveShot(d.shots,index,to)}));setAnnouncement(`Shot ${index+1} moved to position ${to+1}`);}
  function remove(){if(!shot)return;const next=draft.shots.filter(s=>s.key!==shot.key);setDraft(d=>({...d,shots:next}));setFiles(f=>{const copy={...f};delete copy[shot.key];return copy;});setSelected(next[Math.min(index,next.length-1)]?.key??"");setRemoving(false);}
  async function fetchBoard(){const b=await call<Board>(workspacePath(workspace.id,`storyboards/${board.id}`));if(b.project_id!==project.id)throw new Error("Storyboard project mismatch");return b;}
  async function reload(){setBusy("reload");try{const b=await fetchBoard();if(!alive.current)return;const latest=fromBoard(b);setDraft(d=>({...d,revision:latest.revision,shots:latest.shots}));setBaseline(latest.shots);setSelected(latest.shots[0]?.key??"");setRecovery(null);setFiles({});setConflict(0);persistIntent("save",null);setError("");setNotice("Loaded the latest saved revision.");}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy("");}}
  function acknowledgeSave(intent:SaveIntent,revision:number){setDraft(d=>({...d,revision}));setBaseline(intent.shots.map((s,i)=>({...s,key:draft.shots[i]?.key??crypto.randomUUID()})));persistIntent("save",null);setConflict(0);setNotice(`Saved revision ${revision}. Render when ready.`);}
  async function save(){if(!canEdit||busy||pendingRender||recovery)return;const intent=pendingSave??{revision:draft.revision,shots:shotPayload(draft.shots)};setBusy("save");setError("");persistIntent("save",intent);
    try{if(pendingSave){const b=await fetchBoard();if(!alive.current)return;const outcome=saveOutcome(intent,b);if(outcome==="saved"){acknowledgeSave(intent,b.revision);return;}if(outcome==="conflict"){setConflict(b.revision);persistIntent("save",null);return;}}
      const saved=await call<{revision:number}>(workspacePath(workspace.id,`storyboards/${board.id}/shots`),"PUT",intent);if(alive.current)acknowledgeSave(intent,saved.revision);
    }catch(e){if(!alive.current)return;setError((e as Error).message);if(e instanceof ApiError&&e.status===409){const latest=await fetchBoard().catch(()=>null);if(!alive.current)return;if(latest&&saveOutcome(intent,latest)==="saved")acknowledgeSave(intent,latest.revision);else if(latest){setConflict(latest.revision);persistIntent("save",null);}}else if(e instanceof ApiError&&e.status>=400&&e.status<500&&e.status!==401)persistIntent("save",null);
    }finally{if(alive.current)setBusy("");}
  }
  async function render(){if(!canEdit||busy||(!pendingRender&&!canRender))return;const intent=pendingRender??{revision:draft.revision,workerId:draft.workerId,assembly:structuredClone(draft.assembly),idempotencyKey:crypto.randomUUID(),...(allApproved?{approvedStillTakes:Object.fromEntries(draft.shots.map(s=>[s.key,approvals[s.key].id]))}:{})};persistIntent("render",intent);setBusy("render");setError("");
    try{await call(workspacePath(workspace.id,`storyboards/${board.id}/renders`),"POST",intent);if(alive.current){persistIntent("render",null);setVersion(v=>v+1);setNotice(`Render recorded for revision ${intent.revision}.`);}}
    catch(e){if(!alive.current)return;setError((e as Error).message);if(e instanceof ApiError&&e.status>=400&&e.status<500&&e.status!==401){persistIntent("render",null);if(e.status===409){const b=await fetchBoard().catch(()=>null);if(alive.current&&b)setConflict(b.revision);}}}finally{if(alive.current)setBusy("");}
  }
  async function upload(role:string){if(!shot||!canEdit)return;const key=shot.key,file=files[key]?.[role];if(!file)return;setBusy("upload");try{const form=new FormData();form.append("file",file);const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${project.id}`),"POST",form);if(!alive.current)return;setAssets(a=>mergeAssets([asset],a));setDraft(d=>({...d,shots:d.shots.map(s=>s.key===key?{...s,assets:[...s.assets.filter(a=>a.role!==role),{role,assetId:asset.id}]}:s)}));setFiles(f=>({...f,[key]:{...f[key],[role]:null}}));}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy("");}}
  const chosenSize=outputSizes.find(s=>s.width===draft.assembly.width&&s.height===draft.assembly.height);
  /** The still a shot shows: its approved take, else a finished candidate for the same prompt. */
  const shotTake=(s:(typeof draft.shots)[number])=>approvals[s.key]??stills.find(t=>t.plan_key===s.key&&t.prompt===s.prompt&&t.state==="succeeded"&&!t.rejected_at);
  /** What the still decision says: approved, a finished candidate, or nothing yet. */
  const stillState=(take:StillTake|undefined):{word:string;tone:"ok"|"idle"}=>take?.approved_asset_id?{word:"Approved",tone:"ok"}:take?{word:"Frame ready",tone:"idle"}:{word:"Planned",tone:"idle"};
  /** The state word on the tile, from the same take its picture shows. */
  const shotState=(s:(typeof draft.shots)[number]):{word:string;tone:"active"|"ok"|"idle"}=>!dirty&&shotOutputs[s.key]?{word:"Rendered",tone:"active"}:stillState(shotTake(s));
  const shotFlag=(s:(typeof draft.shots)[number])=>{const state=shotState(s);return <StatusText tone={state.tone}>{state.word}</StatusText>;};
  /** The tile picture: the shot's rendered clip, else its first input image. */
  const shotPicture=(s:(typeof draft.shots)[number])=>{
    const out=!dirty&&shotOutputs[s.key];
    if(out)return <video src={assetUrl(workspace.id,out)} muted preload="metadata"/>;
    const still=shotTake(s);
    if(still?.output_ids[0])return <img src={assetUrl(workspace.id,still.approved_asset_id??still.output_ids[0])} alt=""/>;
    const input=s.assets.find(a=>a.role==="start_image")?.assetId;
    const asset=input?assets.find(a=>a.id===input):undefined;
    return asset&&asset.media_type!=="video"?<img src={assetUrl(workspace.id,asset.id)} alt=""/>:<span className="ds-storyboard-shot-placeholder" aria-hidden="true"><Clapperboard size={20}/></span>;
  };
  const posterItems:ContactSheetItem[]=draft.shots.map((s,i)=>{const take=shotTake(s);const id=take?.approved_asset_id??take?.output_ids[0]??s.assets.find(a=>a.role==="start_image")?.assetId;return {src:id?assetUrl(workspace.id,id):undefined,label:`${s.settings.title?.trim()||`Shot ${i+1}`} · ${stillState(take).word}`};});
  const joinOptions=joinChoices(draft.shots),joinValue=draft.assembly.transition?.kind==="crossfade"?`crossfade-${draft.assembly.transition.seconds}`:"cut";
  // One shot cannot be joined, so the row appears only when it has a real choice (rule 26), plus
  // whenever a stored fade is set and must be cleared.
  const joinShown=joinOptions.length>1||draft.assembly.transition?.kind==="crossfade";
  return <div className="cf-storyboard-page"><ShotStrip label="Shots" onAdd={add} addDisabled={locked||draft.shots.length>=32}>{draft.shots.map((s,i)=><ShotTile key={s.key} index={i+1} title={s.settings.title||s.prompt||"Untitled shot"} image={shotPicture(s)} flag={shotFlag(s)} meta={<Meta parts={[catalogue.find(m=>m.id===s.settings.generation?.capabilityId)?.title.split(" (")[0]??"Choose workflow",`${s.durationSeconds}s`]}/>} selected={s.key===selected} disabled={!!busy} buttonRef={el=>{if(el)shotButtons.current.set(s.key,el);else shotButtons.current.delete(s.key);}} onSelect={()=>setSelected(s.key)} tools={<><IconButton label={`Move shot ${i+1} earlier`} disabled={locked||i===0} onClick={()=>move(i-1)}><ArrowLeft size={14}/></IconButton><IconButton label={`Move shot ${i+1} later`} disabled={locked||i===draft.shots.length-1} onClick={()=>move(i+1)}><ArrowRight size={14}/></IconButton></>}/>)}</ShotStrip>
  <div className="cf-production cf-storyboard"><Panel header={<div className="cf-composer-heading cf-form"><Toolbar>{picker}{dirty&&<StatusText tone="warn">Unsaved</StatusText>}</Toolbar></div>} footer={<div className="cf-form">
    {(dirty||pendingSave)&&<Button variant="secondary" disabledReason={!canEdit?"Creator access is required.":saveInvalid?"Check shot titles, duration and pending uploads.":"Finish or resolve the current operation first."} disabled={!canEdit||!!busy||!!pendingRender||!!recovery||(!pendingSave&&(!!conflict||saveInvalid))} onClick={()=>void save()}>{pendingSave?"Check / retry save":"Save shots"}</Button>}
    {approvedCount>0&&<Meta>{`${approvedCount} of ${draft.shots.length} frame${draft.shots.length===1?"":"s"} approved`}</Meta>}
    {pendingRender?<Button disabled={!canEdit||!!busy} onClick={()=>void render()}>Retry confirmation</Button>:<GenerateButton disabled={!canRender} disabledReason={!canEdit?"Creator access is required.":dirty?"Save your shot cards first.":!draft.shots.length?"Create shot cards first.":missingPrompt>=0?`Add a prompt for shot ${missingPrompt+1}.`:invalid[0]??missing[0]??"Check the storyboard worker and output settings in Advanced."} label={dirty?"Save before rendering":allApproved?"Animate approved":"Render storyboard"} onClick={()=>void render()}/>}
  </div>}><div className="cf-form">
    {!canEdit&&(workspace.role==="viewer"
      ?<Notice tone="info" title="View-only storyboard">Your draft stays in this browser. Editing and rendering need creator access.</Notice>
      :<Notice priority={90} consequence title="Sign in or reconnect">Your draft stays in this browser; editing and rendering resume as soon as you reconnect.</Notice>)}
    {recovery&&<Notice priority={50} title="Browser draft available" actions={<><Button variant="secondary" disabled={!canEdit||!!busy} onClick={()=>{setDraft(recovery);setSelected(recovery.shots[0]?.key??"");if(recovery.revision!==board.revision)setConflict(board.revision);setRecovery(null);}}>Restore draft</Button><Button variant="ghost" disabled={!!pendingSave||!!pendingRender} onClick={()=>setRecovery(null)}>Discard browser draft</Button></>}>Revision {recovery.revision} · {recovery.shots.length} shots. {recovery.revision!==board.revision?"The saved board has changed; review before saving.":"Restore your local work or use the saved board."}</Notice>}
    {conflict>0&&<Notice priority={80} title={`Board changed (rev ${conflict} on server)`} actions={<><Button variant="secondary" onClick={()=>downloadJson(draft,`comfyfield-board-draft-${board.id}.json`)}>Export my draft</Button><Button variant="secondary" disabled={!!busy||!!pendingRender} onClick={()=>void reload()}>Load latest</Button></>}>Your draft has been kept for review. Export it before loading the latest revision.</Notice>}
    {pendingSave&&<Notice priority={70} title="Save awaiting confirmation" actions={<Button variant="secondary" disabled={!canEdit||!!busy||!!pendingRender} onClick={()=>void save()}>Retry save</Button>}>Editing is locked until the saved revision is checked. Retrying reuses the original revision and content, so nothing is saved twice.</Notice>}
    {pendingRender&&<Notice priority={70} title="Render awaiting confirmation" actions={<Button variant="secondary" disabled={!canEdit||!!busy} onClick={()=>void render()}>Retry confirmation</Button>}>The original saved revision, worker and settings are frozen. Retrying uses the same request identifier, so only one render is recorded.</Notice>}
    {failure&&<Notice priority={60} title={failure.title||"Storyboard needs attention"} actions={<Button variant="secondary" disabled={!!busy} onClick={()=>void reload()}>Load the saved board again</Button>} details={error}>{failure.text}</Notice>}{notice&&<div role="status"><Meta>{notice}</Meta></div>}
    <span className="ds-sr-only" aria-live="polite">{announcement}</span>
    <div className="cf-form">
      <PromptField label="Shot titles" compact placeholder="One shot title per line" value={script} onChange={setScript} disabled={locked}/>
      <Toolbar end={<Tooltip content="Download a contact sheet: one image showing your storyboard frames in shot order."><Button variant="ghost" disabled={!draft.shots.length} onClick={()=>setPosterOpen(true)}>Contact sheet</Button></Tooltip>}><Button variant="secondary" disabledReason={locked?"Finish the current save or render before adding shots.":!room?"This storyboard has reached its 32-shot limit.":scriptParts.some(title=>title.length>500)?"Keep each shot title under 500 characters.":"Enter a shot title above to create cards."} disabled={locked||!scriptParts.length||!room||scriptParts.some(title=>title.length>500)} onClick={planFromScript}>Create shot cards</Button></Toolbar>
    </div>
    <div className="cf-form">
      <PromptField label="Plan from a premise" compact placeholder="Describe the story, character and visual direction. You get three editable shots; nothing changes until you apply them." value={premise} onChange={setPremise} disabled={locked||planBusy}/>
      <Toolbar end={<Button variant="secondary" disabledReason={locked?"Finish the current save or render before planning.":!canEdit?"Creator access is required.":!room?"This storyboard has reached its 32-shot limit.":premise.trim().length<5?"Write at least one short premise.":undefined} disabled={locked||planBusy||!canEdit||!room||premise.trim().length<5} onClick={()=>void planPremise()}>{planBusy?(localPlan?"Planning locally…":"Planning…"):"Plan shots"}</Button>}><Meta parts={[localPlan&&"Local model only","Title, prompt, duration and camera intent stay separate"]}/></Toolbar>
      {planFailure&&<Notice priority={60} title={planFailure.title||"Plan unavailable"} actions={<Button variant="secondary" disabled={locked||planBusy||!canEdit||!room||premise.trim().length<5} onClick={()=>void planPremise()}>Try again</Button>} details={planError}>{planFailure.text}</Notice>}
    </div>
    <StoryboardStills boardId={board.id} workspace={workspace.id} revision={draft.revision} shots={draft.shots} selected={selected} catalogue={catalogue} workers={workers} call={call} authorized={authorized} canEdit={canEdit} disabled={locked||dirty||!!conflict||planInvalid} storageKey={storageKey} onTakes={setStills} onAssets={receiveStillAssets} onSelectShot={setSelected}/>
    {shot&&<><SectionHeader title={`Shot ${index+1}`} end={<IconButton label={`Remove shot ${index+1}`} disabled={locked} onClick={()=>setRemoving(true)}><Trash2 size={16}/></IconButton>}/><StoryboardShotEditor key={shot.key} shot={shot} manifests={manifests} assets={assets} elements={elements} workspace={workspace.id} disabled={locked} files={files[shot.key]??{}} onChange={next=>{if(next.settings.generation?.capabilityId!==shot.settings.generation?.capabilityId)setFiles(f=>({...f,[shot.key]:{}}));updateShot(next);}} onFile={(role,file)=>{setFiles(f=>({...f,[shot.key]:{...f[shot.key],[role]:file}}));if(file)updateShot({...shot,assets:shot.assets.filter(a=>a.role!==role)});}} onUpload={role=>void upload(role)}/></>}
    <Row subtle disabled={locked} label="Advanced" display="Output settings" onClick={()=>setRenderOpen(true)}/>
    <Dialog open={renderOpen&&!locked} title="Advanced" onClose={()=>setRenderOpen(false)} footer={<Button variant="primary" onClick={()=>setRenderOpen(false)}>Done</Button>}><div className="cf-form">
      <TeamChoice label="Storyboard worker" display={workers.find(w=>w.id===draft.workerId)?.name??"Choose a worker"} value={draft.workerId} disabled={locked} options={workers.map(w=>({value:w.id,label:w.name,note:boardRequirements(draft.shots,catalogue,w).join(" ")||"Ready for these shots"}))} onChange={workerId=>setDraft(d=>({...d,workerId}))}/>
      <Row label="Output frame size" display={chosenSize?.label??`${draft.assembly.width} × ${draft.assembly.height}`} value={chosenSize?.id??""} disabled={locked} options={outputSizes.map(s=>({value:s.id,label:s.label}))} onChange={id=>{const s=outputSizes.find(s=>s.id===id)!;setDraft(d=>({...d,assembly:{...d.assembly,width:s.width,height:s.height}}));}}/>
      <Row label="Output FPS" display={`${draft.assembly.fps} FPS`} value={draft.assembly.fps} disabled={locked} options={[24,25,30,60].map(v=>({value:v,label:`${v} FPS`}))} onChange={fps=>setDraft(d=>({...d,assembly:{...d.assembly,fps}}))}/>
      <Row label="Output audio" display={draft.assembly.audioPolicy==="mute"?"Mute":"Keep rendered audio"} value={draft.assembly.audioPolicy} disabled={locked} options={[{value:"mute",label:"Mute"},{value:"preserve",label:"Keep rendered audio"}]} onChange={audioPolicy=>setDraft(d=>({...d,assembly:{...d.assembly,audioPolicy}}))}/>
      {/* Hard cuts stream-copy; a cross-fade blends the joins and shortens the film by the overlap,
          so it is an explicit choice, offered only while assembly can build it. */}
      {joinShown&&<Row label="Shot joins" display={draft.assembly.transition?.kind==="crossfade"?`Cross-fade ${draft.assembly.transition.seconds} s`:"Hard cuts"} value={joinValue} disabled={locked} options={joinOptions.map(value=>({value,label:value==="cut"?"Hard cuts":`Cross-fade ${value.slice("crossfade-".length)} s`}))} onChange={value=>setDraft(d=>({...d,assembly:{...d.assembly,transition:value==="cut"?undefined:{kind:"crossfade",seconds:Number(value.slice("crossfade-".length))}}}))}/>}
      {(missing.length>0||requirements?.state!=="ready")&&<Notice priority={40} title="Render requirements" actions={<><Button variant="secondary" disabled={!authorized||!!busy} onClick={()=>setVersion(v=>v+1)}>Check requirements</Button></>}>{missing.join(" ")} {requirements?.state!=="ready"?(requirements?.instructions??"Checking server finishing requirements."):""}</Notice>}
    </div></Dialog>
  </div></Panel><StoryboardResults boardId={board.id} workspace={workspace} user={user} call={call} authorized={authorized} canEdit={canEdit} version={version} boardRevision={draft.revision} onShotOutputs={setShotOutputs} onContactSheet={()=>setPosterOpen(true)} onRenderAgain={()=>void render()}/></div><Dialog wide open={posterOpen&&authorized} title="Storyboard contact sheet" onClose={()=>setPosterOpen(false)} footer={<Button variant="secondary" onClick={()=>setPosterOpen(false)}>Close</Button>}><ContactSheet items={posterItems} title={`Storyboard · ${project.name}`} fileName={`storyboard-frames-${board.id.slice(0,8)}.png`} caption="Each frame is labeled with its state."/></Dialog>
    <Dialog wide open={!!plan} title="Review planned shots" onClose={()=>setPlan(null)} footer={<><Button variant="secondary" onClick={()=>setPlan(null)}>Keep editing</Button><Button disabled={locked||!room} onClick={applyPremisePlan}>Add {Math.min(plan?.shots.length??0,room)} planned shot{(Math.min(plan?.shots.length??0,room))===1?"":"s"}</Button></>}>
      <div className="cf-form">
        <Meta parts={[plan?planSource(plan):undefined,`${plan?.shots.length??0} proposed`,`${room} slot${room===1?"":"s"} left`,"Nothing is saved yet"]}/>
        {plan?.shots.map((shot,index)=><DataRow key={`${index}-${shot.title}`} title={<>{shot.title}<Meta parts={[`${shot.durationSeconds}s`,shot.shotIntent,shot.cameraIntent]} /></>} status={<Meta>Shot {index+1}</Meta>}/>)}
        <Meta>Prompts stay complete generation prompts; production notes are appended as separate lines.</Meta>
      </div>
    </Dialog>
    <Dialog open={removing&&authorized} title="Remove draft shot?" onClose={closeRemove} footer={<><Button variant="secondary" onClick={closeRemove}>Keep shot</Button><Button disabled={locked} onClick={remove}>Remove from draft</Button></>}>The saved board and existing rendered media stay available until you save the edited shot list.</Dialog></div>;
}


