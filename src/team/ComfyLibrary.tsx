import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AudioLines, Box, Image as ImageIcon, Layers, RefreshCw, SlidersHorizontal, Sparkles, Video } from "lucide-react";
import { Dialog, EmptyState, IconButton, InfoButton, Meta, ModelTile, ModelOption, Notice, SectionHeader, SegmentedTabs, SparkleLoader, StatusText, TileGrid, Toolbar, Button } from "../ds";
import type { CatalogueControls } from "../ui/CapabilityCatalogue";
import type { ComfyLibrary } from "../capabilities/types";
import {assessHardware,gib} from "../capabilities/hardware";
import { workspacePath, type Call, type Worker, type Workspace } from "./api";
import { groupModels, groupNodes, libraryFilters, modelRole as modelRoleFor, nodeRole as nodeRoleFor, type LibraryFilter, type LibraryRole } from "./comfy-library-roles";
import { libraryProblem } from "./problems";
import "./comfy-library.css";

type Props = { workspace: Workspace; workers: Worker[]; call: Call; controls?: CatalogueControls; /** The place that registers workers, so a missing one can be added from here. */ onWorkerSettings?: () => void };
type Inspect = { title: string; parts: string[] };

const countLabel = (count: number, singular: string) => `${count} ${count === 1 ? singular : `${singular}s`}`;

const roleIcon = (role: LibraryRole) => role.filter === "generation"
  ? (role.id === "video" ? <Video size={16} /> : <ImageIcon size={16} />)
  : role.filter === "audio" ? <AudioLines size={16} />
  : role.filter === "enhance" ? <Layers size={16} />
  : role.filter === "control" ? <SlidersHorizontal size={16} />
  : role.filter === "support" ? <Box size={16} />
  : <Sparkles size={16} />;

/** Preserve a valid choice; default to a reachable local installation before cloud. */
export function libraryWorkerId(workers: Worker[], currentId=""): string {
  const enabled=workers.filter(worker=>worker.enabled);
  if(enabled.some(worker=>worker.id===currentId))return currentId;
  const local=(worker:Worker)=>(worker as Worker&{kind?:string}).kind!=="cloud"&&!/^https:\/\/cloud\.comfy\.org\/?$/.test(worker.origin);
  return (enabled.find(worker=>local(worker)&&worker.inventory?.online)??enabled.find(worker=>worker.inventory?.online)??enabled.find(local)??enabled[0])?.id??"";
}

