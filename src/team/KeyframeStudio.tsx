import {Info} from 'lucide-react';
import {useEffect,useMemo,useRef,useState} from 'react';
import {Button,Dialog,GenerateButton,IconButton,InlineSelect,LabeledRow,Meta,Notice,Panel,PromptField,Thumb,ThumbGrid,UploadSlot} from '../ds';
import type {CapabilityManifestV2} from '../capabilities/types';
import {hasQualifiedDurationMapping} from '../capabilities/timing';
import {isFlashVideoCreate,routeTask} from '../capabilities/tasks';
import {ApiError,assetUrl,composerAssets,mergeAssets,workspacePath,type Asset,type AssetPage,type Call,type Project,type User,type Worker,type Workspace} from './api';
import {workerReadiness} from './state';
import {planKeyframeSegments,qualifyKeyframeTiming,keyframePositions,keyframeInsertPositions,insertKeyframe,moveKeyframeImage,fitKeyframesToModel,removeKeyframe,type Keyframe} from './keyframe-plan';
import {buildKeyframeShots,definitiveKeyframeRejection,uncertainKeyframeCreation} from './keyframe-submission';
import {StoryboardResults} from './StoryboardResults';
import {StoryboardLibrary} from './StoryboardLibrary';
import {saveOutcome,type Board as SavedBoard,type SaveIntent} from './storyboard-state';
import {ProductionContent} from './ProductionWorkspace';
import {ToolHero} from './heroes';
import {ExampleTiles} from './ExampleTiles';
import {KeyframeOptions,KeyframeSegment,KeyframeStrip,type KeyframeMediaDrop} from '../ds/KeyframeStrip';
import {acceptsMediaType,readExampleFile} from '../ds/example-media';
import {resolveImageReference} from '../image/image-reference';
import {insertReferenceMention} from './prompt-reference';
import {ROUTER_MODELS,type RouterModel} from '../capabilities/router-models';
import {routerSegmentRuns} from './keyframe-router';
import {TeamChoice} from './TeamChoice';

