import {ChevronDown,ChevronLeft,Info,Plus,VolumeX,X} from 'lucide-react';
import {useEffect,useMemo,useRef,useState} from 'react';
import {Button,Dialog,GenerateButton,IconButton,InlineSelect,Meta,Notice,Panel,PromptField,Thumb,ThumbGrid,UploadSlot} from '../ds';
import type {CapabilityManifestV2} from '../capabilities/types';
import {hasQualifiedDurationMapping} from '../capabilities/timing';
import {isSelectedVideoCreate} from '../capabilities/tasks';
import {ApiError,assetUrl,composerAssets,mergeAssets,workspacePath,type Asset,type AssetPage,type Call,type Project,type User,type Worker,type Workspace} from './api';
import {workerReadiness} from './state';
import {planKeyframeSegments,qualifyKeyframeTiming,keyframeSpans,keyframePositions,fitKeyframesToModel,removeKeyframe,type Keyframe} from './keyframe-plan';
import {buildKeyframeShots,definitiveKeyframeRejection,uncertainKeyframeCreation} from './keyframe-submission';
import {StoryboardResults} from './StoryboardResults';
import {saveOutcome,type Board as SavedBoard,type SaveIntent} from './storyboard-state';
import {ProductionContent} from './ProductionWorkspace';
import {ToolHero} from './heroes';
import {ExampleTiles} from './ExampleTiles';
import {KeyframeTimeline} from '../ds/KeyframeTimeline';
import {resolveImageReference} from '../image/image-reference';
import {insertReferenceMention} from './prompt-reference';

type Board={id:string;revision:number};
type Pending={board:Board;request:{revision:number;workerId:string;idempotencyKey:string;assembly:{width:number;height:number;fps:number;audioPolicy:'mute';keyframeBoundaries:true}}};
type Draft={modelId:string;frames:Keyframe[];prompts:string[];fps?:number;orientation?:'landscape'|'portrait';turbo?:boolean};
const timeLabel=(frame:number,fps:number)=>`${Number((frame/fps).toFixed(2))}s`;
export const keyframeModels=(catalogue:CapabilityManifestV2[])=>catalogue.filter(m=>isSelectedVideoCreate(m.id)&&m.coverage.local==='implemented'&&m.audioPolicies.includes('mute')&&[16,24,25,30,60].includes(m.timing?.fps??0)&&m.inputs.some(p=>p.id==='start_image'&&p.type==='image')&&m.inputs.some(p=>p.id==='end_image'&&p.type==='image')&&hasQualifiedDurationMapping(m));
export const draftFrameRate=(draft:Pick<Draft,'modelId'|'fps'>,catalogue:CapabilityManifestV2[],fallback:number)=>draft.fps??catalogue.find(m=>m.id===draft.modelId)?.timing?.fps??fallback;
function readDraft(key:string):Draft|null{try{const value=JSON.parse(localStorage.getItem(`${key}:draft`)??'null');return value&&typeof value.modelId==='string'&&Array.isArray(value.frames)&&value.frames.length>=2&&value.frames.length<=4&&value.frames.every((f:Keyframe)=>typeof f.assetId==='string'&&Number.isSafeInteger(f.frame)&&f.frame>=0)&&Array.isArray(value.prompts)&&value.prompts.length===value.frames.length-1&&value.prompts.every((p:unknown)=>typeof p==='string')?value:null;}catch{return null;}}

