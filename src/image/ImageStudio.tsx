import {ExampleTiles} from "../team/ExampleTiles";
import {TeamChoice,type TeamChoiceOption} from "../team/TeamChoice";
import {ToolHero} from "../team/heroes";
import {WorkflowDescription} from "../team/workflow-info";
import { Fragment, useEffect, useId, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Maximize2, Pencil } from "lucide-react";
import type { CapabilityManifestV2, Control, Readiness } from "../capabilities/types";
import { Block, Canvas, GenerateButton, HintButton, HistoryItem, Meta, ModelCard, Notice, Page, Panel, PromptField, Collapsible, Button, ContactSheet, Dialog, Flashlight, IconButton, InfoButton, MediaViewer, ResultGrid, ResultTile, CameraAngleSheet, useToast, ShimmerText, Row, SectionHeader, Split, StatusText, TextField, Thumb, ThumbGrid, Toolbar, type ContactSheetItem, CompareWipe, CompareStrip, LinkButton } from "../ds";
import {AngleBatchPanel} from "./AngleBatchPanel";
import {AngleSweepPanel} from "./AngleSweepPanel";
import {TrueAnglesPanel} from "./TrueAnglesPanel";
import {useRunInputs} from "./use-run-inputs";
import type {AngleBatchAction} from "./angle-batch-action";
import {subjectRelightInstruction,subjectRelightKey,subjectRelightSchema} from "./subject-relight";
import { assetUrl, workspacePath, type Call, type Asset, type Project, type Run, type Workspace, type CharacterRecord } from "../team/api";
import { characterPath } from "../team/characters/state";
import type { ElementInputBinding } from "../team/state";
import { useDevelopPreview } from "../team/useDevelopPreview";
import { developPresentation } from "../team/develop-state";
import {
  characterReferenceBinding,
  handleImageStudioShortcut,
  imageControls,
  imageDraftIssues,
  imageGenerateStatus,
  isCharacterPort,
  type ImageDraft,
} from "./image-state";
import "./image.css";

export type ImageStudioProps = {
  workspace: Workspace;
  project: Project;
  manifest: CapabilityManifestV2;
  readiness: Readiness;
  assets: Asset[];
  runs: Run[];
  draft: ImageDraft;
  busy?: boolean;
  workerName?: string;
  onDraftChange: (draft: ImageDraft) => void;
  onGenerate: (draft: ImageDraft) => void;
  onCancel?: (run: Run) => Promise<void>;
  canCancelRun?: (run: Run) => boolean;
  onRetake?: (run: Run) => void;
  onUseInVideo?: (assetId:string)=>void;
  /** The image models to choose from; a click on the model card opens them. */
  modelOptions?: TeamChoiceOption[];
  onModel?: (id:string)=>void;
  batchContext?: {userId:string;workerId:string;call:Call;onChanged:()=>void};
  subjectRelightAvailable?:boolean;
};

const RUN_LABELS: Record<string, string> = {
  pending: "Queued",
  queued: "Queued",
  submitting: "Submitting",
  running: "Generating",
  succeeded: "Complete",
  failed: "Failed",
  canceled: "Cancelled",
  cancel_requested: "Cancelling…",
  submission_unknown: "Checking submission",
};

function runTone(state: string): "idle" | "active" | "ok" | "warn" {
  if (["queued", "submitting", "running", "submission_unknown"].includes(state)) return "active";
  if (state === "succeeded") return "ok";
  return state === "failed" ? "warn" : "idle";
}

function promptFor(run: Run): string {
  const prompt = run.invocation?.controls?.prompt;
  return typeof prompt === "string" ? prompt : "";
}

/** The same bindings without this port, so a port never keeps a character it no longer shows. */
function withoutPort(bindings: ImageDraft["elementInputs"], port: string): ImageDraft["elementInputs"] {
  const next = { ...bindings };
  delete next[port];
  return next;
}