type Board={id:string;revision:number};
type Pending={board:Board;request:{revision:number;workerId:string;idempotencyKey:string;assembly:{width:number;height:number;fps:number;audioPolicy:'mute';keyframeBoundaries:true}}};
type Draft={modelId:string;frames:Keyframe[];prompts:string[];fps?:number;orientation?:'landscape'|'portrait';turbo?:boolean};
const timeLabel=(frame:number,fps:number)=>`${Number((frame/fps).toFixed(2))}s`;
const imageTypes='image/png,image/jpeg,image/webp';
export const keyframeModels=(catalogue:CapabilityManifestV2[])=>catalogue.filter(m=>isFlashVideoCreate(m.id)&&m.coverage.local==='implemented'&&m.audioPolicies.includes('mute')&&[16,24,25,30,60].includes(m.timing?.fps??0)&&m.inputs.some(p=>p.id==='start_image'&&p.type==='image')&&m.inputs.some(p=>p.id==='end_image'&&p.type==='image')&&hasQualifiedDurationMapping(m));
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
 const model=models.find(m=>m.id===modelId)??routeTask('video.first-last',models.filter(m=>workers.some(w=>workerReadiness(m,w).state==='ready')))?.pack??routeTask('video.first-last',models)?.pack,fps=model?.timing?.fps??16;
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
 /* Planning keyframes works on any Run on choice. Animating uses this computer's keyframe models, or without them
    Seedance 2.5 on Comfy Router: one clip per segment, from its first to its last keyframe. */
 const routerModels=ROUTER_MODELS.filter(m=>m.features.includes('keyframes')),[routerId,setRouterId]=useState(routerModels[0]?.id??'');
 const routerModel:RouterModel|undefined=localEnabled?undefined:routerModels.find(m=>m.id===routerId)??routerModels[0];
 const canRender=canEdit&&(localEnabled||!!routerModel);
 const [sent,setSent]=useState('');
 async function animateOnRouter(m:RouterModel){
  const runs=routerSegmentRuns(m,project.id,frames,prompts,fps);
  for(const run of runs)await call(workspacePath(workspace.id,'runs'),'POST',run);
  setSent(`${runs.length} ${runs.length===1?'clip':'clips'} sent to ${m.title}. They appear in Jobs and in this project's videos.`);onChanged();
 }
 function mentionFrame(index:number){if(locked||activeSegment<0||index<activeSegment||index>activeSegment+1||!frames[index]?.assetId)return;const text=prompts[activeSegment]??'',area=segmentPrompt.current,result=insertReferenceMention(text,area?.selectionStart??text.length,area?.selectionEnd??text.length,`@Image ${index-activeSegment+1}`);setPrompts(old=>old.map((value,i)=>i===activeSegment?result.value:value));requestAnimationFrame(()=>{segmentPrompt.current?.focus();segmentPrompt.current?.setSelectionRange(result.caret,result.caret);});}
 const positionsFor=(index:number)=>model&&index>0?keyframePositions(frames,index,model):[];
 const insertPositions=model?keyframeInsertPositions(frames,model):[];
 const mentionLabel=(index:number)=>!locked&&frames[index]?.assetId&&activeSegment>=0&&index>=activeSegment&&index<=activeSegment+1?`@Image ${index-activeSegment+1}`:null;
 function moveFrame(index:number,value:number){if(!model||locked)return;setFrames(old=>{const options=keyframePositions(old,index,model);if(!options.length)return old;const closest=options.reduce((best,v)=>Math.abs(v-value)<Math.abs(best-value)?v:best);return old.map((frame,i)=>i===index?{...frame,frame:closest}:frame);});}
 function reorder(from:number,to:number){if(locked)return;invalidateSelections();setFrames(old=>moveKeyframeImage(old,from,to));}
 function insertFrame(position:number,drop:KeyframeMediaDrop|null){
  if(locked)return;
  let next;try{next=insertKeyframe(frames,prompts,position);}catch(e){setError((e as Error).message);return;}
  invalidateSelections();setFrames(next.frames);setPrompts(next.prompts);setActiveSegment(next.index-1);
  const index=next.index;if(!drop)return;
  if(drop.kind==='asset')void choose(index,drop.value);
  else if(drop.kind==='files'){if(acceptsMediaType(imageTypes,drop.files[0].type))void upload(index,drop.files[0]);else setError('This media does not match the input. Choose a compatible file.');}
  else void readExampleFile(drop.value,imageTypes).then(file=>upload(index,file)).catch(e=>setError((e as Error).message));
 }
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
 async function generate(){if(gate.current||!canRender)return;gate.current=true;setBusy('render');setError('');setSent('');try{
  if(routerModel){await animateOnRouter(routerModel);return;}
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
 return <div className="cf-production cf-keyframes"><Panel footer={<GenerateButton busy={busy==='render'||rendering} label={pending?'Retry submission':'Animate'} disabled={!canRender||!!busy||rendering||creationUncertain||(routerModel?frames.some(f=>!f.assetId):(!pending&&(!readyWorker||!!problem)))} disabledReason={routerModel?(frames.some(f=>!f.assetId)?'Add a picture to every keyframe':undefined):!localEnabled?'Choose This computer in the top bar to animate':!readyWorker?'A ready local model is needed':problem||undefined} onClick={()=>void generate()}/> }>
  <div className="cf-form">{routerModel&&routerModels.length>1&&<TeamChoice label="Model" display={routerModel.title} value={routerModel.id} disabled={!!busy||rendering} options={routerModels.map(m=>({value:m.id,label:m.title,note:'Comfy Router'}))} onChange={setRouterId}/>}{!localEnabled&&<Meta>{routerModel?`Animates on ${routerModel.title} through Comfy Router, one clip per segment, on your Comfy credits.`:'Choose This computer in the top bar to use local keyframe models.'}</Meta>}
   <KeyframeStrip frames={frames.map(f=>({frame:f.frame,filled:!!f.assetId}))} fps={fps} maxFrame={15*fps} disabled={locked} activeSegment={Math.min(activeSegment,frames.length-2)} positions={positionsFor} insertPositions={insertPositions} onMove={moveFrame} onReorder={reorder} onInsert={insertFrame} onRemove={frames.length>2?removeFrame:undefined} mention={mentionLabel} onMention={mentionFrame} end={<IconButton label="About keyframes" onClick={()=>setInfoOpen(true)}><Info size={16}/></IconButton>}
    media={index=><UploadSlot tile label={`Frame ${index+1}`} hint="" accept={imageTypes} kinds={['image']} preview={frames[index].assetId?assetUrl(workspace.id,frames[index].assetId):null} previewKind="image" disabled={locked} removeLabel={frames.length>2?`Remove frame ${index+1}`:`Clear frame ${index+1}`} onBrowse={()=>setPicker(index)} onFile={file=>{if(!file&&frames.length>2)removeFrame(index);else void upload(index,file);}} onAsset={id=>choose(index,id)}/>}/>
   <div>{frames.slice(1).map((frame,index)=><KeyframeSegment key={index} time={`${timeLabel(frames[index].frame,fps).replace(/s$/,'')}–${timeLabel(frame.frame,fps)}`} title={`Segment ${index+1}`} summary={prompts[index]} open={activeSegment===index} onToggle={()=>setActiveSegment(activeSegment===index?-1:index)}><PromptField textareaRef={segmentPrompt} tokens={['@Image 1','@Image 2']} compact label={`Segment ${index+1} prompt (optional)`} placeholder="Describe this transition" value={prompts[index]??''} disabled={locked} onChange={value=>setPrompts(old=>old.map((p,i)=>i===index?value:p))}/></KeyframeSegment>)}</div>
   <KeyframeOptions silent><InlineSelect label="Aspect ratio" value={orientation} disabled={locked||!canChooseOrientation} onChange={setOrientation} options={[{value:'landscape',label:'16:9'},{value:'portrait',label:'9:16'}]}/><InlineSelect label="Render speed" value={turbo?'fast':'quality'} disabled={locked||!model?.controls.some(c=>c.id==='turbo')} onChange={value=>setTurbo(value==='fast')} options={[{value:'fast',label:'Fast'},{value:'quality',label:'Quality'}]}/></KeyframeOptions>
   {sent&&<Meta>{sent}</Meta>}
   {error&&<Notice inline title="Animation did not start" details={error}>{creationUncertain?'Check your storyboards before trying again; creation may have succeeded.':pending?'Retry keeps the same request.':'Check the inputs and try again.'}</Notice>}
  </div>
 </Panel><ProductionContent><ToolHero kind="keyframes"/>{board&&<StoryboardResults key={`${board.id}:${version}`} boardId={board.id} boardRevision={board.revision} workspace={workspace} user={user} call={call} authorized={authorized} canEdit={canEdit} version={version} onActiveChange={setRendering}/>}<StoryboardLibrary workspace={workspace.id} assets={assets} disabled={locked} onSelect={id=>{const empty=frames.findIndex(f=>!f.assetId);void choose(empty<0?Math.max(0,activeSegment):empty,id);}}/><ExampleTiles kind="video"/></ProductionContent>
 <Dialog open={infoOpen} title="Key frames" onClose={()=>setInfoOpen(false)}><Meta>Add two to four images, position the keyframes and describe each transition. The selected model determines which timings are available.</Meta><LabeledRow label="Model"><InlineSelect label="Keyframe model" value={model?.id??''} disabled={locked||!models.length} onChange={changeModel} options={models.map(m=>({value:m.id,label:m.title}))}/></LabeledRow></Dialog>
 <Dialog wide open={picker!==null} title="Choose a keyframe" onClose={()=>setPicker(null)}><div className="cf-form"><UploadSlot label="Upload image" hint="Choose or drop a picture" accept="image/png,image/jpeg,image/webp" kinds={['image']} disabled={locked} onFile={file=>{if(picker!==null)void upload(picker,file);}}/><ThumbGrid label="Project images">{images.map(image=><Thumb key={image.id} src={assetUrl(workspace.id,image.id)} label={image.name} disabled={locked} onSelect={()=>{if(!locked&&picker!==null)choose(picker,image.id);}}/>)}</ThumbGrid>{libraryError&&<Notice inline title="Couldn't load more images" details={libraryError}>Try again.</Notice>}{assetCursor&&<Button variant="secondary" disabled={locked} onClick={()=>void moreAssets()}>{busy==='library'?'Loading…':'Load more'}</Button>}</div></Dialog>
 </div>;
}
