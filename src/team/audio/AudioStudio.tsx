import {lazy,Suspense,useEffect,useMemo,useRef,useState} from "react";
import {Block,Button,Collapsible,GenerateButton,LinkButton,MediaCard,Meta,Notice,Panel,PanelSection,Params,ResultSlot,StatusText,TextField,Toolbar} from "../../ds";
import {MicrophonePanel} from "./MicrophonePanel";
import {TeamChoice} from "../TeamChoice";
import {TeamMediaInput} from "../TeamMediaInput";
import {TrimToFit} from "../TrimToFit";
import {assetUrl,mergeAssets,workspacePath,type Asset,type AssetPage,type Call,type Project,type Workspace} from "../api";
import {audioDraftIssues,audioOperationActive,audioOperationLabels,buildAudioRequest,defaultAudioDraft,needsDurationPolicy,needsExternalAudio,needsSourceAudio,type AudioDraft,type AudioOperation,type AudioOperationKind,type AudioRequirements} from "./state";
import {ToolHero} from "../heroes";
import {ProductionContent} from "../ProductionWorkspace";
import {WorkflowDescription} from "../workflow-info";
import {ExampleTiles} from "../ExampleTiles";

const SystemVoicePanel=lazy(()=>import("./SystemVoicePanel").then(module=>({default:module.SystemVoicePanel})));

const tone=(state:string)=>state==="succeeded"?"ok" as const:state==="failed"||state==="canceled"?"warn" as const:audioOperationActive(state)?"active" as const:"idle" as const;
const choice=(value:string,label:string)=>({value,label});