function ControlField({
  control,
  value,
  disabled,
  onChange,
}: {
  control: Control;
  value: string | number | boolean | undefined;
  disabled: boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  if (control.id === "prompt" || control.type === "string") {
    return (
      <PromptField
        compact={control.id !== "prompt"}
        disabled={disabled}
        label={control.label}
        placeholder={control.id === "prompt" ? "Describe the image to create" : `Enter ${control.label.toLowerCase()}`}
        value={typeof value === "string" ? value : ""}
        onChange={onChange}
      />
    );
  }
  if (control.type === "select" && control.options?.length) {
    const selected = (value ?? control.options[0]) as string | number;
    return (
      <Row
        disabled={disabled}
        label={control.label}
        display={String(selected)}
        value={selected}
        options={control.options.map((option) => ({ value: option, label: String(option) }))}
        onChange={onChange}
      />
    );
  }
  if (control.type === "number" || control.type === "integer") {
    return (
      <TextField
        disabled={disabled}
        label={control.label}
        type="number"
        min={control.min}
        max={control.max}
        step={control.type === "integer" ? 1 : "any"}
        value={value === undefined ? "" : String(value)}
        onChange={(next) => onChange(next === "" ? "" : Number(next))}
      />
    );
  }
  return null;
}

export function ImageStudio({
  workspace,
  project,
  manifest,
  readiness,
  assets,
  runs,
  draft,
  busy: externalBusy = false,
  workerName,
  onDraftChange,
  onGenerate,
  onCancel,
  canCancelRun,
  onRetake,
  batchContext,
  onUseInVideo,
  modelOptions,
  onModel,
  subjectRelightAvailable=false,
}: ImageStudioProps) {
  const toast=useToast();
  const [advanced,setAdvanced]=useState(false);
  const [batchBusy,setBatchBusy]=useState(false);
  const [angleAction,setAngleAction]=useState<AngleBatchAction|null>(null);
  const busy=externalBusy||batchBusy;
  const hintId = useId();
  const controls = imageControls(manifest);
  const imageInputs = manifest.inputs.filter((port) => port.type === "image");
  const imageAssets = assets.filter((asset) => asset.media_type === "image");
  const issues = imageDraftIssues(manifest, draft);
  const status = imageGenerateStatus(readiness, issues, busy);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const imageRuns = runs.filter((run) => run.capability_id === manifest.id);
  const latest = imageRuns[0];
  const runInputs = useRunInputs(workspace.id, imageRuns);
  const older = imageRuns.slice(1);
  const outputsOf = (run: Run) => run.output_ids.map((id) => assetsById.get(id)).filter((asset): asset is Asset => asset?.media_type === "image");
  const latestOutputs = latest ? outputsOf(latest) : [];
  /* A cancelled or failed run with no picture leaves no dark placeholder behind: the examples take its place. */
  const deadRun = !!latest && latestOutputs.length === 0 && ["canceled", "cancelled", "failed"].includes(latest.state);
  const developState = useDevelopPreview(workspace.id, latest);
  const develop = latest ? developPresentation(latest.state, developState,
    `/api/v1${workspacePath(workspace.id, `runs/${encodeURIComponent(latest.id)}/preview`)}?v=${developState?.seq ?? 0}`) : undefined;
  /** One run as a grid: as many tiles as images were asked for, in the run's own aspect ratio. */
  const [viewing, setViewing] = useState<Asset | null>(null);
  const [sheet, setSheet] = useState<{ run: Run; items: ContactSheetItem[]; caption: string } | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [details, setDetails] = useState<Run | null>(null);
  async function cancelLatest() {
    if (!latest || !onCancel || canceling || canCancelRun?.(latest) === false) return;
    setCanceling(true); setCancelError("");
    try { await onCancel(latest); }
    catch (error) { setCancelError((error as Error).message); }
    finally { setCanceling(false); }
  }
  const [lightDirection, setLightDirection] = useState("from the front");
  const [lightTemperature, setLightTemperature] = useState("golden");
  const [characters, setCharacters] = useState<CharacterRecord[]>([]);
  const [pickerPort, setPickerPort] = useState("");
  const referencePorts = manifest.inputs.filter(isCharacterPort);
  useEffect(() => {
    const request = batchContext?.call;
    if (!request || !referencePorts.length) return;
    let current = true;
    void request<CharacterRecord[]>(characterPath(workspace.id, project.id))
      .then((list) => { if (current) setCharacters(list.filter((record) => record.projectId === project.id)); })
      .catch(() => { /* The picker stays hidden; choosing a project picture still works. */ });
    return () => { current = false; };
  }, [batchContext?.call, workspace.id, project.id, manifest.id]);
  /** Saved characters this project may put on a port, each with the binding the run will carry. */
  const characterChoices = (portId: string) => {
    const port = manifest.inputs.find((item) => item.id === portId);
    if (!port) return [];
    return characters.flatMap((record) => {
      try { return [{ record, binding: characterReferenceBinding(record, port, project.id) }]; }
      catch { return []; }
    });
  };
  const chooseCharacter = (portId: string, binding: ElementInputBinding) => {
    const inputs = { ...draft.inputs };
    delete inputs[portId];
    onDraftChange({ ...draft, inputs, elementInputs: { ...draft.elementInputs, [portId]: binding } });
    setPickerPort("");
  };
  const relight = manifest.id === "flux2-klein-relight";
  const [relightSheet, setRelightSheet] = useState(false);
  const anglesRoute = manifest.id === "flux2-klein-angles" || manifest.id === "qwen-image-21-angles";
  const angleBatchMode=anglesRoute&&!!batchContext;
  const sweepRoute=manifest.id === "flux2-klein-angles"&&!!batchContext;
  const geometryRoute=anglesRoute&&!!batchContext;
  const actionEnabled=angleBatchMode?!!angleAction?.enabled:status.enabled;
  const actionBusy=angleBatchMode?!!angleAction?.busy:busy;
  const actionHint=angleBatchMode?(!actionEnabled&&readiness.state!=="ready"?readiness.reasons[0]??"Choose a ready worker.":angleAction?.hint??"Choose a source image and select angles."):status.text;
  const lightTemperatures = [
    { id: "candle", label: "Candle" },
    { id: "tungsten", label: "Tungsten" },
    { id: "golden", label: "Golden" },
    { id: "daylight", label: "Daylight" },
    { id: "blue-hour", label: "Blue hour" },
  ];
  const lightSource = imageAssets.find((asset) => asset.id === draft.inputs?.[imageInputs[0]?.id ?? ""]);
  const editAsset = (asset: Asset) => { location.hash = `imageedit/${asset.id}`; };
  const openSheet = (run: Run) => {
    const outputs = outputsOf(run);
    if (!outputs.length) return;
    const c = run.invocation?.controls ?? {};
    const asked = Math.max(1, Number(c.batch_size ?? 1) || 1);
    const items: ContactSheetItem[] = outputs.map((asset, index) => ({
      src: assetUrl(workspace.id, asset.id),
      label: asset.name || `Image ${index + 1}`,
    }));
    const state = RUN_LABELS[run.state] ?? run.state;
    setSheet({
      run,
      items,
      caption: outputs.length < asked ? `${outputs.length} of ${asked} images · ${state.toLowerCase()}` : `${outputs.length} image${outputs.length === 1 ? "" : "s"} · ${state.toLowerCase()}`,
    });
  };
  const runGrid = (run: Run, live?: typeof develop) => {
    const outputs = outputsOf(run);
    const c = run.invocation?.controls ?? {};
    const asked = Math.max(1, Number(c.batch_size ?? draft.controls.batch_size ?? 1) || 1);
    const done = ["succeeded", "failed", "canceled"].includes(run.state);
    const count = done ? Math.max(outputs.length, 1) : Math.max(asked, outputs.length);
    const w = Number(c.width ?? draft.controls.width) || 0;
    const h = Number(c.height ?? draft.controls.height) || 0;
    const label = RUN_LABELS[run.state] ?? run.state;
    return (
      <ResultGrid count={count} aspect={w && h ? w / h : 0} label={`Images of run ${run.id}`}>
        {Array.from({ length: count }, (_, i) => {
          const asset = outputs[i];
          return asset ? (
            <ResultTile key={asset.id} onOpen={() => setViewing(asset)} actions={<>
              <IconButton label="Open full view" onClick={() => setViewing(asset)}><Maximize2 size={14} /></IconButton>
              <IconButton label="Edit this image" onClick={() => editAsset(asset)}><Pencil size={14} /></IconButton>
              {onUseInVideo&&<Button variant="ghost" onClick={()=>onUseInVideo(asset.id)}>Use in video</Button>}
            </>}><img src={assetUrl(workspace.id, asset.id)} alt={asset.name} /></ResultTile>
          ) : (
            <ResultTile key={`slot-${i}`} develop={live} status={done ? <StatusText tone="warn">{label}</StatusText> : <ShimmerText>{label}</ShimmerText>}
              actions={onRetake && (run.state === "failed" || run.state === "canceled") ? <Button variant="secondary" disabled={busy} onClick={() => onRetake(run)}>Retake</Button> : undefined} />
          );
        })}
      </ResultGrid>
    );
  };
  const title = manifest.title.split(" (")[0];
  const activePreset = manifest.presets.find((preset) => preset.id === draft.presetId);
  const changeControl = (id: string, value: string | number | boolean) =>
    onDraftChange({ ...draft, controls: { ...draft.controls, [id]: value } });
  const generate = () => {
    if(angleBatchMode){if(angleAction?.enabled)angleAction.invoke();return;}
    if (!status.enabled) return;
    if (!relight) { onGenerate(draft); return; }
    const temperature = lightTemperatures.find((item) => item.id === lightTemperature)?.label ?? lightTemperature;
    const note = `Light direction: ${lightDirection}. Light temperature: ${temperature}.`;
    const prompt = String(draft.controls.prompt ?? "").trim();
    onGenerate({ ...draft, controls: { ...draft.controls, prompt: `${prompt}\n\n${note}`.trim() } });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    handleImageStudioShortcut(event.nativeEvent, actionEnabled, generate);
  };

  return (
    <form className="cf-image-studio" onSubmit={(event) => event.preventDefault()} onKeyDown={onKeyDown}>
      <WorkflowDescription title={manifest.title}><Meta>{manifest.description}</Meta></WorkflowDescription>
      <Page>
        {(cancelError || latest?.state === "failed") && <Notice priority={30} title={cancelError ? "Cancellation failed" : "Image generation failed"}
          actions={<>{latest?.state === "failed" && onRetake && <Button variant="secondary" disabled={busy} onClick={() => onRetake(latest)}>Retake</Button>}{latest && <Button variant="ghost" onClick={() => setDetails(latest)}>Details</Button>}</>}>
          {cancelError || latest?.error || "The worker did not produce an image. The original assets are unchanged."}
        </Notice>}
        <Split>
          <Panel
            footer={
              <>
                <HintButton id={hintId}>
                  <StatusText tone={actionEnabled ? "ok" : readiness.state === "ready" ? "idle" : "warn"}>{actionHint}</StatusText>
                  <Meta parts={["Ctrl+Enter to generate", manifest.version]} />
                </HintButton>
                <GenerateButton
                  busy={actionBusy}
                  disabled={actionBusy}
                  aria-disabled={!actionBusy && !actionEnabled}
                  aria-describedby={!actionEnabled ? hintId : undefined}
                  label={angleBatchMode?angleAction?.label??"Generate angles":"Generate image"}
                  onClick={generate}
                />
                {relight&&subjectRelightAvailable&&lightSource&&<Button variant="secondary" disabled={busy} onClick={()=>{
                  const temperature=lightTemperatures.find(item=>item.id===lightTemperature)?.label??lightTemperature;
                  try{const handoff=subjectRelightSchema.parse({version:1,workspaceId:workspace.id,projectId:project.id,assetId:lightSource.id,prompt:subjectRelightInstruction(manifest,draft,lightDirection,temperature)});sessionStorage.setItem(subjectRelightKey(workspace.id,project.id,lightSource.id),JSON.stringify(handoff));location.hash=`imageedit/${lightSource.id}/relight`;}catch{toast("The subject relight request could not be prepared. Check the instructions and browser storage, then try again.");}
                }}>Relight subject</Button>}
              </>
            }
          >
            <Block label="Image workflow">
              {modelOptions&&modelOptions.length>1&&onModel?<TeamChoice variant="model" label="Model" display={title} subtitle={workerName ?? "Local ComfyUI"} value={manifest.id} options={modelOptions} onChange={onModel}/>:<ModelCard title={title} subtitle={workerName ?? "Local ComfyUI"} />}
              {workspace.role !== "viewer" && <LinkButton variant="ghost" href={`#nodes/feature/${manifest.id}`}>Edit in nodes</LinkButton>}
              {imageInputs.map((port) => {
                const selected = imageAssets.find((asset) => asset.id === draft.inputs?.[port.id]);
                const bound = draft.elementInputs?.[port.id];
                const character = bound ? characters.find((record) => record.elementId === bound.elementId) : undefined;
                const choices = isCharacterPort(port) ? characterChoices(port.id) : [];
                return (
                  <Fragment key={port.id}>
                    <Row
                      label={port.label}
                      display={character?.name ?? selected?.name ?? "Choose from project"}
                      value={draft.inputs?.[port.id] ?? ""}
                      options={[{ value: "", label: "Choose from project" }, ...imageAssets.map((asset) => ({ value: asset.id, label: asset.name || asset.id }))]}
                      onChange={(assetId) => onDraftChange({ ...draft, inputs: { ...draft.inputs, [port.id]: assetId }, elementInputs: withoutPort(draft.elementInputs, port.id) })}
                      disabled={busy}
                    />
                    {choices.length > 0 && <Toolbar>
                      <Button variant="secondary" disabled={busy} onClick={() => setPickerPort(port.id)}>{bound ? "Change character" : "Use saved character"}</Button>
                      {bound && <Button variant="ghost" disabled={busy} onClick={() => onDraftChange({ ...draft, elementInputs: withoutPort(draft.elementInputs, port.id) })}>Remove character</Button>}
                    </Toolbar>}
                  </Fragment>
                );
              })}
              {imageInputs.length > 0 && imageAssets.length === 0 && <Meta>Generate or upload an image in this project first.</Meta>}
              {anglesRoute ? (!angleBatchMode&&(
                <Row label="Single angle" display={manifest.presets.find(preset=>preset.id===draft.presetId)?.title??"Choose an angle"} value={draft.presetId??""} options={manifest.presets.map(preset=>({value:preset.id,label:preset.title}))} disabled={busy} onChange={presetId=>onDraftChange({...draft,presetId})}/>
              )) : manifest.presets.length > 0 && (
                <>
                  <Row
                    label="Preset"
                    display={activePreset?.title ?? "None"}
                    value={draft.presetId ?? ""}
                    options={[{ value: "", label: "None" }, ...manifest.presets.map((preset) => ({ value: preset.id, label: preset.title }))]}
                    onChange={(presetId) => onDraftChange({ ...draft, presetId: presetId || undefined })}
                    disabled={busy}
                  />
                  {typeof activePreset?.values.prompt === "string" && <Meta>{activePreset.values.prompt}</Meta>}
                </>
              )}
              {controls.filter(control=>control.id==="prompt").map((control) => (
                <ControlField
                  key={control.id}
                  control={control}
                  disabled={busy}
                  value={draft.controls[control.id]}
                  onChange={(value) => changeControl(control.id, value)}
                />
              ))}
              {imageInputs.length===0&&onModel&&modelOptions?.some(o=>o.value==="flux2-klein-edit")&&<Button variant="secondary" onClick={()=>onModel("flux2-klein-edit")}>Start from a picture or references</Button>}
              {controls.some(control=>control.id!=="prompt")&&<Button variant="secondary" onClick={()=>setAdvanced(true)}>Advanced settings</Button>}
              <Dialog open={advanced} title="Advanced" onClose={()=>setAdvanced(false)} footer={<Button variant="primary" onClick={()=>setAdvanced(false)}>Done</Button>}>
                {controls.filter(control=>control.id!=="prompt").map(control=><ControlField key={control.id} control={control} disabled={busy} value={draft.controls[control.id]} onChange={value=>changeControl(control.id,value)}/>)}
              </Dialog>
            </Block>
          </Panel>
          <div className="cf-split-main">
          <ToolHero kind={/angle/.test(manifest.id) ? "angles" : /relight/.test(manifest.id) ? "relight" : /edit|inpaint/.test(manifest.id) ? "imageedit" : "picture"} />
          <Canvas
            toolbarStart={<SectionHeader title="Result" />}
            toolbarEnd={
              <>
                <Meta>{title}</Meta>
                {latest && onCancel && canCancelRun?.(latest) !== false && ["pending", "submitting", "submission_unknown", "queued", "running"].includes(latest.state) &&
                  <Button variant="secondary" disabled={canceling} onClick={() => void cancelLatest()}>Cancel</Button>}
                {latest && <StatusText tone={runTone(latest.state)}>{RUN_LABELS[latest.state] ?? latest.state}</StatusText>}
                {latest && latestOutputs.length > 0 && <Button variant="secondary" onClick={() => openSheet(latest)}>Contact sheet</Button>}
                {latest && (
                  <InfoButton title="Run details">
                    <Meta parts={[`Run ${latest.id}`, latest.transport === "sdk" ? `SDK proxy job ${latest.remote_id ?? "unknown"}` : "Native ComfyUI", ...outputsOf(latest).map((o) => o.sha256 && `SHA-256 ${o.sha256}`)]} />
                  </InfoButton>
                )}
              </>
            }
          >
            {anglesRoute&&<Block label={manifest.id==="qwen-image-21-angles"?"45° angle shots":"45° angle guides"}>
              <Meta>Generative reshots from a new camera angle, not a 3D orbit.</Meta>
              {angleBatchMode?<AngleBatchPanel manifest={manifest} draft={draft} workspace={workspace} project={project} {...batchContext!} runs={imageRuns} disabled={externalBusy||readiness.state!=="ready"} onBusy={setBatchBusy} onUseInVideo={onUseInVideo} onAction={setAngleAction}/>:<CameraAngleSheet source={{src:lightSource?assetUrl(workspace.id,lightSource.id):undefined}} items={manifest.presets.map(preset=>({id:preset.id,label:preset.title}))} selected={draft.presetId?[draft.presetId]:[]} multiple={false} disabled={busy} onChange={ids=>onDraftChange({...draft,presetId:ids[0]})}/>}
            </Block>}
            {sweepRoute&&<Block label="Nearby views · approximate">
              <Meta>Lateral camera moves for nearby angles. This is parallax, not a 45° orbit; keep to the two frames closest to the original.</Meta>
              <AngleSweepPanel workspace={workspace} project={project} userId={batchContext.userId} workerId={batchContext.workerId} call={batchContext.call} sourceAssetId={draft.inputs?.[manifest.inputs.find(port=>port.type==="image")?.id??""]} disabled={externalBusy||readiness.state!=="ready"} onChanged={batchContext.onChanged}/>
            </Block>}
            {geometryRoute&&<Block label="True angles · 3D geometry">
              <TrueAnglesPanel workspace={workspace} project={project} userId={batchContext.userId} workerId={batchContext.workerId} call={batchContext.call} sourceAssetId={draft.inputs?.[manifest.inputs.find(port=>port.type==="image")?.id??""]} disabled={externalBusy||readiness.state!=="ready"} onChanged={batchContext.onChanged}/>
            </Block>}
            {relight && (
              <Block label="Relight stage">
                <Flashlight
                  src={lightSource ? assetUrl(workspace.id, lightSource.id) : undefined}
                  alt={lightSource?.name ?? "Selected source image"}
                  direction={lightDirection}
                  temperature={lightTemperature}
                  temperatures={lightTemperatures}
                  onDirectionChange={setLightDirection}
                  onTemperatureChange={setLightTemperature}
                />
              </Block>
            )}
            {relight && lightSource && (() => {
              // Relit takes of the chosen source, newest first; the run keeps its own inputs and preset.
              const sourcePort = imageInputs[0]?.id ?? "";
              const takes = imageRuns.filter((run) => run.state === "succeeded" && runInputs[run.id]?.inputs?.[sourcePort] === lightSource.id && outputsOf(run)[0]).slice(0, 6);
              if (!takes.length) return null;
              const before = assetUrl(workspace.id, lightSource.id), after = assetUrl(workspace.id, outputsOf(takes[0])[0].id);
              const label = (run: Run) => { const preset = runInputs[run.id]?.presetId; return [manifest.presets.find((p) => p.id === preset)?.title ?? "Custom light", run.take ? `Take ${run.take}` : null].filter(Boolean).join(" · "); };
              return <Block label="Before and after">
                <CompareWipe before={before} after={after} beforeLabel="Original" afterLabel={label(takes[0])} />
                {takes.length > 1 && <Button variant="secondary" onClick={() => setRelightSheet(true)}>Compare takes</Button>}
                <Dialog wide open={relightSheet} title="Relight takes" onClose={() => setRelightSheet(false)} footer={<Button variant="secondary" onClick={() => setRelightSheet(false)}>Close</Button>}>
                  <ContactSheet items={[{ src: before, label: "Original" }, ...takes.map((run) => ({ src: assetUrl(workspace.id, outputsOf(run)[0].id), label: label(run) }))]} fileName="relight-takes.png" />
                </Dialog>
              </Block>;
            })()}
            {(() => {
              // Swap check: the inputs this run really used, then its result. Only for routes with reference images.
              const refs = imageInputs.filter((port) => port.id.startsWith("reference_image"));
              const run = imageRuns.find((r) => r.state === "succeeded" && outputsOf(r)[0] && runInputs[r.id]);
              if (!refs.length || !run) return null;
              const used = runInputs[run.id]?.inputs ?? {};
              const target = imageInputs.find((port) => !port.id.startsWith("reference_image"));
              const items = [
                ...(target && used[target.id] ? [{ src: assetUrl(workspace.id, used[target.id]), label: "Scene" }] : []),
                ...refs.filter((port) => used[port.id]).map((port, i) => ({ src: assetUrl(workspace.id, used[port.id]), label: `Reference ${i + 1}` })),
                { src: assetUrl(workspace.id, outputsOf(run)[0].id), label: run.take ? `Result · Take ${run.take}` : "Result" },
              ];
              return items.length > 2 ? <Block label="Swap check"><CompareStrip label="Swap check" items={items} /></Block> : null;
            })()}
            <Block label="Generated image">
              {latest && !deadRun ? (
                <>
                  {runGrid(latest, develop)}
                  {latest.error && <Meta>{latest.error}</Meta>}
                </>
              ) : (
                <Meta>No image yet. Generate one, or start from the examples below.</Meta>
              )}
              {older.length > 0 && (
                <Collapsible title={`History · ${older.length} run${older.length === 1 ? "" : "s"}`}>
              {older.map((run) => {
                const outputs = outputsOf(run);
                return (
                  <HistoryItem
                    key={run.id}
                    media={runGrid(run)}
                    model={title}
                    prompt={promptFor(run)}
                    meta={<Meta parts={[manifest.id, run.capability_version, `Run ${run.id}`, run.transport === "sdk" ? `SDK proxy job ${run.remote_id ?? "unknown"}` : "Native ComfyUI", outputs[0]?.sha256 && `SHA-256 ${outputs[0].sha256}`]} />}
                    details={<Meta parts={[outputs[0]?.content_type, outputs.length > 1 && `${outputs.length} images`]} />}
                    actions={outputs.length > 0 ? <Button variant="secondary" onClick={() => openSheet(run)}>Contact sheet</Button> : undefined}
                    date={new Date(run.created_at).toLocaleString()}
                  />
                );
              })}
                </Collapsible>
              )}
            </Block>
            {latestOutputs.length === 0 && <ExampleTiles kind="image" />}
          </Canvas>
          </div>
        </Split>
      </Page>
      <MediaViewer open={!!viewing} src={viewing ? assetUrl(workspace.id, viewing.id) : ""} name={viewing?.name ?? ""} onClose={() => setViewing(null)} onActivate={() => viewing && editAsset(viewing)}
        />
      <Dialog wide open={!!sheet} title="Contact sheet" onClose={() => setSheet(null)} footer={<Button variant="secondary" onClick={() => setSheet(null)}>Close</Button>}>
        {sheet ? (
          <ContactSheet
            items={sheet.items}
            title={`${title} · contact sheet`}
            fileName={`contact-sheet${sheet.run.scene != null && sheet.run.shot != null ? `-sc${sheet.run.scene}-sh${sheet.run.shot}` : ""}.png`}
            caption={sheet.caption}
          />
        ) : null}
      </Dialog>
      <Dialog open={!!details} title="Run details" onClose={() => setDetails(null)} footer={<Button variant="secondary" onClick={() => setDetails(null)}>Close</Button>}>
        {details && <Meta parts={[RUN_LABELS[details.state] ?? details.state, details.error, `Run ${details.id}`, details.transport === "sdk" && `SDK proxy job ${details.remote_id ?? "unknown"}`]} />}
      </Dialog>
      <Dialog open={!!pickerPort} title="Choose a character" onClose={() => setPickerPort("")} footer={<Button onClick={() => setPickerPort("")}>Close</Button>}>
        <ThumbGrid label="Saved characters">{characterChoices(pickerPort).map(({ record, binding }) => (
          <div key={record.id}>
            <Thumb src={assetUrl(workspace.id, binding.assetId)} label={record.name} onSelect={() => chooseCharacter(pickerPort, binding)} />
            <Meta>{record.name}</Meta>
          </div>
        ))}</ThumbGrid>
      </Dialog>
    </form>
  );
}
