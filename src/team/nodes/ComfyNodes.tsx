import { useEffect,useRef,useState } from "react";
import { RefreshCw } from "lucide-react";
import { Thumb, ThumbGrid, Button, Canvas, Collapsible, IconButton, Steps, DataRow, Dialog, EmptyState, InfoButton, LinkButton, Meta, Notice, SearchField, SectionHeader, SegmentedTabs, StatusText, TextField, UploadSlot, Working } from "../../ds";
import type { Worker, Workspace } from "../api";
import type {CapabilityManifestV2} from "../../capabilities/types";
import {request,workspacePath} from "../api";
import {plainProblem} from "../problems";
import "./comfy-nodes.css";
import type {NodesScreen} from "../navigation";
import type {ThreeDTool} from "../three-d/tools";

type SavedWorkflow = {
  id: string;
  slug: string;
  label: string;
  revision_id: string;
  version: number;
  published: boolean;
  published_revision_id: string | null;
  source_name: string;
};
type Mapping = {
  source: { name: string; nodes: number; outputs: number };
  inputs: Array<{ port: string; nodeType: string; field: string }>;
  controls: Array<{ control: string; nodeType: string; field: string }>;
  outputs: Array<{ port: string; nodeType: string; media: "image" | "video" }>;
  dependencies: Array<{ kind: "node" | "model"; name: string; location?: string }>;
  fixed?: Array<{ control: string; nodes: string[]; reason: string }>;
};
type Readiness = { nodes: number; missingNodes: Array<{ class: string; count: number }>; models: Array<{ name: string; present: boolean; url?: string }>; state: "ready" | "partial" | "missing" };
type HubCheck = { source: { name: string; url?: string; sha256: string }; readiness: Readiness; mapping?: Mapping; manifest?: { title: string }; errors: Array<{ node?: string; class?: string; reason: string }> };
type ImportMode = "templates" | "comfy" | "hub" | "file";
type ComfyTemplate = { name: string; title: string; description: string; group: string; mediaType: string; api: boolean; models: string[]; url: string; runsOn: Array<"local"|"cloud">; customNodes: string[] };
const CLOUD_ORIGIN = "https://cloud.comfy.org";
type FeatureResult = { applied: boolean; errors?: string[]; workflowId?: string; revisionId?: string; version?: number; changes: { added: string[]; removed: string[]; changed: string[] } };
/** The editor address: a feature's graph or a run's graph opens in the same frame. */
export const editorSource = (url: string, options: { version: number; tool?: ThreeDTool; feature?: string | null; run?: string | null }) =>
  `${url}?v=${options.version}${options.tool ? `&studio3d=${options.tool}` : ""}${options.feature ? `&comfyfield_feature=${encodeURIComponent(options.feature)}` : ""}${options.run ? `&comfyfield_run=${encodeURIComponent(options.run)}` : ""}`;
const featureOf = (slug: string) => (slug.startsWith("feature-") ? slug.slice("feature-".length) : null);
const READINESS_LABEL: Record<Readiness["state"], string> = { ready: "Ready", partial: "Partial: model files missing", missing: "Missing: node classes not installed" };

/** The starters are existing local workflows, not extra copies of their graphs. */
export function nodeStarters(catalogue:CapabilityManifestV2[],query:string){
  const text=query.trim().toLocaleLowerCase();
  return catalogue.filter(item=>/^(flux2-klein|qwen-image-21|fibo2|h3-|minimax-h3|openjutsu-h3|previs-to-video)/.test(item.id)&&item.coverage.local==="implemented"&&(!text||`${item.title} ${item.description} ${item.id}`.toLocaleLowerCase().includes(text))).sort((a,b)=>a.title.localeCompare(b.title));
}