/** Keyframe editing uses the existing first/last ComfyUI graph and durable storyboard jobs. */
export function KeyframeStudio({workspace,project,user,catalogue,workers,call,authorized,canEdit,localEnabled,onChanged}:{workspace:Workspace;project:Project;user:User;catalogue:CapabilityManifestV2[];workers:Worker[];call:Call;authorized:boolean;canEdit:boolean;localEnabled:boolean;onChanged:()=>void}){
 const models=useMemo(()=>keyframeModels(catalogue),[catalogue]);
 const storageKey=`keyframes:${user.id}:${workspace.id}:${project.id}`;
 const [initialDraft]=useState(()=>readDraft(storageKey));
 const [modelId,setModelId]=useState(initialDraft?.modelId??''),[frames,setFrames]=useState<Keyframe[]>(initialDraft?.frames??[{assetId:'',frame:0},{assetId:'',frame:32}]),[prompts,setPrompts]=useState<string[]>(initialDraft?.prompts??['']),[assets,setAssets]=useState<Asset[]>([]),[picker,setPicker]=useState<number|null>(null),[busy,setBusy]=useState(''),[error,setError]=useState(''),[board,setBoard]=useState<Board|null>(()=>{try{return JSON.parse(localStorage.getItem(storageKey)??'null');}catch{return null;}}),[pending,setPending]=useState<Pending|null>(()=>{try{return JSON.parse(sessionStorage.getItem(`${storageKey}:pending`)??'null');}catch{return null;}}),[version,setVersion]=useState(0);
 const [creationUncertain,setCreationUncertain]=useState(false),gate=useRef(false);
 const selectionEpoch=useRef<Record<number,number>>({});
 const invalidateSelections=()=>{for(const index of Object.keys(selectionEpoch.current))selectionEpoch.current[Number(index)]++;};
 useEffect(()=>()=>invalidateSelections(),[workspace.id,project.id,modelId]);
 const [assetCursor,setAssetCursor]=useState<string|null>(null),[libraryError,setLibraryError]=useState('');
 const [rendering,setRendering]=useState(false);
 const [activeSegment,setActiveSegment]=useState(0);
 const segmentPrompt=useRef<HTMLTextAreaElement>(null);
 const [infoOpen,setInfoOpen]=useState(false);
 const [orientation,setOrientation]=useState<'landscape'|'portrait'>(initialDraft?.orientation==='portrait'?'portrait':'landscape'),[turbo,setTurbo]=useState(initialDraft?.turbo!==false);
 const model=models.find(m=>m.id===modelId)??models.find(m=>workers.some(w=>workerReadiness(m,w).state==='ready'))??models[0],fps=model?.timing?.fps??16;
 const canChooseOrientation=!!(model?.resolutions?.landscape&&model.resolutions.portrait)||!!model?.controls.find(c=>c.id==='aspect_ratio'&&c.options?.some(v=>typeof v==='string'&&v.startsWith('9:16')));
 const previousTiming=useRef<{id:string;fps:number}|null>(null);
 useEffect(()=>{if(!model||previousTiming.current?.id===model.id)return;const oldFps=previousTiming.current?.fps??(initialDraft?draftFrameRate(initialDraft,catalogue,fps):16);previousTiming.current={id:model.id,fps};try{setFrames(old=>fitKeyframesToModel(old,oldFps,model));}catch(e){setError((e as Error).message);}},[model?.id]);
 const readyWorker=model?workers.find(w=>workerReadiness(model,w).state==='ready'):undefined;
 useEffect(()=>{try{if(board)localStorage.setItem(storageKey,JSON.stringify(board));}catch{}},[storageKey,board]);
 useEffect(()=>{try{localStorage.setItem(`${storageKey}:draft`,JSON.stringify({modelId:model?.id??modelId,frames,prompts,fps,orientation,turbo}));}catch{}},[storageKey,modelId,model?.id,fps,frames,prompts,orientation,turbo]);
 useEffect(()=>{let current=true;if(authorized)void composerAssets(call,workspace.id,project.id,[]).then(page=>{if(current){setAssets(page.items);setAssetCursor(page.nextCursor);}}).catch(e=>{if(current)setError((e as Error).message);});return()=>{current=false;};},[authorized,call,workspace.id,project.id]);
 const images=assets.filter(a=>a.media_type==='image');
 let problem='';try{if(!model)throw new Error('No first-and-last-frame model is available.');qualifyKeyframeTiming(model,planKeyframeSegments(frames,prompts),fps);}catch(e){problem=(e as Error).message;}
 const locked=!!busy||!!pending||rendering||!canEdit;
 const duration=frames[frames.length-1].frame;
 function mentionFrame(index:number){if(locked||activeSegment<0||index<activeSegment||index>activeSegment+1||!frames[index]?.assetId)return;const text=prompts[activeSegment]??'',area=segmentPrompt.current,result=insertReferenceMention(text,area?.selectionStart??text.length,area?.selectionEnd??text.length,`@Image ${index-activeSegment+1}`);setPrompts(old=>old.map((value,i)=>i===activeSegment?result.value:value));requestAnimationFrame(()=>{segmentPrompt.current?.focus();segmentPrompt.current?.setSelectionRange(result.caret,result.caret);});}
 const addSpan=model?keyframeSpans(model).filter(span=>duration+span<=15*fps).sort((a,b)=>Math.abs(a-2*fps)-Math.abs(b-2*fps))[0]:undefined;
 function moveFrame(index:number,value:number){if(!model)return;setFrames(old=>{const options=keyframePositions(old,index,model);if(!options.length)return old;const closest=options.reduce((best,v)=>Math.abs(v-value)<Math.abs(best-value)?v:best);return old.map((frame,i)=>i===index?{...frame,frame:closest}:frame);});}
 function stepFrame(index:number,direction:-1|1){if(!model)return;setFrames(old=>{const options=keyframePositions(old,index,model),current=old[index].frame,next=direction===1?options.find(v=>v>current):options.filter(v=>v<current).at(-1);return next===undefined?old:old.map((frame,i)=>i===index?{...frame,frame:next}:frame);});}
 function removeFrame(index:number){if(locked||frames.length<=2)return;invalidateSelections();const next=removeKeyframe(frames,prompts,index);try{setFrames(model?fitKeyframesToModel(next.frames,fps,model):next.frames);setPrompts(next.prompts);setPicker(null);}catch(e){setError((e as Error).message);}}
 async function choose(index:number,id:string,known?:Asset){
  const epoch=selectionEpoch.current[index]=(selectionEpoch.current[index]??0)+1;
  try{
   if(id)await resolveImageReference(id,known?[known,...assets]:assets,workspace.id,project.id,call);
   if(selectionEpoch.current[index]!==epoch)return;
   setFrames(old=>old.map((frame,i)=>i===index?{...frame,assetId:id}:frame));setPicker(null);setError('');
  }catch(e){if(selectionEpoch.current[index]===epoch)setError((e as Error).message);}
 }
 async function upload(index:number,file:File|null){if(!file){void choose(index,'');return;}const epoch=selectionEpoch.current[index]=(selectionEpoch.current[index]??0)+1;setBusy('upload');try{const form=new FormData();form.append('file',file);const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${project.id}`),'POST',form);setAssets(old=>[asset,...old.filter(a=>a.id!==asset.id)]);if(selectionEpoch.current[index]===epoch)await choose(index,asset.id,asset);onChanged();}catch(e){if(selectionEpoch.current[index]===epoch)setError((e as Error).message);}finally{setBusy('');}}
 async function moreAssets(){if(!assetCursor||busy)return;setBusy('library');setLibraryError('');try{const page=await call<AssetPage>(workspacePath(workspace.id,`assets?projectId=${encodeURIComponent(project.id)}&cursor=${encodeURIComponent(assetCursor)}`));setAssets(old=>mergeAssets(old,page.items));setAssetCursor(page.nextCursor);}catch(e){setLibraryError((e as Error).message);}finally{setBusy('');}}
 function changeModel(id:string){if(models.some(m=>m.id===id))setModelId(id);}
 async function send(p:Pending){await call(workspacePath(workspace.id,`storyboards/${p.board.id}/renders`),'POST',p.request);setBoard(p.board);setPending(null);try{sessionStorage.removeItem(`${storageKey}:pending`);}catch{}setVersion(v=>v+1);onChanged();}
 async function generate(){if(gate.current||!canEdit)return;gate.current=true;setBusy('render');setError('');try{
  if(pending){await send(pending);return;}
  if(!model||!readyWorker)return;
  const {shots,width,height}=buildKeyframeShots(model,frames,prompts,fps,{orientation:canChooseOrientation?orientation:'landscape',turbo});
  let current=board;
  if(!current){try{current=await call<Board>(workspacePath(workspace.id,'storyboards'),'POST',{projectId:project.id,name:'Keyframe animation'});setBoard(current);}catch(e){setCreationUncertain(uncertainKeyframeCreation(e instanceof ApiError?e.status:undefined));throw e;}}
  const intent:SaveIntent={revision:current.revision,shots:shots.map(s=>({...s,assets:[...s.assets].sort((a,b)=>a.role.localeCompare(b.role))}))};
  let saved:{revision:number};try{saved=await call<{revision:number}>(workspacePath(workspace.id,`storyboards/${current.id}/shots`),'PUT',intent);}catch(e){
   if(e instanceof ApiError&&e.status<500)throw e;
   const latest=await call<SavedBoard>(workspacePath(workspace.id,`storyboards/${current.id}`)).catch(()=>null);
   if(!latest||saveOutcome(intent,latest)!=='saved')throw e;saved={revision:latest.revision};
  }
  current={...current,revision:saved.revision};setBoard(current);
  const next:Pending={board:current,request:{revision:current.revision,workerId:readyWorker.id,idempotencyKey:crypto.randomUUID(),assembly:{width,height,fps,audioPolicy:'mute',keyframeBoundaries:true}}};try{sessionStorage.setItem(`${storageKey}:pending`,JSON.stringify(next));}catch{throw new Error('Request tracking is unavailable; no render was submitted.');}setPending(next);await send(next);
 }catch(e){if(e instanceof ApiError&&definitiveKeyframeRejection(e.status)){setPending(null);try{sessionStorage.removeItem(`${storageKey}:pending`);}catch{}}setError((e as Error).message);}finally{gate.current=false;setBusy('');}}
 return <div className="cf-production cf-keyframes"><Panel footer={<GenerateButton busy={busy==='render'||rendering} label={pending?'Retry submission':'Animate'} disabled={!canEdit||!!busy||rendering||creationUncertain||(!pending&&(!readyWorker||!!problem))} disabledReason={!readyWorker?'A ready local model is needed':problem||undefined} onClick={()=>void generate()}/> }>
  <div className="cf-form"><div className="cf-keyframes__header"><a href="#video" aria-label="Back to video"><ChevronLeft size={18}/></a><span>Animate</span><span>/</span><strong>Key frames</strong><IconButton label="About keyframes" onClick={()=>setInfoOpen(true)}><Info size={19}/></IconButton></div>{!localEnabled&&<Meta>Choose This computer in the top bar to use local keyframe models.</Meta>}
   <div className="cf-keyframes__images">{frames.map((frame,index)=><div className="cf-keyframes__image" key={index} onClickCapture={event=>{if(event.target instanceof HTMLImageElement&&frame.assetId&&activeSegment>=0&&index>=activeSegment&&index<=activeSegment+1){event.preventDefault();mentionFrame(index);}}}><span className="cf-keyframes__time">{timeLabel(frame.frame,fps)}</span><UploadSlot tile label={`Frame ${index+1}`} hint="" accept="image/png,image/jpeg,image/webp" kinds={['image']} preview={frame.assetId?assetUrl(workspace.id,frame.assetId):null} previewKind="image" disabled={locked} onBrowse={()=>setPicker(index)} onFile={file=>{if(!file&&frames.length>2)removeFrame(index);else void upload(index,file);}} onAsset={id=>choose(index,id)}/>{frame.assetId&&activeSegment>=0&&index>=activeSegment&&index<=activeSegment+1&&<Button variant="ghost" className="cf-keyframes__mention" disabled={locked} aria-label={`Insert @Image ${index-activeSegment+1} into segment ${activeSegment+1} prompt`} onClick={()=>mentionFrame(index)}>@Image {index-activeSegment+1}</Button>}{frames.length>2&&!frame.assetId&&<span className="cf-keyframes__remove"><IconButton label={`Remove frame ${index+1}`} disabled={locked} onClick={()=>removeFrame(index)}><X size={12}/></IconButton></span>}</div>)}{frames.length<4&&<Button variant="ghost" className="cf-keyframes__add" disabled={locked||addSpan===undefined} onClick={()=>{if(addSpan===undefined)return;setFrames(old=>[...old,{assetId:'',frame:old[old.length-1].frame+addSpan}]);setPrompts(old=>[...old,'']);}}><Plus size={18}/><span>Add frame</span></Button>}</div>
   <KeyframeTimeline frames={frames} fps={fps} disabled={locked} onMove={moveFrame} onStep={stepFrame} activeSegment={Math.min(activeSegment,frames.length-2)}/>
   <div className="cf-keyframes__segments">{frames.slice(1).map((frame,index)=><div className="cf-keyframes__segment" key={index}><Button variant="ghost" className="cf-keyframes__segment-heading" aria-expanded={activeSegment===index} onClick={()=>setActiveSegment(activeSegment===index?-1:index)}><span className="cf-keyframes__segment-time">{timeLabel(frames[index].frame,fps).replace(/s$/,'')}–{timeLabel(frame.frame,fps)}</span><span>Segment {index+1}</span>{activeSegment!==index&&prompts[index]&&<span className="cf-keyframes__segment-summary">{prompts[index]}</span>}<ChevronDown size={16}/></Button>{activeSegment===index&&<PromptField textareaRef={segmentPrompt} tokens={['@Image 1','@Image 2']} compact label={`Segment ${index+1} prompt (optional)`} placeholder="Describe this transition" value={prompts[index]??''} disabled={locked} onChange={value=>setPrompts(old=>old.map((p,i)=>i===index?value:p))}/>}</div>)}</div>
   <div className="cf-keyframes__settings"><InlineSelect label="Aspect ratio" value={orientation} disabled={locked||!canChooseOrientation} onChange={setOrientation} options={[{value:'landscape',label:'16:9'},{value:'portrait',label:'9:16'}]}/><InlineSelect label="Render speed" value={turbo?'fast':'quality'} disabled={locked||!model?.controls.some(c=>c.id==='turbo')} onChange={value=>setTurbo(value==='fast')} options={[{value:'fast',label:'Fast'},{value:'quality',label:'Quality'}]}/><span className="cf-keyframes__muted" title="Keyframe animations are silent"><VolumeX size={17}/><span className="cf-keyframes__screen-reader">Silent output</span></span></div>
   {error&&<Notice inline title="Animation did not start" details={error}>{creationUncertain?'Check your storyboards before trying again; creation may have succeeded.':pending?'Retry keeps the same request.':'Check the inputs and try again.'}</Notice>}
  </div>
 </Panel><ProductionContent><ToolHero kind="keyframes"/>{board&&<StoryboardResults key={`${board.id}:${version}`} boardId={board.id} boardRevision={board.revision} workspace={workspace} user={user} call={call} authorized={authorized} canEdit={canEdit} version={version} onActiveChange={setRendering}/>}<ExampleTiles kind="video"/></ProductionContent>
 <Dialog open={infoOpen} title="Key frames" onClose={()=>setInfoOpen(false)}><Meta>Add two to four images, position the keyframes and describe each transition. The selected model determines which timings are available.</Meta><div className="cf-keyframes__model"><span>Model</span><InlineSelect label="Keyframe model" value={model?.id??''} disabled={locked||!models.length} onChange={changeModel} options={models.map(m=>({value:m.id,label:m.title}))}/></div></Dialog>
 <Dialog wide open={picker!==null} title="Choose a keyframe" onClose={()=>setPicker(null)}><div className="cf-form"><UploadSlot label="Upload image" hint="Choose or drop a picture" accept="image/png,image/jpeg,image/webp" kinds={['image']} disabled={locked} onFile={file=>{if(picker!==null)void upload(picker,file);}}/><ThumbGrid label="Project images">{images.map(image=><Thumb key={image.id} src={assetUrl(workspace.id,image.id)} label={image.name} disabled={locked} onSelect={()=>{if(!locked&&picker!==null)choose(picker,image.id);}}/>)}</ThumbGrid>{libraryError&&<Notice inline title="Couldn't load more images" details={libraryError}>Try again.</Notice>}{assetCursor&&<Button variant="secondary" disabled={locked} onClick={()=>void moreAssets()}>{busy==='library'?'Loading…':'Load more'}</Button>}</div></Dialog>
 </div>;
}
