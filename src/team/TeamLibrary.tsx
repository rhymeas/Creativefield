import type {ReactNode} from "react";
import {lazy,Suspense,useEffect,useState} from "react";
import {Download,Eye,Image as ImageIcon, Pencil,Trash2} from "lucide-react";
import {ASSET_TYPE_DRAG,FrameStrip,Block,LazyVideo,MosaicGrid,MosaicTile,ResultTile,mosaicAccent,Button,ClampText,ConfirmDialog,ContactSheet,Dialog,IconButton,MediaViewer,MediaViewerInfo,Notice,EmptyState,HistoryItem,LinkButton,MediaCard,Meta,PerformanceMirror,ResultGrid,SectionHeader,SegmentedTabs,StatusText,Toolbar,UploadSlot,UploadTile,densityColumnsClass,useDensity,type ContactSheetItem} from "../ds";

import {assetUrl,workspacePath,type Asset,type AssetPage,type Call,type Project,type Run,type User,type Worker,type Workspace} from "./api";
import type {LibraryScreen} from "./navigation";
import {RunFrameInspection} from "./RunFrameInspection";
import {RunReferenceInspection} from "./RunReferenceInspection";
import { RunDevelop,renderTime } from "./RunDevelop";
import {runShape} from "./run-shape";
const VoiceRunReview=lazy(()=>import("./audio/VoiceRunReview").then(module=>({default:module.VoiceRunReview})));
const SpeechAudioPlayer=lazy(()=>import("./audio/SpeechAudioPlayer").then(module=>({default:module.SpeechAudioPlayer})));
import {activeRun,runLabel} from "./state";
import {ExampleTiles} from "./ExampleTiles";
import {MediaPreview} from "./MediaPreview";
import {newestMediaFirst} from "./media-order";
import {adjacentItem} from "../ds/MediaSequence";
import {FEATURED_VIDEO_EXAMPLES,LIBRARY_EXAMPLE_VIDEOS,SQUAREHEAD_EXAMPLE_IMAGES,SQUAREHEAD_EXAMPLE_VIDEOS,promoReelForCapability} from "./reels";
import {jobQueueTitle,runLocation} from "./job-queue";
import {producerRunId,useRecreate,useRecreateById} from "./recreate";
import {capabilityHasControl,isTrackedMaskWorkflow} from "../capabilities/lookup";
import {sharpenRunBody} from "./sharpen-run";
import {libraryFeedAssets,useStoryboardFeed,type FeedScope} from "./media-feed";

/** A click handler for a file whose run is known; nothing for a file that was uploaded. */
const withRun=(runId:string|undefined,go:(runId:string)=>Promise<void>)=>runId?()=>void go(runId):undefined;

function visibleRunInputs(workspaceId:string,run:Run){
  const review=run.invocation?.maskReviewSnapshot;
  const hiddenId=review?.mode==="automatic_edit"?review.maskAssetId:undefined;
  return Object.entries(run.invocation?.inputs??{})
    .filter(([,id])=>typeof id==="string"&&id&&id!==hiddenId)
    .map(([port,id])=>({src:assetUrl(workspaceId,id),label:port.replaceAll("_"," "),video:/video|clip/i.test(port)}));
}

