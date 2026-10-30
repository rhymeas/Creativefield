import { useEffect,useRef,useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, Canvas, DataRow, Dialog, EmptyState, InfoButton, LinkButton, Meta, Notice, SectionHeader, SegmentedTabs, StatusText, TextField, UploadSlot, Working } from "../../ds";
import type { Worker, Workspace } from "../api";
import {request,workspacePath} from "../api";
import {plainProblem} from "../problems";
import "./comfy-nodes.css";
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
type ImportMode = "comfy" | "hub" | "file";
type FeatureResult = { applied: boolean; errors?: string[]; workflowId?: string; revisionId?: string; version?: number; changes: { added: string[]; removed: string[]; changed: string[] } };
/** "#nodes/feature/<capability id>" opens that feature's graph in the editor. */
const featureFromHash = () => { const match = /^#nodes\/feature\/([a-z0-9][a-z0-9-]{0,79})$/.exec(location.hash); return match?.[1] ?? null; };
/** "#nodes/run/<run id>" opens the graph that run submitted in the editor, read-only. */
export const runFromHash = (hash: string) => /^#nodes\/run\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(hash)?.[1] ?? null;
/** The editor address: a feature's graph or a run's graph opens in the same frame. */
export const editorSource = (url: string, options: { version: number; tool?: ThreeDTool; feature?: string | null; run?: string | null }) =>
  `${url}?v=${options.version}${options.tool ? `&studio3d=${options.tool}` : ""}${options.feature ? `&comfyfield_feature=${encodeURIComponent(options.feature)}` : ""}${options.run ? `&comfyfield_run=${encodeURIComponent(options.run)}` : ""}`;
const featureOf = (slug: string) => (slug.startsWith("feature-") ? slug.slice("feature-".length) : null);
const READINESS_LABEL: Record<Readiness["state"], string> = { ready: "Ready", partial: "Partial: model files missing", missing: "Missing: node classes not installed" };

/** The official editor uses a separate origin so extension scripts cannot read app APIs. */
export function ComfyNodes({ workspace, workers, tool, canEdit = false, serverOffline = false, canStartLocal = false, onChanged, onWorkerSettings }: { workspace: Workspace; workers: Worker[]; tool?: ThreeDTool; canEdit?: boolean; serverOffline?: boolean; canStartLocal?: boolean; onChanged?: () => void | Promise<void>; /** Where a person registers or checks a worker. Every offline state leads here, so it is required. */ onWorkerSettings: () => void }) {
  const worker = workers.find(candidate => candidate.enabled);
  const [version, setVersion] = useState(0);
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
  const [mode,setMode]=useState<ImportMode>("comfy");
  const [hubUrl,setHubUrl]=useState("");
  const [file,setFile]=useState<{name:string;json:string}|null>(null);
  const [check,setCheck]=useState<HubCheck|null>(null);
  const [feature,setFeature]=useState<string|null>(featureFromHash);
  const [run,setRun]=useState<string|null>(()=>runFromHash(location.hash));
  const [featureResult,setFeatureResult]=useState<FeatureResult|null>(null);
  useEffect(()=>{const sync=()=>{setFeature(featureFromHash());setRun(runFromHash(location.hash));setFeatureResult(null);};window.addEventListener("hashchange",sync);return()=>window.removeEventListener("hashchange",sync);},[]);
  const showShelf=!tool||tool==="workflows";
  const shelfPath=workspacePath(workspace.id,"workflow-imports");

  async function loadShelf(){
    try{
      const list=await request<SavedWorkflow[]>(shelfPath);
      setSaved(list.map(item=>({...item,published_revision_id:item.published_revision_id??(item.published?item.revision_id:null)})));
      if(canEdit){
        const result=await request<{names:string[]}>(`${shelfPath}/sources${worker?`?workerId=${encodeURIComponent(worker.id)}`:""}`);
        setSources(result.names);
      }
    }catch(cause){setShelfError((cause as Error).message);}
  }
  useEffect(()=>{if(showShelf&&!serverOffline)void loadShelf();},[workspace.id,worker?.id,canEdit,showShelf,serverOffline]);

  /** The chosen source as the import API expects it: a saved name, a Hub address or the file's text. */
  const sourceBody=mode==="comfy"?(sourceName?{name:sourceName}:null):mode==="hub"?(hubUrl.trim()?{name:hubUrl.trim()}:null):(file?{json:file.json}:null);
  async function checkSource(){
    if(!sourceBody)return;
    setShelfBusy("preview");setShelfError("");setShelfNotice("");setCheck(null);setPreview(null);
    try{
      const result=await request<HubCheck>(`${shelfPath}/hub-check`,"POST",{...sourceBody,...(worker?{workerId:worker.id}:{})});
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
      const result=await request<{manifest:{title:string};mapping:Mapping}>(`${shelfPath}/preview`,"POST",{name:sourceName,...(worker?{workerId:worker.id}:{})});
      setPreview(result.mapping);
      if(!label)setLabel(result.manifest.title);
    }catch(cause){setPreview(null);setShelfError((cause as Error).message);}
    finally{setShelfBusy("");}
  }
  async function importSource(){
    if(!sourceBody||!label||!preview)return;
    setShelfBusy("import");setShelfError("");setShelfNotice("");
    try{
      await request(shelfPath,"POST",{...sourceBody,label,...(worker?{workerId:worker.id}:{})});
      setShelfOpen(false);setPreview(null);setCheck(null);setSourceName("");setHubUrl("");setFile(null);setLabel("");
      setShelfNotice("Workflow saved as a draft. Publish it to show it in the Video or Image menu.");
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
  async function useEdited(result:FeatureResult){
    if(!result.workflowId||!result.revisionId)return;
    setShelfBusy("feature");setShelfError("");
    try{await request(`${shelfPath}/${result.workflowId}/publish`,"POST",{revisionId:result.revisionId});setShelfNotice("The feature now runs your edited graph. Restore the original from Saved workflows at any time.");setFeatureResult(null);await loadShelf();}
    catch(cause){setShelfError((cause as Error).message);}
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
    if(serverOffline)return;
    const controller=new AbortController();setError("");
    request<{url:string}>(workspacePath(workspace.id,"node-editor"),"GET",undefined,controller.signal)
      .then(result=>{setTarget({workspaceId:workspace.id,url:result.url});setLoaded(false);})
      .catch(error=>{if(!controller.signal.aborted)setError((error as Error).message);});
    return()=>controller.abort();
  },[workspace.id,version,serverOffline]);
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

  if(serverOffline)return <EmptyState stage title="CreativeField is offline" text="Reconnect to the team server to keep working on the node editor." action={<Button variant="secondary" onClick={retryConnection}>Retry connection</Button>}/>;
  if (!worker || (worker.inventory?.online === false&&!workerConfirmedOnline)) {
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
  if(error)return <EmptyState stage title="Node editor unavailable" text={`${plainProblem(error).text} Trying again reloads the editor.`} action={<Button variant="secondary" onClick={()=>setVersion(value=>value+1)}>Try again</Button>}/>;

  return <div className="cf-nodes">
    <Canvas workspace
      toolbarStart={tool ? undefined : <SectionHeader large title="Node editor" />}
      toolbarEnd={<>
        <Button variant="secondary" onClick={() => { setLoaded(false); setVersion(value => value + 1); }}><RefreshCw size={12} />Reload</Button>
        {src&&<LinkButton variant="secondary" href={src}>Open in new tab</LinkButton>}
      </>}
    >
      {feature&&canEdit&&<div className="cf-nodes__shelf">
        <div className="cf-nodes__shelf-head">
          <SectionHeader title={`Editing ${feature}`} />
          <Button disabled={!!shelfBusy} onClick={() => void applyFeature(feature)}>Apply edits</Button>
        </div>
        <Meta>{`Change the graph below, then save it with Ctrl+S under the name “ComfyField - ${feature}”. Apply edits checks it and keeps it as a draft until you choose to use it.`}</Meta>
        {featureResult&&!featureResult.applied&&<Notice inline priority={30} title="These edits cannot be used yet">{(featureResult.errors??[]).join(" ")} Fix the graph, then press Apply edits again.</Notice>}
        {featureResult?.applied&&<>
          <StatusText tone="ok">{`Draft ${featureResult.version} saved · ${featureResult.changes.changed.length} changed, ${featureResult.changes.added.length} added, ${featureResult.changes.removed.length} removed`}</StatusText>
          <Button disabled={!!shelfBusy} onClick={() => void useEdited(featureResult)}>Use edited version</Button>
        </>}
      </div>}
      {run&&!feature&&<div className="cf-nodes__shelf">
        <div className="cf-nodes__shelf-head">
          <SectionHeader title="Live run" />
          <LinkButton variant="secondary" href="#nodes">Back to the node editor</LinkButton>
        </div>
        <Meta>This is a copy of the graph the run sent. The run keeps going. The editor shows the node it is working on and its progress.</Meta>
      </div>}
      {showShelf&&<div className="cf-nodes__shelf">
        <div className="cf-nodes__shelf-head">
          <SectionHeader title="Saved workflows" />
          {canEdit && <Button variant="secondary" onClick={() => { setShelfOpen(true); setShelfError(""); setShelfNotice(""); }}>Import saved workflow</Button>}
        </div>
        {shelfError && !shelfOpen && <Notice priority={30} title="Saved workflows didn't load" actions={<Button variant="secondary" onClick={() => { setShelfOpen(true); setShelfError(""); }}>Open the import dialog</Button>} details={shelfError}>The saved list could not be read. Opening the import dialog checks the worker's saved workflows again.</Notice>}
        {shelfNotice && <StatusText tone="ok">{shelfNotice}</StatusText>}
        {saved.length ? <div className="cf-nodes__saved">{saved.map(item => <div className="cf-nodes__saved-item" key={item.id}>
          <Meta>{item.label}</Meta>
          <StatusText tone={item.published_revision_id ? "ok" : "idle"}>{item.published ? "Published" : item.published_revision_id ? "Published · newer draft" : "Draft"}</StatusText>
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
        </div>)}</div> : <Meta>Import a saved workflow to use it in Image or Video.</Meta>}
      </div>}
      <div className="cf-nodes__stage">
        {!loaded && (
          <div className="cf-nodes__loading" role="status">
            <Working label="Loading the node editor" hint="ComfyUI is starting up" />
          </div>
        )}
        {src&&<iframe
          key={version}
          className="cf-nodes__frame"
          src={src}
          title={tool?"ComfyUI 3D tools":"ComfyUI node editor"}
          allow="clipboard-read; clipboard-write"
          onLoad={() => setLoaded(true)}
        />}
      </div>
    </Canvas>
    <Dialog
      open={shelfOpen}
      title="Import a ComfyUI workflow"
      onClose={() => setShelfOpen(false)}
      footer={<>
        <Button variant="secondary" onClick={() => setShelfOpen(false)}>Cancel</Button>
        {sourceBody&&<Button variant="secondary" disabled={!!shelfBusy} onClick={() => void previewSource()}>{mode==="comfy"?"Preview mapping":"Check workflow"}</Button>}
        {preview&&label.trim()&&<Button disabled={!!shelfBusy} onClick={() => void importSource()}>Import draft</Button>}
      </>}
    >
      <div className="cf-nodes__import">
        {!canEdit ? <Meta>Only workspace creators can import workflows.</Meta> : <>
        <SegmentedTabs block label="Workflow source" value={mode} onChange={value => { setMode(value as ImportMode); setPreview(null); setCheck(null); setShelfError(""); }} items={[{ id: "comfy", label: "Saved in ComfyUI" }, { id: "hub", label: "ComfyHub" }, { id: "file", label: "File" }]} />
        {mode==="comfy"&&(sources.length ? <div className="cf-nodes__sources">{sources.map(name => <Button key={name} variant={name === sourceName ? "primary" : "secondary"} onClick={() => { setSourceName(name); setLabel(name.replace(/\.json$/i,"")); setPreview(null); setShelfError(""); }}>{name.replace(/\.json$/i, "")}</Button>)}</div> : <Meta>No saved ComfyUI workflows found on this worker.</Meta>)}
        {mode==="hub"&&<TextField label="Workflow address" value={hubUrl} onChange={value => { setHubUrl(value); setPreview(null); setCheck(null); }} placeholder="https://comfy.org/workflows/download/…" hint="A comfy.org workflow download link or a Comfy-Org GitHub file. Only this file is fetched; nothing is installed." />}
        {mode==="file"&&<UploadSlot label={file?file.name:"Choose workflow file"} hint="A ComfyUI workflow JSON export. The file is read locally and never installed." accept="application/json,.json" kinds={[]} onFile={async chosen => { if(!chosen){setFile(null);return;} setFile({name:chosen.name,json:await chosen.text()}); setLabel(chosen.name.replace(/\.json$/i,"")); setPreview(null); setCheck(null); }} />}
        {!sourceBody&&<Meta>{mode==="comfy"?"Choose a saved workflow to preview it.":mode==="hub"?"Paste a workflow address to check it.":"Choose a workflow file to check it."}</Meta>}
        {check&&<div className="cf-nodes__mapping">
          <StatusText tone={check.readiness.state==="ready"?"ok":"warn"}>{READINESS_LABEL[check.readiness.state]}</StatusText>
          {check.readiness.missingNodes.map(node => <DataRow key={node.class} title={node.class} meta={<Meta parts={["Node class not installed", node.count>1?`${node.count} uses`:null]} />} status={<StatusText tone="warn">Missing</StatusText>} />)}
          {check.readiness.models.map(model => <DataRow key={model.name} title={model.name} meta={<Meta>Model file</Meta>} status={<StatusText tone={model.present?"ok":"warn"}>{model.present?"Present":"Missing"}</StatusText>} />)}
          {!check.readiness.models.length&&!check.readiness.missingNodes.length&&<Meta>No model files or extra nodes are named in this workflow.</Meta>}
          <InfoButton title="Workflow source"><Meta parts={[check.source.url??check.source.name, `SHA-256 ${check.source.sha256.slice(0,16)}…`]} /></InfoButton>
        </div>}
        {preview&&<TextField label="Workflow name" value={label} onChange={value => setLabel(value)} hint="Used in the Video or Image menu. The slug is generated once and stays stable." />}
        {preview && <div className="cf-nodes__mapping">
          <Meta parts={[`${preview.source.nodes} API nodes`, `${preview.outputs.length} output`, preview.outputs[0]?.nodeType, ...preview.controls.map(control => control.control)]} />
          <Meta parts={[`Inputs: ${preview.inputs.map(input => input.port).join(", ") || "none"}`, `Dependencies: ${preview.dependencies.length}`]} />
          {!!preview.fixed?.length&&<Meta>{`Kept at the workflow's own values because several nodes use them: ${preview.fixed.map(entry => entry.control).join(", ")}`}</Meta>}
        </div>}
        {check&&!check.mapping&&check.errors.length>0&&<Notice inline priority={20} title="This workflow cannot be imported yet">{check.errors.slice(0,4).map(error => [error.class, error.reason].filter(Boolean).join(": ")).join(" · ")}</Notice>}
        {shelfError && <Notice inline priority={20} title="Import stopped" details={shelfError}>Nothing was saved. Correct the source above, then check it again.</Notice>}
        {!!preview && <Meta>The generated manifest and graph were validated. Importing saves a draft; publishing is a separate action. Missing models stay missing until you install them.</Meta>}
        </>}
      </div>
    </Dialog>
  </div>;
}