export function AudioStudio({workspace,project,userId,call,requirements,onChanged,onLipSync}:{userId:string;workspace:Workspace;project:Project;call:Call;requirements:AudioRequirements;onChanged:()=>void;onLipSync?:(assetId:string,imageAssetId?:string)=>void}){
  const [assets,setAssets]=useState<Asset[]>([]),[draft,setDraft]=useState<AudioDraft>(defaultAudioDraft),[portraitAssetId,setPortraitAssetId]=useState(""),[operation,setOperation]=useState<AudioOperation|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[uploading,setUploading]=useState(""),[intentKey,setIntentKey]=useState("");
  const [trimming,setTrimming]=useState(false);
  const [assetCursor,setAssetCursor]=useState<string|null>(null),[loadingAssets,setLoadingAssets]=useState(false),[assetPageError,setAssetPageError]=useState("");
  const referenceRequest=useRef(0),voiceRequest=useRef(0);
  const loadEpoch=useRef(0),loadingAssetsRef=useRef(false),selection=useRef({project:project.id,video:"",voice:"",portrait:"",assets:[] as Asset[]});
  selection.current={project:project.id,video:draft.videoAssetId,voice:draft.audioAssetId,portrait:portraitAssetId,assets};
  const videos=useMemo(()=>assets.filter(asset=>asset.media_type==="video"),[assets]),images=useMemo(()=>assets.filter(asset=>asset.media_type==="image"),[assets]),audios=useMemo(()=>assets.filter(asset=>asset.media_type==="audio"),[assets]);
  const update=<K extends keyof AudioDraft>(key:K,value:AudioDraft[K])=>{setDraft(old=>({...old,[key]:value}));setIntentKey("");setError("");};
  const load=async()=>{
    const epoch=++loadEpoch.current;
    setAssetCursor(null);setAssetPageError("");
    const page=await call<AssetPage>(workspacePath(workspace.id,`assets?projectId=${encodeURIComponent(project.id)}`));
    const snapshot=selection.current;
    if(snapshot.project!==project.id||epoch!==loadEpoch.current)return;
    const ids=[...new Set([snapshot.video,snapshot.voice,snapshot.portrait].filter(id=>id&&!page.items.some(asset=>asset.id===id)))];
    const extra=await Promise.all(ids.map(id=>call<Asset>(workspacePath(workspace.id,`assets/${encodeURIComponent(id)}`))));
    if(epoch!==loadEpoch.current||selection.current.project!==project.id)return;
    const latest=selection.current;
    // A selection made while the metadata requests were in flight must survive this refresh.
    const currentIds=new Set([latest.video,latest.voice,latest.portrait]);
    const candidates=[...page.items,...extra.filter(asset=>asset.project_id===project.id),...latest.assets.filter(asset=>currentIds.has(asset.id)&&asset.project_id===project.id)];
    const merged=candidates.filter((asset,index)=>candidates.findIndex(other=>other.id===asset.id)===index);
    setAssets(merged);
    setAssetCursor(page.nextCursor);
    setDraft(old=>({...old,videoAssetId:merged.some(a=>a.id===old.videoAssetId&&a.media_type==="video")?old.videoAssetId:"",audioAssetId:merged.some(a=>a.id===old.audioAssetId&&a.media_type==="audio")?old.audioAssetId:""}));
    setPortraitAssetId(old=>merged.some(a=>a.id===old&&a.media_type==="image")?old:"");
  };
  async function moreAssets(){
    if(!assetCursor||loadingAssetsRef.current)return;
    const epoch=loadEpoch.current;loadingAssetsRef.current=true;setLoadingAssets(true);setAssetPageError("");
    try{const page=await call<AssetPage>(workspacePath(workspace.id,`assets?projectId=${encodeURIComponent(project.id)}&cursor=${encodeURIComponent(assetCursor)}`));if(epoch===loadEpoch.current){setAssets(old=>mergeAssets(old,page.items));setAssetCursor(page.nextCursor);}}
    catch{if(epoch===loadEpoch.current)setAssetPageError("Could not load more files. Try again.");}
    finally{loadingAssetsRef.current=false;setLoadingAssets(false);}
  }
  useEffect(()=>{let current=true;void load().catch(e=>{if(current)setError((e as Error).message);});return()=>{current=false;loadEpoch.current++;referenceRequest.current++;voiceRequest.current++;};},[workspace.id,project.id]);
  useEffect(()=>{if(!operation||!audioOperationActive(operation.state))return;let current=true,timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const next=await call<AudioOperation>(workspacePath(workspace.id,`audio-operations/${operation.id}`));if(!current)return;setOperation(next);if(audioOperationActive(next.state))timer=setTimeout(poll,1500);else if(next.state==="succeeded"){await load();onChanged();}}catch(e){if(current)setError((e as Error).message);}};timer=setTimeout(poll,700);return()=>{current=false;clearTimeout(timer);};},[operation?.id,operation?.state,workspace.id,project.id]);
  async function submit(){if(!canSubmit)return;const key=intentKey||crypto.randomUUID();setIntentKey(key);setBusy(true);setError("");try{const created=await call<AudioOperation>(workspacePath(workspace.id,"audio-operations"),"POST",buildAudioRequest(draft,assets,project.id,key));setOperation(created);setIntentKey("");}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function upload(file:File,role:"reference"|"audio"){
    if(role==="reference")referenceRequest.current++;
    else voiceRequest.current++;
    const valid=role==="audio"?file.type.startsWith("audio/"):file.type.startsWith("image/")||file.type.startsWith("video/");
    if(!valid){setError(role==="audio"?"Choose an audio file.":"Choose a video or portrait image.");return;}
    setUploading(role);setError("");
    try{const form=new FormData();form.append("file",file);const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${project.id}`),"POST",form);setAssets(old=>[asset,...old.filter(item=>item.id!==asset.id)]);if(role==="audio"){if(asset.media_type!=="audio")throw new Error("Choose an audio file.");update("audioAssetId",asset.id);}else if(asset.media_type==="video"){setPortraitAssetId("");update("videoAssetId",asset.id);}else if(asset.media_type==="image"){update("videoAssetId","");setPortraitAssetId(asset.id);}else throw new Error("Choose a video or portrait image.");onChanged();}
    catch(e){setError((e as Error).message);}finally{setUploading("");}
  }
  async function cancel(){if(!operation||!audioOperationActive(operation.state))return;try{const result=await call<{state:string}>(workspacePath(workspace.id,`audio-operations/${operation.id}/cancel`),"POST");setOperation({...operation,state:result.state});}catch(e){setError((e as Error).message);}}
  const selectedVideo=videos.find(asset=>asset.id===draft.videoAssetId),selectedPortrait=images.find(asset=>asset.id===portraitAssetId),selectedReference=selectedPortrait??selectedVideo,selectedAudio=audios.find(asset=>asset.id===draft.audioAssetId),kind=draft.operation,portraitMode=!!selectedPortrait;
  const issues=portraitMode?(!onLipSync?["A ready local lip-sync workflow is required."]:!selectedAudio?["Record, create or choose a voice take."]:[]):audioDraftIssues(draft,assets);
  const working=busy||!!operation&&audioOperationActive(operation.state);
  const canSubmit=workspace.role!=="viewer"&&!working&&!uploading&&issues.length===0;
  async function chooseReference(id:string){
    const request=++referenceRequest.current;
    setError("");
    if(!id){setPortraitAssetId("");update("videoAssetId","");return;}
    try{
      const chosen=assets.find(asset=>asset.id===id)??await call<Asset>(workspacePath(workspace.id,`assets/${encodeURIComponent(id)}`));
      if(request!==referenceRequest.current)return;
      if(chosen.project_id!==project.id||!(chosen.media_type==="image"||chosen.media_type==="video"))throw new Error("Choose an image or video from this project.");
      setAssets(old=>[chosen,...old.filter(asset=>asset.id!==chosen.id)]);
      if(chosen.media_type==="image"){update("videoAssetId","");setPortraitAssetId(id);}else{setPortraitAssetId("");update("videoAssetId",id);}
    }catch(e){if(request===referenceRequest.current)setError((e as Error).message);}
  }
  async function chooseVoice(id:string){
    const request=++voiceRequest.current;
    setError("");
    if(!id){update("audioAssetId","");return;}
    try{
      const chosen=assets.find(asset=>asset.id===id)??await call<Asset>(workspacePath(workspace.id,`assets/${encodeURIComponent(id)}`));
      if(request!==voiceRequest.current)return;
      if(chosen.project_id!==project.id||chosen.media_type!=="audio")throw new Error("Choose an audio file from this project.");
      setAssets(old=>[chosen,...old.filter(asset=>asset.id!==chosen.id)]);
      update("audioAssetId",id);
    }catch(e){if(request===voiceRequest.current)setError((e as Error).message);}
  }
  function runPrimary(){if(!canSubmit)return;if(portraitMode&&onLipSync&&selectedAudio){onLipSync(selectedAudio.id,selectedPortrait.id);return;}void submit();}
  return <><WorkflowDescription title="Audio"><Meta>Record, create or choose a voice take. Pair it with a video to process its sound, or with a portrait to open the existing local lip-sync workflow.</Meta><Meta>Advanced settings contain stream selection, timeline fitting and gain. Preserve keeps the source sound; replace, mix and extract reveal only the inputs they need.</Meta><Meta>Chatterbox uses its built-in local voice; other choices are installed Windows speech voices. Delivery changes expression or speed. No voice is cloned and no paid speech service is used.</Meta><Meta parts={["Microphone takes stay local until you save them", "The video timeline stays fixed",requirements.versions.ffmpeg?.split(/\s+/).slice(0,3).join(" ")]}/></WorkflowDescription><div className="cf-production">
    <Panel footer={<><GenerateButton busy={working} aria-disabled={!canSubmit} onClick={runPrimary} label={working?"Generating":portraitMode?"Create lip-sync":"Process audio"}/>{issues[0]&&<Meta>{issues[0]}</Meta>}</>}>
      <MicrophonePanel workspace={workspace} project={project} call={call} secondaryAction={<Suspense fallback={null}><SystemVoicePanel key={`${userId}:${workspace.id}:${project.id}`} workspace={workspace} project={project} userId={userId} call={call} onSaved={id=>{voiceRequest.current++;void load().then(()=>setDraft(old=>({...old,audioAssetId:id,operation:"replace"}))).catch(e=>setError((e as Error).message));onChanged();}}/></Suspense>} onSaved={id=>{voiceRequest.current++;void load().then(()=>setDraft(old=>({...old,audioAssetId:id,operation:"replace"}))).catch(e=>setError((e as Error).message));onChanged();}}/>
      <PanelSection label="Reference"><TeamMediaInput projectId={project.id} onLoadMore={assetCursor?()=>void moreAssets():undefined} loadingMore={loadingAssets} loadMoreError={assetPageError} workspace={workspace.id} label="Video or portrait reference" type={selectedReference?.media_type==="video"?"video":"image"} representation={selectedReference?.media_type==="video"?"video":"image"} accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime" hint="Drop a video or portrait here" file={null} selected={selectedReference} options={[...videos,...images]} uploading={uploading==="reference"?"Uploading…":undefined} disabled={working||!!uploading} canUpload={workspace.role!=="viewer"} onFile={file=>{if(file)void upload(file,"reference");else chooseReference("");}} onSelect={chooseReference} onUpload={()=>{}} onTrim={selectedVideo&&draft.videoStreamIndex==="0"&&draft.sourceAudioStreamIndex==="0"?()=>setTrimming(true):undefined}/>{selectedVideo&&<TrimToFit workspace={workspace} project={project} call={call} assetId={selectedVideo.id} open={trimming} onClose={()=>setTrimming(false)} onTrimmed={id=>{setUploading("reference");void call<Asset>(workspacePath(workspace.id,`assets/${encodeURIComponent(id)}`)).then(asset=>{setAssets(old=>[asset,...old.filter(item=>item.id!==asset.id)]);setPortraitAssetId("");update("videoAssetId",asset.id);onChanged();}).catch(e=>setError((e as Error).message)).finally(()=>setUploading(""));}}/>}</PanelSection>
      <PanelSection label="Voice"><TeamMediaInput projectId={project.id} onLoadMore={assetCursor?()=>void moreAssets():undefined} loadingMore={loadingAssets} loadMoreError={assetPageError} workspace={workspace.id} label="Voice or audio" type="audio" accept="audio/wav,audio/x-wav,audio/mpeg" hint="Drop audio here or record a voice above" file={null} selected={selectedAudio} options={audios} uploading={uploading==="audio"?"Uploading…":undefined} disabled={working} canUpload={workspace.role!=="viewer"} onFile={file=>{if(file)void upload(file,"audio");else void chooseVoice("");}} onSelect={id=>void chooseVoice(id)} onUpload={()=>{}}/></PanelSection>
      {!portraitMode&&<><PanelSection label="Operation"><TeamChoice label="Operation" display={audioOperationLabels[kind]} value={kind} onChange={value=>update("operation",value as AudioOperationKind)} options={(Object.keys(audioOperationLabels) as AudioOperationKind[]).map(value=>choice(value,audioOperationLabels[value]))}/></PanelSection>
      <Collapsible title="Advanced settings"><TextField type="number" min="0" step="1" label="Video stream" value={draft.videoStreamIndex} onChange={value=>update("videoStreamIndex",value)}/>{needsSourceAudio(kind)&&<TextField type="number" min="0" step="1" label="Source audio stream" value={draft.sourceAudioStreamIndex} onChange={value=>update("sourceAudioStreamIndex",value)}/>} {needsExternalAudio(kind)&&<><TextField type="number" min="0" step="1" label="Audio stream" value={draft.audioStreamIndex} onChange={value=>update("audioStreamIndex",value)}/><Params><TextField type="number" min="0" step="0.01" label="Offset (seconds)" value={draft.offsetSeconds} onChange={value=>update("offsetSeconds",value)}/><TextField type="number" min="0" step="0.01" label="Trim start" value={draft.audioStartSeconds} onChange={value=>update("audioStartSeconds",value)}/><TextField type="number" min="0" step="0.01" label="Trim end (optional)" value={draft.audioEndSeconds} onChange={value=>update("audioEndSeconds",value)}/></Params></>}{needsDurationPolicy(kind)&&<PanelSection label="Timeline fit"><TeamChoice label="Short audio" display={draft.shortAudio==="pad_silence"?"Pad with silence":"Reject"} value={draft.shortAudio} onChange={value=>update("shortAudio",value as AudioDraft["shortAudio"])} options={[choice("pad_silence","Pad with silence"),choice("reject","Reject")]}/><TeamChoice label="Long audio" display={draft.longAudio==="trim"?"Trim at video end":"Reject"} value={draft.longAudio} onChange={value=>update("longAudio",value as AudioDraft["longAudio"])} options={[choice("trim","Trim at video end"),choice("reject","Reject")]}/></PanelSection>}{(kind==="preserve"||kind==="mix"||needsExternalAudio(kind))&&<PanelSection label="Mix"><Params>{(kind==="preserve"||kind==="mix")&&<TextField type="number" min="-60" max="24" step="0.1" label="Source gain (dB)" value={draft.sourceGainDb} onChange={value=>update("sourceGainDb",value)}/>} {needsExternalAudio(kind)&&<TextField type="number" min="-60" max="24" step="0.1" label="External gain (dB)" value={draft.audioGainDb} onChange={value=>update("audioGainDb",value)}/>}</Params></PanelSection>}</Collapsible></>}
    </Panel>
    <ProductionContent><ToolHero kind="voice"/>{(error||operation)&&<Block label="Audio result">{error&&<Notice priority={60} title="The audio operation didn't start" actions={<>{canSubmit
      ?<Button variant="secondary" disabled={busy} onClick={()=>void submit()}>Try again</Button>
      :<Button variant="secondary" disabled={busy} onClick={()=>void load().catch(e=>setError((e as Error).message))}>Reload the project files</Button>}</>} details={error}>Nothing was written. {canSubmit?"Trying again reuses the same request and settings.":"Reloading reads this project's video and audio once more."}</Notice>}{operation&&<>{operation.state==="succeeded"?<MediaCard media={operation.operation==="extract"?<audio controls preload="metadata" src={assetUrl(workspace.id,operation.output_asset_id)}/>:<video controls preload="metadata" src={assetUrl(workspace.id,operation.output_asset_id)}/>} title={audioOperationLabels[operation.operation]} meta={<StatusText tone="ok">Succeeded</StatusText>} actions={<LinkButton variant="secondary" href={assetUrl(workspace.id,operation.output_asset_id,true)}>Download</LinkButton>}/>:<ResultSlot status={<StatusText tone={tone(operation.state)}>{operation.state.replaceAll("_"," ")}</StatusText>}>{operation.error??"The server owns this job; leaving this page will not cancel it."}</ResultSlot>}{audioOperationActive(operation.state)&&<Toolbar><Button variant="secondary" onClick={()=>void cancel()}>Cancel</Button><Meta>{operation.id}</Meta></Toolbar>}</>}</Block>}
    <ExampleTiles kind="video"/>
  </ProductionContent></div></>;
}