export function downloadJson(value:unknown,name:string){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"}));const link=document.createElement("a");link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export type RunTitles=Record<string,string>;
const needsReconciliation=(run:Run)=>run.state==="submission_unknown"||(run.state==="cancel_requested"&&!run.remote_id);
export const canOpenRunInNodes=(run:Run,localWorkers:Record<string,true>)=>run.state==="succeeded"&&!!run.worker_id&&!!localWorkers[run.worker_id]&&!!run.remote_id;
const runTone=(state:string)=>/fail|cancel|error|unknown/.test(state)?"warn" as const:/succe|complete|done/.test(state)?"ok" as const:/run|start|submit/.test(state)?"active" as const:"idle" as const;
const ModelPreview=lazy(()=>import("../image/OrbitPreview").then(m=>({default:m.OrbitPreview})));
export function TeamRuns({workspace,project,call,canEdit,authorized,version,user,titles={},capabilityId,hero,outputAction,examples,feed,linkedRunId}:{/** The shared feed of this kind (all video or all image results) instead of one workflow's runs. */feed?:FeedScope;linkedRunId?:string;/** Example media under the real runs, so a tool never looks empty. */examples?:"video"|"image";workspace:Workspace;project:Project;call:Call;canEdit:boolean;authorized:boolean;version:number;user:User;titles?:RunTitles;/** Beside a composer: show only this workflow's runs. */capabilityId?:string|string[];/** The tool's encouraging line above its results; it is given the newest finished clip. */hero?:(latest?:string)=>ReactNode;outputAction?:(run:Run)=>ReactNode}){
  return <ProjectRuns key={`${workspace.id}:${project.id}:${authorized}:${feed?`feed:${feed.kind}`:[capabilityId??""].flat().join(",")}`} {...{workspace,project,call,canEdit,authorized,version,user,titles,capabilityId,hero,outputAction,examples,feed,linkedRunId}}/>;
}
function ProjectRuns({workspace,project,call,canEdit,authorized,version,user,titles={},capabilityId,hero,outputAction,examples,feed,linkedRunId}:Parameters<typeof TeamRuns>[0]){
  const storyboard=useStoryboardFeed(call,workspace.id,project.id,authorized,!!feed,version),[onlyCurrent,setOnlyCurrent]=useState(false);
  const [feedAssets,setFeedAssets]=useState<Asset[]>([]),[feedAssetError,setFeedAssetError]=useState("");
  useEffect(()=>{if(!authorized||!feed)return;let current=true;let timer:ReturnType<typeof setTimeout>;
    async function read(){try{const items:Asset[]=[];let cursor:string|null=null;do{const page:AssetPage=await call<AssetPage>(workspacePath(workspace.id,`assets?projectId=${encodeURIComponent(project.id)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`));items.push(...page.items);cursor=page.nextCursor;}while(cursor&&current);if(current){setFeedAssets(items);setFeedAssetError("");}}catch(e){if(current)setFeedAssetError((e as Error).message);}finally{if(current)timer=setTimeout(read,10000);}}
    void read();return()=>{current=false;clearTimeout(timer);};
  },[authorized,call,workspace.id,project.id,feed?.kind,version]);
  const recreate=useRecreate();
  // The list holds the short record; what a run was made from comes with its own record, fetched when its details open.
  const [detail,setDetail]=useState<Record<string,Run>>({});
  const [loadedRuns,setRuns]=useState<Run[]>([]),[error,setError]=useState(""),[update,setUpdate]=useState(0),[canceling,setCanceling]=useState(""),[manual,setManual]=useState<Run|null>(null),[picked,setPicked]=useState<Record<string,true>>({}),[sheetOpen,setSheetOpen]=useState(false),[cloudWorkers,setCloudWorkers]=useState<Record<string,true>>({}),[localWorkers,setLocalWorkers]=useState<Record<string,true>>({});
  // Run details name the place a run happened. Only a worker row knows which ones are Comfy Cloud.
  useEffect(()=>{if(!authorized)return;let current=true;void call<Worker[]>(workspacePath(workspace.id,"workers")).then(list=>{if(current){setCloudWorkers(Object.fromEntries(list.filter(worker=>(worker as Worker&{kind?:string}).kind==="cloud").map(worker=>[worker.id,true])));setLocalWorkers(Object.fromEntries(list.filter(worker=>(worker as Worker&{kind?:string}).kind==="local").map(worker=>[worker.id,true])));}}).catch(()=>{});return()=>{current=false;};},[workspace.id,call,authorized]);
  useEffect(()=>{if(!authorized)return;let current=true;let timer:ReturnType<typeof setTimeout>;
    async function poll(){try{const result=await call<Run[]>(workspacePath(workspace.id,`runs?projectId=${project.id}`));if(current){
      setRuns(feed?result.filter(run=>feed.capabilities.includes(run.capability_id)||!!run.output_content_type?.startsWith(`${feed.kind}/`)):capabilityId?result.filter(run=>[capabilityId].flat().includes(run.capability_id)):result);setError("");
    }}catch(e){if(current)setError((e as Error).message);}finally{if(current)timer=setTimeout(poll,4000);}}
    void poll();return()=>{current=false;clearTimeout(timer);};
  },[workspace.id,project.id,call,authorized,version,update]);
  const runs=loadedRuns.filter(run=>!isTrackedMaskWorkflow(run.capability_id)||run.id===linkedRunId);
  const linkedRunReady=!!linkedRunId&&runs.some(run=>run.id===linkedRunId);
  useEffect(()=>{if(!linkedRunReady)return;const timer=setTimeout(()=>document.getElementById(`cf-run-${linkedRunId}`)?.scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth",block:"center"}),80);return()=>clearTimeout(timer);},[linkedRunId,linkedRunReady]);
  const recreateById=useRecreateById(call,workspace.id,setError);
  async function loadDetail(run:Run){if(detail[run.id]||run.invocation)return;try{const full=await call<Run>(workspacePath(workspace.id,`runs/${run.id}`));setDetail(old=>({...old,[run.id]:full}));}catch{/* the details stay short; nothing else depends on them */}}
  /* A working tile in the feed keeps the shape its result will have, and that lives in the run's own record. */
  const workingRuns=feed?runs.filter(run=>activeRun(run.state)&&!run.output_ids[0]):[],workingKey=workingRuns.map(run=>run.id).join();
  useEffect(()=>{for(const run of workingRuns)void loadDetail(run);},[workingKey]);
  /** Sharpen this take: the same inputs and settings (so the same seed and draft) again, with the 2x Sharpen stage on. */
  async function sharpen(run:Run){
    if(!run.invocation||!run.worker_id)return;setCanceling(run.id);
    try{await call(workspacePath(workspace.id,"runs"),"POST",sharpenRunBody(run,crypto.randomUUID()));setUpdate(v=>v+1);}
    catch(e){setError((e as Error).message);}finally{setCanceling("");}
  }
  async function cancel(run:Run){setCanceling(run.id);try{await call(workspacePath(workspace.id,`runs/${run.id}/cancel`),"POST");setUpdate(v=>v+1);}catch(e){setError((e as Error).message);}finally{setCanceling("");}}
  async function resolveUnknown(run:Run){setCanceling(run.id);try{await call(workspacePath(workspace.id,`runs/${run.id}/resolve-unknown`),"POST");setUpdate(v=>v+1);}catch(e){setError((e as Error).message);}finally{setCanceling("");}}
  async function markFailed(run:Run){setCanceling(run.id);try{await call(workspacePath(workspace.id,`runs/${run.id}/resolve-unknown`),"POST",{resolution:"mark_failed"});setUpdate(v=>v+1);}catch(e){setError((e as Error).message);}finally{setCanceling("");}}
  async function exportGraph(run:Run){try{downloadJson(await call(workspacePath(workspace.id,`runs/${run.id}/workflow`)),`comfyfield-${run.id}.json`);}catch(e){setError((e as Error).message);}}
  const motionCandidate=runs.find(run=>run.state==="succeeded"&&run.output_ids[0]&&run.capability_id==="wan-animate2-distilled");
  const [motionDetail,setMotionDetail]=useState<Run|null>(null);
  useEffect(()=>{let current=true;setMotionDetail(null);if(authorized&&motionCandidate)void call<Run>(workspacePath(workspace.id,`runs/${motionCandidate.id}`)).then(run=>{if(current)setMotionDetail(run);}).catch(e=>{if(current)setError((e as Error).message);});return()=>{current=false;};},[authorized,workspace.id,project.id,motionCandidate?.id,call]);
  const motionRun=motionDetail?.id===motionCandidate?.id&&motionDetail?.project_id===project.id&&motionDetail.invocation?.inputs.motion_video?motionDetail:null;
  const seenImages=new Set<string>();
  const imageOutputs=runs.flatMap(run=>run.output_content_type?.startsWith("image/")?run.output_ids.map((id,index)=>({id,index,run})):[]).filter(output=>{if(seenImages.has(output.id))return false;seenImages.add(output.id);return true;});
  const pickedOutputs=imageOutputs.filter(output=>picked[output.id]);
  const sheetItems:ContactSheetItem[]=pickedOutputs.map(({id})=>({src:assetUrl(workspace.id,id)}));
  const togglePicked=(id:string)=>setPicked(old=>{const next={...old};if(next[id])delete next[id];else next[id]=true;return next;});
  const latestClip=runs.find(run=>run.state==="succeeded"&&run.output_content_type?.startsWith("video/")&&run.output_ids[0]);
  // What a run's model was given and made first, when the run kept those frames (rule 58).
  const SEEN:Record<string,string>={reference_frame:"Reference frame",reference_mask:"Reference mask",source_mask:"Clip mask",first_frame:"First frame"};
  const seenOf=(r:Run)=>((r as Run&{extras?:Array<{role:string;assetId:string}>}).extras??[]).filter(e=>SEEN[e.role]).map(e=>({src:assetUrl(workspace.id,e.assetId),label:SEEN[e.role]}));
  // Only what exists is shown (rule 56): a failed or cancelled run, or one whose result file was removed, leaves the list.
  const shown=runs.filter(run=>!["failed","canceled","cancelled"].includes(run.state)&&!(run.state==="succeeded"&&(!run.output_ids.length||!run.output_content_type)));
  /** What the full view and the details list about a run: model, quality, length, seed and where it ran. */
  const runFacts=(run:Run,full:Run)=>{const c=full.invocation?.controls??{};return [
    {label:"Model",value:jobQueueTitle(run.capability_id,titles)},
    ...(typeof c.width==="number"&&typeof c.height==="number"?[{label:"Quality",value:`${c.width} × ${c.height}`}]:c.megapixels!==undefined?[{label:"Quality",value:`${c.megapixels} MP`}]:c.resolution!==undefined?[{label:"Quality",value:String(c.resolution)}]:[]),
    ...(c.aspect_ratio!==undefined?[{label:"Format",value:String(c.aspect_ratio).replace(/ \(.*\)$/,"")}]:[]),
    ...(c.length!==undefined?[{label:"Length",value:`${c.length} s`}]:[]),
    ...(c.seed!==undefined?[{label:"Seed",value:String(c.seed)}]:[]),
    ...(renderTime(full)?[{label:"Render time",value:renderTime(full)!}]:[]),
    {label:"Ran on",value:runLocation(run.transport,!!cloudWorkers[run.worker_id??""])}];};
  const runItem=(run:Run,inFeed=false)=>{const state=runLabel[run.state]??run.state,full=detail[run.id]??run;return <div className="cf-run-item" role={inFeed?undefined:"listitem"} id={inFeed?undefined:`cf-run-${run.id}`} key={run.id} onDragStart={event=>{if(run.output_content_type)event.dataTransfer.setData(ASSET_TYPE_DRAG,run.output_content_type);}}><HistoryItem media={run.output_ids[0]?run.output_content_type==="model/gltf-binary"?<Suspense fallback={<Meta>Loading model preview</Meta>}><ModelPreview url={assetUrl(workspace.id,run.output_ids[0])} standalone/></Suspense>:run.output_content_type?.startsWith("image/")?<img draggable={false} loading="lazy" src={assetUrl(workspace.id,run.output_ids[0])} alt={`${jobQueueTitle(run.capability_id,titles)} result`}/>:run.output_content_type?.startsWith("audio/")?<audio controls preload="metadata" src={assetUrl(workspace.id,run.output_ids[0])}/>:run.output_content_type?.startsWith("video/")?<video draggable={false} controls preload="metadata" src={assetUrl(workspace.id,run.output_ids[0])}/>:<Meta>Output is available in Downloads</Meta>:<RunDevelop workspaceId={workspace.id} run={run} cancelling={canceling===run.id||run.state==="cancel_requested"} onCancel={canEdit&&activeRun(run.state)&&(workspace.role==="admin"||run.created_by===user.id)?()=>void cancel(run):undefined}/>} model={jobQueueTitle(run.capability_id,titles)} shape={inFeed&&!run.output_ids[0]?runShape(full.invocation?.controls):undefined} mode={feed?.modes?.[run.capability_id]} prompt={String(full.invocation?.controls?.prompt??"")} onOpenDetails={()=>void loadDetail(run)} onDelete={canEdit&&!activeRun(run.state)?async()=>{await call(workspacePath(workspace.id,`runs/${encodeURIComponent(run.id)}`),"DELETE");setRuns(old=>old.filter(item=>item.id!==run.id));}:undefined} meta={<StatusText tone={runTone(run.state)}>{state}</StatusText>} date={new Date(run.created_at).toLocaleString()} actions={<>
      {canEdit&&activeRun(run.state)&&run.state!=="cancel_requested"&&(workspace.role==="admin"||run.created_by===user.id)&&<Button variant="secondary" aria-label={`Cancel run ${run.id}`} disabled={canceling===run.id} onClick={()=>void cancel(run)}>Cancel</Button>}
      {canEdit&&needsReconciliation(run)&&(workspace.role==="admin"||run.created_by===user.id)&&<Button variant="secondary" aria-label={`Resolve run ${run.id}`} disabled={canceling===run.id} onClick={()=>void resolveUnknown(run)}>Resolve</Button>}
      {canEdit&&needsReconciliation(run)&&(workspace.role==="admin"||run.created_by===user.id)&&<Button variant="ghost" aria-label={`Mark run ${run.id} failed`} disabled={canceling===run.id} onClick={()=>setManual(run)}>Mark not accepted</Button>}
      {imageOutputs.filter(output=>output.run.id===run.id).map(output=><Button variant="ghost" key={output.id} aria-label={`${picked[output.id]?"Remove":"Add"} image ${output.index+1} of run ${run.id} ${picked[output.id]?"from":"to"} contact sheet`} onClick={()=>togglePicked(output.id)}>{picked[output.id]?"Remove from sheet":`Add to sheet${run.output_ids.length>1?` ${output.index+1}`:""}`}</Button>)}
      {authorized&&run.capability_id==="wan21-infinitetalk"&&run.state==="succeeded"&&run.output_ids[0]&&<Suspense fallback={null}><VoiceRunReview key={run.id} workspace={workspace.id} project={project.id} runId={run.id} outputId={run.output_ids[0]} call={call}/></Suspense>}
      {run.output_ids.map((id,i)=><LinkButton variant="secondary" key={id} href={assetUrl(workspace.id,id,true)}>Download{run.output_ids.length>1?` ${i+1}`:""}</LinkButton>)}
      {canOpenRunInNodes(run,localWorkers)&&<LinkButton variant="secondary" href={`#nodes/run/${encodeURIComponent(run.id)}`}>Open in Nodes</LinkButton>}
      {/* The tool's own next steps (Edit image, Use in video) live here, in the result's details, never under the content. */}
      {run.state==="succeeded"&&outputAction?.(run)}
      {canEdit&&run.state==="succeeded"&&full.invocation&&full.worker_id&&full.invocation.controls.sharpen!==true&&capabilityHasControl(run.capability_id,"sharpen")&&<Button variant="secondary" disabled={canceling===run.id} onClick={()=>void sharpen(full)}>Sharpen this take</Button>}
      <Button variant="ghost" disabled={run.state==="pending"} onClick={()=>void exportGraph(run)}>Export workflow</Button>
    </>} onRecreate={recreate(full)??(run.state==="succeeded"&&run.output_ids.length?()=>void recreateById(run.id):undefined)} inputs={visibleRunInputs(workspace.id,full)} facts={runFacts(run,full)} details={<>{full.capability_id==="scail2-character-replace"&&full.invocation&&<RunReferenceInspection workspace={workspace.id} run={full} call={call}/>}{seenOf(full).length>0&&<FrameStrip label="What the model saw" items={seenOf(full)}/>}{run.error?<ClampText text={run.error} lines={2} title="Why this run failed"/>:null}<Meta parts={[`Version ${run.capability_version}`,run.id]}/></>}/>{run.capability_id==="wan22-flf2v-14b"&&run.state==="succeeded"&&run.output_ids[0]&&<RunFrameInspection workspace={workspace.id} runId={run.id} call={call} authorized={authorized} canEdit={canEdit}/>}</div>;};
  const runTiles=shown.map(run=>runItem(run));
  /* The shared feed: every result of this kind in the project, newest first, the finished storyboard films among
     them, packed as a mosaic. The open app's results are marked, and can be shown alone. */
  const feedRuns=feed?shown.filter(run=>!storyboard.hidden.has(run.id)&&(!onlyCurrent||!!feed.current?.includes(run.capability_id))):[];
  const feedFilms=feed?.kind==="video"&&!onlyCurrent?storyboard.films.filter(film=>film.assetId):[];
  const represented=new Set([...feedRuns.flatMap(run=>run.output_ids.slice(0,1)),...feedFilms.flatMap(film=>film.assetId?[film.assetId]:[])]);
  const feedLibrary=feed&&!onlyCurrent?libraryFeedAssets(feedAssets,feed.kind,represented):[];
  const feedItems=[...feedRuns.map(run=>({at:run.created_at,run,film:undefined,asset:undefined})),...feedFilms.map(film=>({at:film.createdAt,run:undefined,film,asset:undefined})),...feedLibrary.map(asset=>({at:asset.created_at,run:undefined,film:undefined,asset}))].sort((a,b)=>b.at.localeCompare(a.at));
  /* Uploads, references and films go like results do: the server deletes the file, or hides it when a run still needs it. */
  const removeAsset=canEdit?(id:string)=>async()=>{try{await call(workspacePath(workspace.id,`assets/${encodeURIComponent(id)}`),"DELETE");setFeedAssets(old=>old.filter(asset=>asset.id!==id));setUpdate(v=>v+1);}catch(e){setError((e as Error).message);}}:undefined;
  const feedView=feed&&(feedItems.length?<MosaicGrid label={feed.kind==="video"?"All videos in this project":"All images in this project"} head={{start:feed.kind==="video"?"All videos in this project":"All images in this project",end:feed.current?.length?<SegmentedTabs quiet label="Show" value={onlyCurrent?"app":"all"} onChange={value=>setOnlyCurrent(value==="app")} items={[{id:"all",label:"All"},{id:"app",label:"This app"}]}/>:undefined}}>
    {feedItems.map((item,index)=>item.run
      ?<MosaicTile key={item.run.id} id={`cf-run-${item.run.id}`} accent={mosaicAccent(index)} aspect={feed.kind==="image"?1:16/9} current={!!feed.current?.includes(item.run.capability_id)}>{runItem(item.run,true)}</MosaicTile>
      :item.film?<MosaicTile key={item.film.id} accent={mosaicAccent(index)}><ResultTile caption={item.film.board} onDelete={removeAsset?.(item.film.assetId!)} deleteTitle="Delete this film?" dragAsset={{id:item.film.assetId!,url:assetUrl(workspace.id,item.film.assetId!),contentType:"video/mp4"}}><video aria-label={`Film ${item.film.board}`} controls preload="metadata" draggable={false} src={assetUrl(workspace.id,item.film.assetId!)}/></ResultTile></MosaicTile>
      :<MosaicTile key={item.asset!.id} accent={mosaicAccent(index)} aspect={feed.kind==="image"?1:16/9}><ResultTile onRecreate={canEdit?withRun(producerRunId(item.asset!,runs),recreateById):undefined} onDelete={removeAsset?.(item.asset!.id)} dragAsset={{id:item.asset!.id,url:assetUrl(workspace.id,item.asset!.id),contentType:item.asset!.content_type}}>{feed.kind==="image"?<img loading="lazy" draggable={false} src={assetUrl(workspace.id,item.asset!.id)} alt={item.asset!.name}/>:<LazyVideo controls draggable={false} src={assetUrl(workspace.id,item.asset!.id)} label={item.asset!.name}/>}</ResultTile></MosaicTile>)}
  </MosaicGrid>:!examples?<Meta>{feed.kind==="video"?"No videos yet. Every video you make in any video app appears here.":"No images yet. Every image you make in any image app appears here."}</Meta>:null);

  return <Block label="Project runs">{hero?.(latestClip?assetUrl(workspace.id,latestClip.output_ids[0]):undefined)}{error&&<Notice priority={20} consequence title="Runs couldn't be updated" actions={<Button variant="secondary" onClick={()=>setUpdate(v=>v+1)}>Check again</Button>} details={error}>The list shows the last runs it read; nothing was cancelled. Checking again reads them once more.</Notice>}{!shown.length&&!examples&&<Meta>{capabilityId?"No runs yet. Runs of this workflow appear here after you queue one.":"No runs yet. Queue a workflow from Video or Motion Control and it will show up here."}</Meta>}
    {motionRun&&<PerformanceMirror driving={assetUrl(workspace.id,motionRun.invocation!.inputs.motion_video)} result={assetUrl(workspace.id,motionRun.output_ids[0])} caption="Latest motion run · driving performance and result side by side"/>}
    {pickedOutputs.length>0&&<Toolbar><Button variant="secondary" onClick={()=>setSheetOpen(true)}>Contact sheet · {pickedOutputs.length}</Button><Button variant="ghost" onClick={()=>{setPicked({});setSheetOpen(false);}}>Clear</Button></Toolbar>}
    {feedAssetError&&<Notice priority={20} consequence title="Library couldn't be updated" details={feedAssetError}>The feed shows the last media it read.</Notice>}
    {feed?<>{feedView}{examples&&<ExampleTiles kind={examples} videoSources={examples==="video"?LIBRARY_EXAMPLE_VIDEOS:undefined}/>}</>:examples?<ExampleTiles kind={examples} leading={runTiles} leadingCount={shown.length} videoSources={examples==="video"&&promoReelForCapability(capabilityId)?[...new Set([...FEATURED_VIDEO_EXAMPLES,...SQUAREHEAD_EXAMPLE_VIDEOS,promoReelForCapability(capabilityId)!])]:undefined}/>:<ResultGrid count={shown.length} aspect={0} label="Project runs">{runTiles}</ResultGrid>}
    <Dialog wide open={authorized&&sheetOpen&&sheetItems.length>0} title="Selected results" onClose={()=>setSheetOpen(false)} footer={<Button variant="secondary" onClick={()=>setSheetOpen(false)}>Close</Button>}>
      <ContactSheet items={sheetItems} title={`Selected results · ${project.name}`} fileName={`selected-results-${project.id.slice(0,8)}.png`}/>
    </Dialog>
    <ConfirmDialog open={!!manual} title="Mark submission not accepted?" text="First verify that the worker or SDK proxy did not accept this submission. This closes the ledger record and discards reserved outputs; it does not stop an unknown external job." confirmLabel="Mark not accepted" busy={canceling===manual?.id} onCancel={()=>setManual(null)} onConfirm={()=>{const run=manual;setManual(null);if(run)void markFailed(run);}}/>
  </Block>;
}

export function TeamLibrary({screen,workspace,project,call,canEdit,authorized,version,user,titles,videoEditReady,onEditVideo}:{screen:LibraryScreen;workspace:Workspace;project:Project;call:Call;canEdit:boolean;authorized:boolean;version:number;user:User;titles?:RunTitles;videoEditReady:boolean;onEditVideo:(asset:Asset)=>void}){
  const [density]=useDensity();
  const [unavailable,setUnavailable]=useState<Set<string>>(()=>new Set()),[showUnavailable,setShowUnavailable]=useState(false),[previewRetry,setPreviewRetry]=useState(0);
  useEffect(()=>{setUnavailable(new Set());setShowUnavailable(false);},[workspace.id,project.id]);
  const [assets,setAssets]=useState<Asset[]>([]),[cursor,setCursor]=useState<string|null>(null),[error,setError]=useState(""),[pending,setPending]=useState<{file:File;src:string;kind:"image"|"video"|"audio";state:"uploading"|"failed"}|null>(null),[busy,setBusy]=useState(false),[update,setUpdate]=useState(0),[viewing,setViewing]=useState<Asset|null>(null),[deleting,setDeleting]=useState<Pick<Asset,"id"|"name">|null>(null),[deletingId,setDeletingId]=useState(""),[deleteError,setDeleteError]=useState(""),[pendingDeletion,setPendingDeletion]=useState<Pick<Asset,"id"|"name">|null>(null);
  useEffect(()=>{if(!authorized)return;let current=true;void call<AssetPage>(workspacePath(workspace.id,`assets?projectId=${project.id}`)).then(page=>{if(current){setAssets(page.items);setCursor(page.nextCursor);setPendingDeletion(page.pendingDeletion??null);setError("");}}).catch(e=>{if(current)setError((e as Error).message);});return()=>{current=false;};},[workspace.id,project.id,call,authorized,version,update]);
  /* Which run made each file, so a generated file offers Recreate like its run does. */
  const [madeBy,setMadeBy]=useState<Run[]>([]),recreateById=useRecreateById(call,workspace.id,setError);
  useEffect(()=>{if(!authorized)return;let current=true;void call<Run[]>(workspacePath(workspace.id,`runs?projectId=${project.id}`)).then(list=>{if(current)setMadeBy(list.filter(run=>run.state==="succeeded"));}).catch(()=>{});return()=>{current=false;};},[workspace.id,project.id,call,authorized,version,update]);
  const viewingRunId=viewing?producerRunId(viewing,madeBy):undefined;
  const [viewingRun,setViewingRun]=useState<Run|null>(null);
  useEffect(()=>{setViewingRun(null);if(!viewingRunId)return;let current=true;void call<Run>(workspacePath(workspace.id,`runs/${encodeURIComponent(viewingRunId)}`)).then(run=>{if(current)setViewingRun(run);}).catch(()=>{});return()=>{current=false;};},[viewingRunId,workspace.id,call]);
  const kindOf=(file:File)=>file.type.startsWith("video/")?"video" as const:file.type.startsWith("audio/")?"audio" as const:"image" as const;
  async function send(file:File){try{const form=new FormData();form.append("file",file);await call(workspacePath(workspace.id,`assets?projectId=${project.id}`),"POST",form);setPending(old=>{if(old)URL.revokeObjectURL(old.src);return null;});setUpdate(v=>v+1);}catch(e){setPending(old=>old?{...old,state:"failed"}:old);setError((e as Error).message);}}
  function pick(file:File|null){if(!file)return;setError("");setPending({file,src:URL.createObjectURL(file),kind:kindOf(file),state:"uploading"});void send(file);}
  function retry(){if(!pending)return;setError("");setPending({...pending,state:"uploading"});void send(pending.file);}
  function dismiss(){setPending(old=>{if(old)URL.revokeObjectURL(old.src);return null;});}
  async function more(){if(!cursor)return;setBusy(true);try{const page=await call<AssetPage>(workspacePath(workspace.id,`assets?projectId=${project.id}&cursor=${encodeURIComponent(cursor)}`));setAssets(old=>[...old,...page.items]);setCursor(page.nextCursor);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function removeAsset(){if(!deleting||!canEdit)return;setDeletingId(deleting.id);setDeleteError("");try{await call(workspacePath(workspace.id,`assets/${encodeURIComponent(deleting.id)}`),"DELETE");setAssets(old=>old.filter(asset=>asset.id!==deleting.id));if(viewing?.id===deleting.id)setViewing(null);setDeleting(null);setPendingDeletion(null);setUpdate(v=>v+1);}catch(e){setDeleteError((e as Error).message);}finally{setDeletingId("");}}
  const visibleAssets=newestMediaFirst(assets).filter(asset=>showUnavailable||!unavailable.has(asset.id));
  const viewableAssets=visibleAssets.filter(asset=>/^(image|video)\//.test(asset.content_type));
  return <><Block label="Project library">{canEdit&&pendingDeletion&&!deleting&&<Notice priority={25} title="Finish removing a file" actions={<Button onClick={()=>{setDeleteError("");setDeleting(pendingDeletion);}}>Finish removal</Button>}>Its stored copy still needs cleanup. Retry to complete the removal.</Notice>}{error&&<Notice priority={20} consequence title="Assets couldn't be read" actions={<Button variant="secondary" disabled={busy} onClick={()=>setUpdate(v=>v+1)}>Check again</Button>} details={error}>The library shows the last list it read; nothing was deleted. Checking again reads the project's files once more.</Notice>}<SectionHeader large title="Library"/>{screen.tab==="runs"?<TeamRuns {...{workspace,project,call,canEdit,authorized,version,user,titles}} linkedRunId={screen.linkedRunId}/>:<>
    
    {!!unavailable.size&&<Notice title="Some previews aren't available" actions={<><Button variant="secondary" onClick={()=>{setUnavailable(new Set());setShowUnavailable(false);setPreviewRetry(value=>value+1);}}>Try again</Button><Button variant="ghost" onClick={()=>setShowUnavailable(value=>!value)}>{showUnavailable?"Hide unavailable":"Show unavailable"}</Button></>}>The files haven't been deleted.</Notice>}
    {!assets.length&&!pending?(canEdit?null:<EmptyState stage icon={<ImageIcon size={18}/>} title="No shared media yet" text="Nothing has been shared with this project."/>)
    :<div className={`ds-grid cf-library-grid ${densityColumnsClass(density,assets.length+(pending?1:0)+(canEdit?1:0))}`}>
      {canEdit&&<UploadSlot tile label="Add media" hint="Image, video or audio" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/wav,audio/mpeg" kinds={["image","video","audio"]} disabled={pending?.state==="uploading"} onFile={pick}/>}
      {pending&&<UploadTile src={pending.src} kind={pending.kind} state={pending.state} onRetry={retry} onDismiss={dismiss}/>}
      {visibleAssets.map(asset=>{
        const image=asset.content_type.startsWith("image/"),video=asset.content_type.startsWith("video/"),model=asset.content_type==="model/gltf-binary",viewable=image||video||model,src=assetUrl(workspace.id,asset.id);
        const onUnavailable=()=>setUnavailable(old=>old.has(asset.id)?old:new Set([...old,asset.id]));
        return <MediaCard quiet dragAsset={{id:asset.id,url:src,contentType:asset.content_type}} key={asset.id} onRecreate={canEdit&&(image||video)?withRun(producerRunId(asset,madeBy),recreateById):undefined} media={image?<MediaPreview key={`${src}:${previewRetry}`} src={src} kind="image" lazy onUnavailable={onUnavailable}/>:video?<MediaPreview key={`${src}:${previewRetry}`} src={`${src}#t=0.1`} kind="video" alt={asset.name} onUnavailable={onUnavailable}/>:model?<Suspense fallback={<Meta>Loading model</Meta>}><ModelPreview url={src} standalone/></Suspense>:<audio controls preload="metadata" src={src}/>} viewLabel={`View ${asset.name}`} onView={viewable?()=>{if(model)location.hash=`3d/viewer/${asset.id}`;else setViewing(asset);}:undefined} info={<><span>{asset.name}</span><Meta parts={[asset.content_type,asset.media_type==="mask"?"Validated mask":asset.parent_id&&"New version"]}/></>} actions={<>
          {(viewable||asset.content_type.startsWith("audio/"))&&<IconButton label={`View ${asset.name}`} onClick={()=>{if(model)location.hash=`3d/viewer/${asset.id}`;else setViewing(asset);}}><Eye size={14}/></IconButton>}
          {model&&canEdit&&<><Button variant="ghost" onClick={()=>{location.hash=`3d/texture/${asset.id}`;}}>Texture</Button><Button variant="ghost" onClick={()=>{location.hash=`3d/mesh/${asset.id}`;}}>Mesh tools</Button></>}{image&&canEdit&&<Button variant="ghost" onClick={()=>{location.hash=`3d/image/auto/${asset.id}`;}}>Create 3D</Button>}{image&&canEdit&&<IconButton label={`Edit ${asset.name}`} onClick={()=>{location.hash=`imageedit/${asset.id}`;}}><Pencil size={14}/></IconButton>}
          {video&&canEdit&&videoEditReady&&<IconButton label={`Edit ${asset.name}`} onClick={()=>onEditVideo(asset)}><Pencil size={14}/></IconButton>}
          <LinkButton variant="secondary" aria-label={`Download ${asset.name}`} href={assetUrl(workspace.id,asset.id,true)}><Download size={14}/></LinkButton>
          {canEdit&&<IconButton label={`Delete ${asset.name}`} disabled={deletingId===asset.id} onClick={()=>{setDeleteError("");setDeleting(asset);}}><Trash2 size={14}/></IconButton>}
        </>}/>;
      })}
    </div>}
    {cursor&&<Button variant="secondary" disabled={busy} onClick={()=>void more()}>Load more</Button>}
    {/* An empty library starts with Add media as the first tile of the examples, never as a box above them. */}
    <ExampleTiles kind="video" videoSources={LIBRARY_EXAMPLE_VIDEOS} leading={!assets.length&&!pending&&canEdit?<UploadSlot tile label="Add media" hint="Image, video or audio" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/wav,audio/mpeg" kinds={["image","video","audio"]} onFile={pick}/>:undefined} leadingCount={!assets.length&&!pending&&canEdit?1:0}/>
    <ExampleTiles kind="image" imageSources={SQUAREHEAD_EXAMPLE_IMAGES}/>
  </>}</Block>
  <MediaViewer open={!!viewing&&!viewing.content_type.startsWith("audio/")} src={viewing?assetUrl(workspace.id,viewing.id):""} name={viewing?.name??""} mediaType={viewing?.content_type.startsWith("video/")?"video":"image"} onClose={()=>setViewing(null)} onNavigate={direction=>setViewing(current=>adjacentItem(viewableAssets,asset=>asset.id===current?.id,direction)??current)} onRecreate={canEdit?withRun(viewingRunId,recreateById):undefined} info={viewingRun?<MediaViewerInfo model={jobQueueTitle(viewingRun.capability_id,titles??{})} inputs={visibleRunInputs(workspace.id,viewingRun)} prompt={String(viewingRun.invocation?.controls?.prompt??"")} facts={Object.entries(viewingRun.invocation?.controls??{}).filter(([key,value])=>key!=="prompt"&&(typeof value==="string"||typeof value==="number"||typeof value==="boolean")).map(([key,value])=>({label:key.replaceAll("_"," "),value:String(value)}))} date={new Date(viewingRun.created_at).toLocaleString()}/>:undefined}/>
  <Dialog open={!!viewing&&viewing.content_type.startsWith("audio/")} title={viewing?.name??"Audio preview"} onClose={()=>setViewing(null)} footer={<Button variant="ghost" onClick={()=>setViewing(null)}>Close</Button>}>{viewing&&<Suspense fallback={null}><SpeechAudioPlayer key={viewing.id} workspace={workspace.id} asset={viewing}/></Suspense>}</Dialog>
  <ConfirmDialog open={!!deleting} title="Delete this file?" text={deleting?`${deleting.name} will be removed from your library. If a project still needs the file, its stored copy and references will be retained.`:""} confirmLabel={deleteError?"Retry deletion":"Delete file"} error={deleteError} busy={!!deletingId} onCancel={()=>setDeleting(null)} onConfirm={()=>void removeAsset()}/>
  </>;
}