/** Live read-only view of the models and node classes a ComfyUI server already provides. */
export function ComfyLibraryPanel({ workspace, workers, call, controls, onWorkerSettings }: Props) {
  const enabled = useMemo(() => workers.filter(worker => worker.enabled), [workers]);
  const [workerId, setWorkerId] = useState(()=>libraryWorkerId(enabled));
  const [library, setLibrary] = useState<ComfyLibrary | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [task, setTask] = useState<"" | "start" | "probe">("");
  const [launchRequested, setLaunchRequested] = useState(false);
  const view = controls?.view ?? "models";
  const query = controls?.query ?? "";
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [inspect, setInspect] = useState<Inspect | null>(null);

  useEffect(() => {
    if (!enabled.some(worker => worker.id === workerId)) setWorkerId(libraryWorkerId(enabled));
  }, [enabled, workerId]);

  const load = useCallback(async () => {
    if (!workerId) return;
    setBusy(true); setError("");
    try { setLibrary(await call<ComfyLibrary>(workspacePath(workspace.id, `workers/${workerId}/library`))); }
    catch (cause) { setError((cause as Error).message); setLibrary(null); }
    finally { setBusy(false); }
  }, [call, workerId, workspace.id]);

  useEffect(() => { void load(); }, [load]);

  const needle = query.trim().toLowerCase();
  const folders = useMemo(() => (library?.folders ?? []).map(folder => ({
    ...folder,
    files: folder.files.filter(file => {
      const role = modelRoleFor(folder.name, file);
      if (role.id === "config" || role.id === "nodes") return false;
      return (filter === "all" || role.filter === filter) &&
        (!needle || `${folder.name}/${file}`.toLowerCase().includes(needle));
    })
  })).filter(folder => folder.files.length > 0), [library, needle, filter]);
  const modelGroups = useMemo(() => groupModels(folders), [folders]);
  const nodes = useMemo(() => (library?.nodes ?? []).filter(node => {
    const role = nodeRoleFor(node);
    return (filter === "all" || role.filter === filter) &&
      (!needle || `${node.displayName} ${node.name} ${node.category}`.toLowerCase().includes(needle));
  }), [library, needle, filter]);
  const nodeGroups = useMemo(() => groupNodes(nodes), [nodes]);
  const visibleNodes = nodes.slice(0, 240);
  const visibleNodeGroups = useMemo(() => groupNodes(visibleNodes), [visibleNodes]);

  const allFiles = (library?.folders ?? []).reduce((total, folder) => total + folder.files.length, 0);
  const fileCount = (library?.folders ?? []).reduce((total, folder) => total + folder.files.filter(file => {
    const role = modelRoleFor(folder.name, file);
    return role.id !== "config" && role.id !== "nodes";
  }).length, 0);
  const supportFiles = allFiles - fileCount;
  const emptyFolders = (library?.folders ?? []).filter(folder => !folder.files.length).length;
  const setup=assessHardware(library?.hardware);

  const worker = enabled.find(candidate => candidate.id === workerId);
  /** Ready means the models of the selected worker actually arrived. */
  const ready = !!worker && !!library && library.online && !error;
  /** A partly read library is said in everyday words, and its code waits behind Details. */
  const libraryNote = library ? libraryProblem(library.issues, { address: worker?.origin }) : null;

  /** An empty list is undone by the search that emptied it, or by one more read of the worker. */
  const emptyAction = needle && controls?.onClearQuery
    ? <Button variant="secondary" onClick={()=>controls?.onClearQuery?.()}>Clear search</Button>
    : <Button variant="secondary" disabled={busy} onClick={()=>void load()}>Check again</Button>;

  /** One worker choice, the same card on every view of this panel. */
  const workerChoice = <div className="cf-library__workers" role="radiogroup" aria-label="ComfyUI worker">
    {enabled.map(candidate => <ModelOption
      key={candidate.id}
      title={candidate.name}
      subtitle={candidate.origin}
      status={candidate.id === workerId && library ? (library.online ? "ready" : "offline") : candidate.inventory?.online === true ? "ready" : candidate.checked_at ? "offline" : "checking"}
      selected={candidate.id === workerId}
      onSelect={() => setWorkerId(candidate.id)}
    />)}
  </div>;

  async function startWorker() {
    if (!worker) return;
    setTask("start"); setError("");
    try { await call(workspacePath(workspace.id, `workers/${worker.id}/start`), "POST"); setLaunchRequested(true); }
    catch (cause) { setError((cause as Error).message); }
    finally { setTask(""); }
  }
  async function checkWorker() {
    if (!worker) return;
    setTask("probe"); setError("");
    try {
      const result = await call<{ inventory: { online?: boolean } }>(workspacePath(workspace.id, `workers/${worker.id}/probe`), "POST");
      if (result.inventory.online) { setLaunchRequested(false); await load(); }
      else setError("ComfyUI is still starting. Wait a moment, then check again.");
    }
    catch (cause) { setError((cause as Error).message); }
    finally { setTask(""); }
  }

  /** Why the models are not here yet, and the one action that gets them (rule 36). */
  function notReadyState(): { title: string; text: string; action?: ReactNode; reading?: boolean } {
    if (error) return { title: "The ComfyUI library did not load", text: "Retry reads the models and nodes from the selected worker again.", action: <Button variant="secondary" disabled={busy} onClick={() => void load()}>{busy ? "Retrying…" : "Retry"}</Button> };
    if (!enabled.length) return { title: "No ComfyUI worker yet", text: "Add the address of a ComfyUI server and check it. Its models and nodes then appear here without extra configuration.", action: onWorkerSettings ? <Button variant="secondary" onClick={onWorkerSettings}>Open worker settings</Button> : undefined };
    if (!library) return { title: "Reading the ComfyUI library", text: "The selected worker is answering. Models and nodes appear as they arrive.", reading: true };
    if (launchRequested) return { title: "ComfyUI is starting", text: "Check again when ComfyUI has finished loading; this list then fills on its own.", action: <Button variant="secondary" disabled={!!task} onClick={() => void checkWorker()}>{task === "probe" ? "Checking…" : "Check again"}</Button> };
    if (worker?.can_start) return { title: "ComfyUI is offline", text: "Start ComfyUI here; its models and nodes load as soon as it answers.", action: <Button variant="secondary" disabled={!!task} onClick={() => void startWorker()}>{task === "start" ? "Starting…" : "Start ComfyUI"}</Button> };
    return { title: "ComfyUI is not answering", text: "Check the connection; its models and nodes load as soon as the worker answers.", action: <Button variant="secondary" disabled={!!task} onClick={() => void checkWorker()}>{task === "probe" ? "Checking…" : "Check connection"}</Button> };
  }

  const bar = <Toolbar className="cf-library__bar">
    {library?.online && <SegmentedTabs quiet label="Library sections" value={filter} onChange={setFilter} items={libraryFilters} />}
    <div className="cf-library__end">
      {library && <StatusText tone={library.online ? "ok" : "warn"}>{library.online ? "Online" : "Offline"}</StatusText>}
      {library && <InfoButton title="ComfyUI library details">
        <Meta parts={[`${library.nodes.length} nodes`, `${fileCount} models`, library.version ? `ComfyUI ${library.version}` : "Version unknown"]} />
        <Meta parts={[...(library.hardware?.devices.map(d=>`${d.name} · GPU memory ${gib(d.vramTotal)} total / ${gib(d.vramFree)} free`)??[]),`System RAM ${gib(library.hardware?.ramTotal)} total / ${gib(library.hardware?.ramFree)} free`]}/>
        <Meta parts={[library.storage?.app?`App data on ${library.storage.app.volume} · ${gib(library.storage.app.freeBytes)} free`:"App storage not reported",library.storage?.models?`Model volume ${library.storage.models.volume} · ${gib(library.storage.models.freeBytes)} free`:"Model storage location not reported by this worker"]}/>
        <p>{setup.guidance}</p>
        <p>Fun Camera's two diffusion weight files occupy 30.6 GB on disk, plus shared dependencies. File size is separate from RAM and GPU memory. Begin with a short trial; refresh this check after changing the setup.</p>
      </InfoButton>}
      {workerId && <IconButton label={busy ? "Reading the ComfyUI library" : "Refresh the ComfyUI library"} disabled={busy} onClick={() => void load()}><RefreshCw size={14} /></IconButton>}
    </div>
  </Toolbar>;

  /* Not ready yet: the worker choice and the reason sit together in the middle of the space,
     because with nothing loaded they are the whole screen. */
  if (!ready) {
    const state = notReadyState();
    return <div className="cf-library">
      {bar}
      <div className="cf-library__stage">
        {!!enabled.length && workerChoice}
        <EmptyState
          icon={state.reading ? <SparkleLoader size="sm" /> : undefined}
          title={state.title}
          text={state.text}
          action={state.action}
        />
      </div>
      {inspect && <Dialog open title={inspect.title} onClose={() => setInspect(null)}><Meta parts={inspect.parts} /></Dialog>}
    </div>;
  }

  return <div className="cf-library">
    {bar}
    {workerChoice}
    {library?.online && <>
      {/* A hardware tier is advice, not a failure: it stays a quiet hint (rule 30), and its full
          text is already behind the info button above. */}
      {view==="models"&&<Notice tone="info" title={setup.title}>{setup.guidance.split(". ")[0].replace(/\.$/,"")}.</Notice>}
      {view === "nodes" && nodes.length > visibleNodes.length && <Meta parts={[`Showing the first ${visibleNodes.length} of ${nodes.length} matching nodes. Search or pick a section to narrow the list.`]} />}

      <div className="cf-library__scroll">
        {view === "models" && !modelGroups.length && <EmptyState title="No models match" text={needle||filter!=="all"?"Clear the search or pick another section. Empty ComfyUI folders are hidden.":"This worker reports no models yet. Checking again re-reads the list; a model added to ComfyUI appears without a reload."} action={emptyAction} />}
        {view === "models" && modelGroups.map(group => <section className="cf-library__section" key={group.role.id}>
          <SectionHeader title={group.role.label} meta={<Meta parts={[countLabel(group.files.length, "file")]} />} end={<InfoButton title={group.role.label}><Meta parts={[group.role.purpose]} /></InfoButton>} />
          <TileGrid label={`${group.role.label} models`}>{group.files.map(entry => <ModelTile
            key={`${entry.folder}/${entry.file}`}
            icon={roleIcon(group.role)}
            roomy
            title={entry.file}
            text={entry.folder}
            onClick={() => setInspect({ title: entry.file, parts: [`Folder: ${entry.folder}`, `Role: ${group.role.label}`, group.role.purpose] })}
          />)}</TileGrid>
        </section>)}

        {view === "nodes" && !nodeGroups.length && <EmptyState title="No nodes match" text={needle||filter!=="all"?"Clear the search or pick another section.":"This worker reports no node classes yet. Checking again re-reads the list; custom nodes appear once ComfyUI has loaded them."} action={emptyAction} />}
        {view === "nodes" && visibleNodeGroups.map(group => <section className="cf-library__section" key={group.role.id}>
          <SectionHeader title={group.role.label} meta={<Meta parts={[`${countLabel(group.nodes.length, "node")}${nodes.length > visibleNodes.length ? " shown" : ""}`]} />} end={<InfoButton title={`Node role: ${group.role.label}`}><Meta parts={[group.role.purpose]} /></InfoButton>} />
          <TileGrid label={`${group.role.label} nodes`}>{group.nodes.map(node => <ModelTile
            key={node.name}
            icon={roleIcon(group.role)}
            roomy
            title={node.displayName || node.name}
            text={node.outputs.length ? node.outputs.join(", ") : node.name}
            onClick={() => setInspect({ title: node.displayName || node.name, parts: [`Node: ${node.name}`, `Category: ${node.category || "Other"}`, node.outputs.length ? `Outputs: ${node.outputs.join(", ")}` : "No outputs"] })}
          />)}</TileGrid>
        </section>)}
      </div>

      {!!library.issues.length && libraryNote && <Notice tone="info" title={libraryNote.title} actions={<Button variant="secondary" disabled={busy} onClick={() => void load()}>{busy ? "Checking…" : "Check again"}</Button>} details={libraryNote.details}>{libraryNote.text}</Notice>}
      {!!(emptyFolders || supportFiles) && <Meta parts={[...(emptyFolders ? [`${emptyFolders} empty folders hidden`] : []), ...(supportFiles ? [`${supportFiles} config and custom-node files hidden`] : [])]} />}
    </>}

    {inspect && <Dialog open title={inspect.title} onClose={() => setInspect(null)}><Meta parts={inspect.parts} /></Dialog>}
  </div>;
}