/** The official editor uses a separate origin so extension scripts cannot read app APIs. */
export function ComfyNodes({ workspace, workers, catalogue=[], tool, screen, canEdit = false, serverOffline = false, canStartLocal = false, onChanged, onWorkerSettings }: { workspace: Workspace; workers: Worker[]; catalogue?:CapabilityManifestV2[]; tool?: ThreeDTool; screen?: NodesScreen; canEdit?: boolean; serverOffline?: boolean; canStartLocal?: boolean; onChanged?: () => void | Promise<void>; /** Where a person registers or checks a worker. Every offline state leads here, so it is required. */ onWorkerSettings: () => void }) {
  const importOnly=screen?.target==="cloud";
  const entry=screen?.target==="local"?screen.entry:undefined;
  const feature=entry?.kind==="feature"?entry.id:undefined;
  const run=entry?.kind==="run"?entry.id:undefined;
  // The editor proxy prefers an online local worker; don't let an earlier offline
  // entry hide the editor when another enabled worker is available.
  const worker = workers.find(candidate => candidate.enabled && candidate.inventory?.online === true)
    ?? workers.find(candidate => candidate.enabled);
  const [version, setVersion] = useState(0);
  const [starterQuery,setStarterQuery]=useState("");
  const [workerAction,setWorkerAction]=useState<"start"|"probe"|"">("");
  const [launchRequested,setLaunchRequested]=useState(false);
  const [workerError,setWorkerError]=useState("");
  /* Which worker action failed: the problem bar's "Try again" repeats that one. */
  const [workerRetry,setWorkerRetry]=useState<"start"|"probe"|"">("");
  const [workerConfirmedOnline,setWorkerConfirmedOnline]=useState(false);
  /* The editor takes a moment to start; the loader covers the frame until it has loaded. */
  const [loaded, setLoaded] = useState(false);
  const [target,setTarget]=useState<{workspaceId:string;url:string}|null>(null);
  const [error,setError]=useState("");
  const [sources,setSources]=useState<string[]>([]);
  const [saved,setSaved]=useState<SavedWorkflow[]>([]);
  const [shelfOpen,setShelfOpen]=useState(false);
  const [sourceName,setSourceName]=useState("");
  const [label,setLabel]=useState("");
  const [preview,setPreview]=useState<Mapping|null>(null);
  const [shelfError,setShelfError]=useState("");
  const [shelfNotice,setShelfNotice]=useState("");
  const [shelfBusy,setShelfBusy]=useState("");
  const [mode,setMode]=useState<ImportMode>("templates");
  /* The official Comfy templates: browse, pick one, and it is checked against this worker before it is saved. */
  /* Where an import is checked and later runs: this computer or Comfy Cloud, when both are set up. */
  const importTargets=workers.filter(w=>w.enabled),[importWorkerId,setImportWorkerId]=useState("");
  const importWorker=importTargets.find(w=>w.id===importWorkerId)??worker;
  const importCloud=importWorker?.origin===CLOUD_ORIGIN;
  /* Only templates that can run on the chosen target: offered there by Comfy, and needing no extra node packs. */
  const runnable=(t:ComfyTemplate)=>(!t.runsOn.length||t.runsOn.includes(importCloud?"cloud":"local"))&&!t.customNodes.length;
  const [templates,setTemplates]=useState<ComfyTemplate[]>([]),[templateQuery,setTemplateQuery]=useState(""),[templateGroup,setTemplateGroup]=useState("All"),[templatePick,setTemplatePick]=useState<ComfyTemplate|null>(null);
  const [hubUrl,setHubUrl]=useState("");
  const [file,setFile]=useState<{name:string;json:string}|null>(null);
  const [check,setCheck]=useState<HubCheck|null>(null);
  const [featureResult,setFeatureResult]=useState<FeatureResult|null>(null);
  const [runError,setRunError]=useState("");
  const [runNotice,setRunNotice]=useState("");
  const [runEditingAvailable,setRunEditingAvailable]=useState(false);
  const frameRef=useRef<HTMLIFrameElement>(null);
  const runAttempt=useRef<{run:string;json:string;key:string}|null>(null);
  useEffect(()=>{
    setLoaded(false);
    setFeatureResult(null);
    setRunError("");
    setRunNotice("");
    runAttempt.current=null;
  },[feature,run]);
  useEffect(()=>{
    setRunEditingAvailable(false);
    if(!run||!canEdit)return;
    const controller=new AbortController();
    request<{available:boolean}>(workspacePath(workspace.id,`runs/${encodeURIComponent(run)}/edited`),"GET",undefined,controller.signal)
      .then(result=>setRunEditingAvailable(result.available===true)).catch(()=>{});
    return()=>controller.abort();
  },[workspace.id,run,canEdit]);
  const showShelf=!tool||tool==="workflows";
  const shelfPath=workspacePath(workspace.id,"workflow-imports");

  async function loadShelf(){
    try{
      const list=await request<SavedWorkflow[]>(shelfPath);
      setSaved(list.map(item=>({...item,published_revision_id:item.published_revision_id??(item.published?item.revision_id:null)})));
      if(canEdit){
        const result=await request<{names:string[]}>(`${shelfPath}/sources${importWorker?`?workerId=${encodeURIComponent(importWorker.id)}`:""}`);
        setSources(result.names);
      }
    }catch(cause){setShelfError((cause as Error).message);}
  }
  useEffect(()=>{if(showShelf&&!serverOffline)void loadShelf();},[workspace.id,importWorker?.id,canEdit,showShelf,serverOffline]);
  useEffect(()=>{if(!shelfOpen||mode!=="templates"||templates.length)return;void request<ComfyTemplate[]>(`${shelfPath}/templates`).then(setTemplates).catch(cause=>setShelfError((cause as Error).message));},[shelfOpen,mode,templates.length,shelfPath]);

  /** The chosen source as the import API expects it: a saved name, a Hub address or the file's text. */
  const sourceBody=mode==="templates"?(templatePick?{name:templatePick.url}:null):mode==="comfy"?(sourceName?{name:sourceName}:null):mode==="hub"?(hubUrl.trim()?{name:hubUrl.trim()}:null):(file?{json:file.json}:null);
  async function checkSource(){
    if(!sourceBody)return;
    setShelfBusy("preview");setShelfError("");setShelfNotice("");setCheck(null);setPreview(null);
    try{
      const result=await request<HubCheck>(`${shelfPath}/hub-check`,"POST",{...sourceBody,...(importWorker?{workerId:importWorker.id}:{})});
      setCheck(result);setPreview(result.mapping??null);
      if(!label&&result.manifest)setLabel(result.manifest.title);
    }catch(cause){setShelfError((cause as Error).message);}
    finally{setShelfBusy("");}
  }
  async function previewSource(){
    if(mode!=="comfy"){await checkSource();return;}
    if(!sourceName)return;
    setShelfBusy("preview");setShelfError("");setShelfNotice("");
    try{
      const result=await request<{manifest:{title:string};mapping:Mapping}>(`${shelfPath}/preview`,"POST",{name:sourceName,...(importWorker?{workerId:importWorker.id}:{})});
      setPreview(result.mapping);
      if(!label)setLabel(result.manifest.title);
    }catch(cause){setPreview(null);setShelfError((cause as Error).message);}
    finally{setShelfBusy("");}
  }
  async function importSource(){
    if(!sourceBody||!label||!preview)return;
    setShelfBusy("import");setShelfError("");setShelfNotice("");
    try{
      const publish=mode==="templates"&&check?.readiness.state==="ready";
      await request(shelfPath,"POST",{...sourceBody,label,...(publish?{published:true}:{}),...(importWorker?{workerId:importWorker.id}:{})});
      setShelfOpen(false);setPreview(null);setCheck(null);setSourceName("");setHubUrl("");setFile(null);setLabel("");
      setShelfNotice(publish?"Added. It is in the Video, Image or 3D menu under its function now.":"Workflow saved as a draft. Publish it to show it in the Video or Image menu.");setTemplatePick(null);
      await loadShelf();
    }catch(cause){setShelfError((cause as Error).message);}
    finally{setShelfBusy("");}
  }
  /** Bring the edits saved in the node editor back into the feature, checked against what its screen needs. */
  async function applyFeature(capabilityId:string){
    setShelfBusy("feature");setShelfError("");setShelfNotice("");setFeatureResult(null);
    try{
      const result=await request<FeatureResult>(`${shelfPath}/feature-edit`,"POST",{capabilityId,...(worker?{workerId:worker.id}:{})});
      setFeatureResult(result);if(result.applied)await loadShelf();
    }catch(cause){setShelfError((cause as Error).message);}
    finally{setShelfBusy("");}
  }
  async function editorGraph(identity:string):Promise<unknown>{
    const frame=frameRef.current?.contentWindow;
    if(!frame||!src)throw new Error("The node editor is not ready yet.");
    const origin=new URL(src,location.href).origin, id=crypto.randomUUID();
    return new Promise<unknown>((resolve,reject)=>{
      const timeout=window.setTimeout(()=>{window.removeEventListener("message",receive);reject(new Error("The node editor did not answer. Wait for it to finish loading and try again."));},10000);
      function receive(event:MessageEvent){
        if(event.origin!==origin||event.source!==frame||event.data?.type!=="comfyfield:feature-export"||event.data.id!==id)return;
        window.clearTimeout(timeout);window.removeEventListener("message",receive);
        if(event.data.error)reject(new Error(String(event.data.error)));else resolve(event.data.workflow);
      }
      window.addEventListener("message",receive);
      frame.postMessage({type:"comfyfield:export-feature",id,feature:identity},origin);
    });
  }
  async function saveFeature(capabilityId:string){
    setShelfBusy("feature");setShelfError("");setShelfNotice("");setFeatureResult(null);
    try{
      const workflow=await editorGraph(capabilityId);
      const result=await request<FeatureResult>(`${shelfPath}/feature-edit`,"POST",{capabilityId,json:JSON.stringify(workflow),...(worker?{workerId:worker.id}:{})});
      setFeatureResult(result);
      if(result.applied){setShelfNotice("Your version is saved and active. Restore the original from Your workflows.");await loadShelf();}
    }catch(cause){setShelfError((cause as Error).message);}
    finally{setShelfBusy("");}
  }
  async function runEditedGraph(runId:string){
    setShelfBusy("run");setRunError("");setRunNotice("");
    try{
      const json=JSON.stringify(await editorGraph(runId));
      if(!runAttempt.current||runAttempt.current.run!==runId||runAttempt.current.json!==json)runAttempt.current={run:runId,json,key:crypto.randomUUID()};
      await request(workspacePath(workspace.id,`runs/${encodeURIComponent(runId)}/edited`),"POST",{json,idempotencyKey:runAttempt.current.key});
      runAttempt.current=null;
      setRunNotice("Your edited graph was added to the render queue.");
      void Promise.resolve().then(()=>onChanged?.()).catch(()=>{});
    }catch(cause){setRunError((cause as Error).message);}
    finally{setShelfBusy("");}
  }
  async function publish(item:SavedWorkflow,published:boolean){
    setShelfBusy(item.id);setShelfError("");setShelfNotice("");
    try{
      await request(`${shelfPath}/${item.id}/${published?"unpublish":"publish"}`,"POST",published?{}:{revisionId:item.revision_id});
      await loadShelf();
    }catch(cause){setShelfError((cause as Error).message);}
    finally{setShelfBusy("");}
  }
  async function reimport(item:SavedWorkflow){
    setShelfBusy(item.id);setShelfError("");setShelfNotice("");
    try{
      await request(`${shelfPath}/${item.id}/reimport`,"POST",worker?{workerId:worker.id}:{});
      setShelfNotice(`A new immutable revision of ${item.label} was imported as a draft.`);
      await loadShelf();
    }catch(cause){setShelfError((cause as Error).message);}
    finally{setShelfBusy("");}
  }
  useEffect(()=>{
    if(importOnly||serverOffline)return;
    const controller=new AbortController();setError("");
    request<{url:string}>(workspacePath(workspace.id,"node-editor"),"GET",undefined,controller.signal)
      .then(result=>{setTarget({workspaceId:workspace.id,url:result.url});setLoaded(false);})
      .catch(error=>{if(!controller.signal.aborted)setError((error as Error).message);});
    return()=>controller.abort();
  },[workspace.id,version,serverOffline,importOnly]);
  const src=target?.workspaceId===workspace.id?editorSource(target.url,{version,tool,feature,run}):undefined;

  /* The offline state waits for the worker on its own: it asks again with a backoff and hands
     over to the editor the moment ComfyUI answers, so nobody reloads the page (rule 36). */
  const changedRef=useRef(onChanged);
  useEffect(()=>{changedRef.current=onChanged;},[onChanged]);
  const workerId=worker?.id;
  const waitingForWorker=!serverOffline&&!!workerId&&worker?.inventory?.online===false&&!workerConfirmedOnline;
  useEffect(()=>{
    if(!waitingForWorker||!workerId)return;
    let alive=true;let timer:ReturnType<typeof setTimeout>|undefined;let delay=4000;
    const askAgain=async()=>{
      if(!alive)return;
      try{
        const result=await request<{inventory:{online?:boolean}}>(workspacePath(workspace.id,`workers/${encodeURIComponent(workerId)}/probe`),"POST");
        if(!alive)return;
        if(result.inventory.online){setWorkerConfirmedOnline(true);setWorkerError("");setWorkerRetry("");setVersion(value=>value+1);}
        await changedRef.current?.();
      }catch{/* A probe this person may not run keeps the state and simply backs off. */}
      delay=Math.min(Math.round(delay*1.6),30000);
      if(alive)timer=setTimeout(()=>void askAgain(),delay);
    };
    timer=setTimeout(()=>void askAgain(),delay);
    return()=>{alive=false;if(timer)clearTimeout(timer);};
  },[waitingForWorker,workerId,workspace.id]);

  async function startWorker(){
    if(!worker)return;
    setWorkerAction("start");setWorkerError("");setWorkerRetry("");
    try{await request(workspacePath(workspace.id,`workers/${worker.id}/start`),"POST");setLaunchRequested(true);await changedRef.current?.();}
    catch(cause){setWorkerRetry("start");setWorkerError((cause as Error).message);}
    finally{setWorkerAction("");}
  }
  async function checkWorker(){
    if(!worker)return;
    setWorkerAction("probe");setWorkerError("");setWorkerRetry("");
    try{
      const result=await request<{inventory:{online?:boolean}}>(workspacePath(workspace.id,`workers/${worker.id}/probe`),"POST");
      if(result.inventory.online){setWorkerConfirmedOnline(true);setVersion(value=>value+1);}
      await changedRef.current?.();
    }
    catch(cause){setWorkerRetry("probe");setWorkerError((cause as Error).message);}
    finally{setWorkerAction("");}
  }

  /* Every not-ready state carries the one action that fixes it, in the order the person can act
     on it: start here, then the worker's own settings, then registering a worker (rule 36, 26). */
  const workerStartable=!!(canStartLocal||worker?.can_start);
  const retryWorker=()=>void(workerRetry==="probe"||!workerStartable?checkWorker():startWorker());
  const retryConnection=()=>{if(onChanged)void onChanged();else location.reload();};

  /* Online without a Comfy Cloud sign-in there is nowhere to check or run an import, so nothing to offer but the sign-in. */
  if(importOnly&&!worker)return <EmptyState stage title="Sign in to Comfy Cloud" text="Your Comfy Cloud account checks and runs the workflows you import. Sign in with your Comfy key." action={onWorkerSettings?<Button variant="secondary" onClick={onWorkerSettings}>Sign in</Button>:undefined}/>;
  if(!importOnly&&serverOffline)return <EmptyState stage title="CreativeField is offline" text="Reconnect to the team server to keep working on the node editor." action={<Button variant="secondary" onClick={retryConnection}>Retry connection</Button>}/>;
  if (!importOnly&&(!worker || (worker.inventory?.online === false&&!workerConfirmedOnline))) {
    /* A failed start or check is the same cause as the offline state, so it is said once, with the
       same action that clears it (rule 36, rule 42). */
    const fallback=!worker
      ? <Button variant="secondary" onClick={onWorkerSettings}>Add a worker</Button>
      : launchRequested
        ? <Button variant="secondary" disabled={!!workerAction} onClick={()=>void checkWorker()}>{workerAction==="probe"?"Checking…":"Check again"}</Button>
        : workerStartable
          ? <Button variant="secondary" disabled={!!workerAction} onClick={()=>void startWorker()}>{workerAction==="start"?"Starting…":"Start ComfyUI"}</Button>
          : <Button variant="secondary" onClick={onWorkerSettings}>Open worker settings</Button>;
    const action=workerError?<Button variant="secondary" disabled={!!workerAction} onClick={retryWorker}>Try again</Button>:fallback;
    const title=!worker?"No ComfyUI worker":launchRequested?"ComfyUI is starting":"ComfyUI is offline";
    const text=!worker
      ? "Add a ComfyUI worker to open its node editor here."
      : launchRequested
        ? "The local launcher is running. The editor opens here by itself as soon as ComfyUI has finished loading."
        : workerStartable
          ? "ComfyUI is not answering. Start it on this computer to open its node editor here."
          : "ComfyUI is not answering. Open worker settings to check its address.";
    return <EmptyState stage title={title} text={workerError?`${plainProblem(workerError).text} ${text}`:text} action={action}/>;
  }
  if(!importOnly&&error)return <EmptyState stage title="Node editor unavailable" text={`${plainProblem(error).text} Trying again reloads the editor.`} action={<Button variant="secondary" onClick={()=>setVersion(value=>value+1)}>Try again</Button>}/>;

  return <div className="cf-nodes">
    <Canvas workspace
      toolbarStart={tool ? undefined : <SectionHeader large title={importOnly?"Your workflows":"Node editor"} />}
      toolbarEnd={importOnly?undefined:<>
        <IconButton label="Reload the editor" onClick={() => { setLoaded(false); setVersion(value => value + 1); }}><RefreshCw size={14} /></IconButton>
        {src&&<LinkButton variant="secondary" href={src} target="_blank" rel="noopener noreferrer">Open in a new tab</LinkButton>}
      </>}
    >
      {feature&&canEdit&&<div className="cf-nodes__shelf">
        <div className="cf-nodes__shelf-head">
          <SectionHeader title={`Edit the ${feature} app`} />
        </div>
        <Steps items={[{ title: "Change the graph", text: "in the editor below" }, { title: "Save your version", text: "We check the app inputs and outputs before using it", action: <Button disabled={!!shelfBusy||!loaded} onClick={() => void saveFeature(feature)}>Save my version</Button> }]} />
        {shelfError&&<Notice inline priority={30} title="Could not save this version" details={shelfError}>Check the editor and try again.</Notice>}
        {featureResult&&!featureResult.applied&&<Notice inline priority={30} title="These edits cannot be used yet">{(featureResult.errors??[]).join(" ")} Fix the graph, then save again.</Notice>}
        {featureResult?.applied&&<StatusText tone="ok">{`Version ${featureResult.version} saved · ${featureResult.changes.changed.length} changed, ${featureResult.changes.added.length} added, ${featureResult.changes.removed.length} removed`}</StatusText>}
      </div>}
      {run&&!feature&&<div className="cf-nodes__shelf">
        <div className="cf-nodes__shelf-head">
          <SectionHeader title="Run graph" />
          <LinkButton variant="secondary" href="#nodes">Back to the node editor</LinkButton>
        </div>
        <Meta>This copy can be edited and queued as a new run. The original run is unchanged.</Meta>
        {canEdit&&runEditingAvailable&&<Button disabled={!!shelfBusy||!loaded} onClick={()=>void runEditedGraph(run)}>Run edited graph</Button>}
        {canEdit&&!runEditingAvailable&&<Meta>Running edited graphs is unavailable on this server version.</Meta>}
        {runError&&<Notice inline priority={30} title="Could not start this run" details={runError}>Check the graph and try again.</Notice>}
        {runNotice&&<StatusText tone="ok">{runNotice}</StatusText>}
      </div>}
      {showShelf&&<div className="cf-nodes__shelf">
        <div className="cf-nodes__shelf-head">
          <div className="cf-nodes__shelf-title">
            <SectionHeader title="Your workflows" />
            <Meta>A workflow becomes an app when you publish it: it then appears in Video or Image. Drafts are saved but not yet an app.</Meta>
          </div>
          {canEdit && <Button variant="secondary" onClick={() => { setShelfOpen(true); setShelfError(""); setShelfNotice(""); }}>Import a workflow</Button>}
        </div>
        {shelfError && !shelfOpen && !feature && <Notice priority={30} title="Saved workflows didn't load" actions={<Button variant="secondary" onClick={() => { setShelfOpen(true); setShelfError(""); }}>Open the import dialog</Button>} details={shelfError}>The saved list could not be read. Opening the import dialog checks the worker's saved workflows again.</Notice>}
        {shelfNotice && <StatusText tone="ok">{shelfNotice}</StatusText>}
        {saved.length ? <Collapsible title={`${saved.length} saved workflow${saved.length === 1 ? "" : "s"} · ${saved.filter(item => item.published || item.published_revision_id).length} published`}><div className="cf-nodes__saved">{saved.map(item => <div className="ds-card cf-nodes__saved-item" key={item.id}>
          <span className="cf-nodes__saved-name">{item.label}</span>
          <StatusText tone={item.published_revision_id ? "ok" : "idle"}>{item.published ? "Published as an app" : item.published_revision_id ? "Published · newer draft" : "Draft"}</StatusText>
          <InfoButton title={item.label}>
            <Meta parts={[`Revision ${item.version}`, item.source_name]} />
            {canEdit && (featureOf(item.slug)
              ? <Button variant="ghost" disabled={!!shelfBusy} onClick={() => void applyFeature(featureOf(item.slug)!)}>Apply edits again</Button>
              : <Button variant="ghost" disabled={!!shelfBusy} onClick={() => void reimport(item)}>Reimport</Button>)}
          </InfoButton>
          {/* One next step per workflow, the one that applies now (rule 26). */}
          {canEdit && (featureOf(item.slug)
            ? (!item.published
                ? <><LinkButton variant="ghost" href={`#nodes/feature/${featureOf(item.slug)}`}>Edit in nodes</LinkButton><Button variant="secondary" disabled={!!shelfBusy} onClick={() => void publish(item, false)}>Use edited version</Button></>
                : <><LinkButton variant="ghost" href={`#nodes/feature/${featureOf(item.slug)}`}>Edit in nodes</LinkButton>{!!item.published_revision_id && <Button variant="ghost" disabled={!!shelfBusy} onClick={() => void publish(item, true)}>Restore original</Button>}</>)
            : (!item.published
                ? <Button variant="secondary" disabled={!!shelfBusy} onClick={() => void publish(item, false)}>{item.published_revision_id ? "Publish draft" : "Publish"}</Button>
                : <Button variant="ghost" disabled={!!shelfBusy} onClick={() => void publish(item, true)}>Unpublish</Button>))}
        </div>)}</div></Collapsible> : <Meta>Import a saved workflow to use it in Image or Video.</Meta>}
      </div>}
      {!importOnly&&showShelf&&!feature&&!run&&nodeStarters(catalogue,"").length>0&&<div className="cf-nodes__shelf">
        <Collapsible title="Start from a workflow">
          <SearchField label="Search workflows" placeholder="Search workflows" value={starterQuery} onChange={setStarterQuery}/>
          {nodeStarters(catalogue,starterQuery).map(item=><DataRow key={item.id} title={item.title} meta={<Meta>{item.description}</Meta>} actions={<LinkButton variant="secondary" href={`#nodes/feature/${item.id}`}>Open in nodes</LinkButton>}/>)}
          {!nodeStarters(catalogue,starterQuery).length&&<Meta>No matching workflows.</Meta>}
        </Collapsible>
      </div>}
      {!importOnly&&<div className="cf-nodes__stage">
        {!loaded && (
          <div className="cf-nodes__loading" role="status">
            <Working label="Loading the node editor" hint="ComfyUI is starting up" />
          </div>
        )}
        {src&&<iframe
          ref={frameRef}
          key={version}
          className="cf-nodes__frame"
          src={src}
          title={tool?"ComfyUI 3D tools":"ComfyUI node editor"}
          allow="clipboard-read; clipboard-write"
          onLoad={() => setLoaded(true)}
        />}
      </div>}
    </Canvas>
    <Dialog
      open={shelfOpen}
      title="Turn a workflow into an app"
      onClose={() => setShelfOpen(false)}
      footer={<>
        <Button variant="secondary" onClick={() => setShelfOpen(false)}>Cancel</Button>
        {sourceBody&&<Button variant="secondary" disabled={!!shelfBusy} onClick={() => void previewSource()}>Check the workflow</Button>}
        {preview&&label.trim()&&<Button disabled={!!shelfBusy} onClick={() => void importSource()}>{mode==="templates"&&check?.readiness.state==="ready"?"Add to my apps":"Save as draft app"}</Button>}
      </>}
    >
      <div className="cf-nodes__import">
        {!canEdit ? <Meta>Only workspace creators can import workflows.</Meta> : <>
        <Steps items={[{ title: "Choose", text: "a Comfy template, or a workflow from ComfyUI, ComfyHub or a file" }, { title: "Check", text: "we find its inputs and what it needs" }, { title: "Add", text: "ready ones go straight into the menu; others stay a draft" }]} />
        {importTargets.length>1&&(mode==="templates"||mode==="comfy")&&<SegmentedTabs label="Check on" value={importWorker?.id??""} onChange={id=>{setImportWorkerId(id);setTemplatePick(null);setSourceName("");setPreview(null);setCheck(null);}} items={importTargets.map(w=>({id:w.id,label:w.origin===CLOUD_ORIGIN?"Comfy Cloud":w.name}))} />}
        <SegmentedTabs block label="Workflow source" value={mode} onChange={value => { setMode(value as ImportMode); setPreview(null); setCheck(null); setShelfError(""); }} items={[{ id: "templates", label: "Comfy templates" }, { id: "comfy", label: importCloud?"Saved in Comfy Cloud":"Saved in ComfyUI" }, { id: "hub", label: "ComfyHub" }, { id: "file", label: "File" }]} />
        {mode==="comfy"&&(sources.length ? <div className="cf-nodes__sources">{sources.map(name => <Button key={name} variant={name === sourceName ? "primary" : "secondary"} onClick={() => { setSourceName(name); setLabel(name.replace(/\.json$/i,"")); setPreview(null); setShelfError(""); }}>{name.replace(/\.json$/i, "")}</Button>)}</div> : <Meta>No saved ComfyUI workflows found on this worker.</Meta>)}
        {mode==="templates"&&<>
          <SearchField label="Search Comfy templates" value={templateQuery} onChange={setTemplateQuery} placeholder="Search by name or model" />
          <SegmentedTabs label="Template group" value={templateGroup} onChange={setTemplateGroup} items={["All",...Array.from(new Set(templates.map(t=>t.group)))].slice(0,8).map(g=>({id:g,label:g}))} />
          {!templates.length?<Working label="Reading the Comfy template list" />:<ThumbGrid label="Comfy templates">{templates.filter(t=>runnable(t)&&(templateGroup==="All"||t.group===templateGroup)&&`${t.title} ${t.models.join(" ")} ${t.description}`.toLowerCase().includes(templateQuery.trim().toLowerCase())).slice(0,60).map(t=>
            <Thumb key={t.name} src={`/api/v1${shelfPath}/templates/${encodeURIComponent(t.name)}/thumbnail`} label={t.title} badge={t.api?"API":undefined} info={<>{t.title}<br/>{t.description}</>} selected={templatePick?.name===t.name} onSelect={()=>{setTemplatePick(t);setLabel(t.title);setPreview(null);setCheck(null);setShelfError("");}} />)}</ThumbGrid>}
          {templatePick&&<Meta parts={[templatePick.title,templatePick.models.join(", ")||null,templatePick.api?"Partner API: needs a Comfy account and credits":null]} />}
        </>}
        {mode==="hub"&&<TextField label="Workflow address" value={hubUrl} onChange={value => { setHubUrl(value); setPreview(null); setCheck(null); }} placeholder="https://comfy.org/workflows/download/…" hint="A comfy.org workflow download link or a Comfy-Org GitHub file. Only this file is fetched; nothing is installed." />}
        {mode==="file"&&<UploadSlot label={file?file.name:"Choose workflow file"} hint="A ComfyUI workflow JSON export. The file is read locally and never installed." accept="application/json,.json" kinds={[]} onFile={async chosen => { if(!chosen){setFile(null);return;} setFile({name:chosen.name,json:await chosen.text()}); setLabel(chosen.name.replace(/\.json$/i,"")); setPreview(null); setCheck(null); }} />}
        {!sourceBody&&<Meta>{mode==="templates"?"Pick a template to check it.":mode==="comfy"?"Choose a saved workflow to preview it.":mode==="hub"?"Paste a workflow address to check it.":"Choose a workflow file to check it."}</Meta>}
        {check&&<div className="cf-nodes__mapping">
          <StatusText tone={check.readiness.state==="ready"?"ok":"warn"}>{READINESS_LABEL[check.readiness.state]}</StatusText>
          {check.readiness.missingNodes.map(node => <DataRow key={node.class} title={node.class} meta={<Meta parts={["Node class not installed", node.count>1?`${node.count} uses`:null]} />} status={<StatusText tone="warn">Missing</StatusText>} />)}
          {check.readiness.models.map(model => <DataRow key={model.name} title={model.name} meta={<Meta>Model file</Meta>} status={<StatusText tone={model.present?"ok":"warn"}>{model.present?"Present":"Missing"}</StatusText>} />)}
          {!check.readiness.models.length&&!check.readiness.missingNodes.length&&<Meta>No model files or extra nodes are named in this workflow.</Meta>}
          <InfoButton title="Workflow source"><Meta parts={[check.source.url??check.source.name, `SHA-256 ${check.source.sha256.slice(0,16)}…`]} /></InfoButton>
        </div>}
        {preview&&<TextField label="Workflow name" value={label} onChange={value => setLabel(value)} hint="Used in the Video or Image menu. The slug is generated once and stays stable." />}
        {preview && <div className="cf-nodes__mapping">
          <SectionHeader title="The app will show" />
          <DataRow title="Inputs" meta={<Meta>{preview.inputs.map(input => input.port).join(", ") || "none, it runs from its own values"}</Meta>} />
          <DataRow title="Controls" meta={<Meta>{preview.controls.map(control => control.control).join(", ") || "none"}</Meta>} />
          <DataRow title="Result" meta={<Meta>{`${preview.outputs.length} output${preview.outputs[0]?.nodeType ? ` · ${preview.outputs[0].nodeType}` : ""}`}</Meta>} />
          <DataRow title="Needs" meta={<Meta>{`${preview.dependencies.length} model or node file${preview.dependencies.length === 1 ? "" : "s"} · ${preview.source.nodes} nodes in the graph`}</Meta>} />
          {!!preview.fixed?.length&&<Meta>{`Kept at the workflow's own values because several nodes use them: ${preview.fixed.map(entry => entry.control).join(", ")}`}</Meta>}
        </div>}
        {check&&!check.mapping&&check.errors.length>0&&<Notice inline priority={20} title="This workflow cannot be imported yet">{check.errors.slice(0,4).map(error => [error.class, error.reason].filter(Boolean).join(": ")).join(" · ")}</Notice>}
        {shelfError && <Notice inline priority={20} title="Import stopped" details={shelfError}>Nothing was saved. Correct the source above, then check it again.</Notice>}
        {!!preview && <Meta>The generated manifest and graph were validated. Saving makes a draft app. Publishing is a separate step in “Your workflows”. Missing models stay missing until you install them.</Meta>}
        </>}
      </div>
    </Dialog>
  </div>;
}
