import {insertReferenceMention} from "../team/prompt-reference";
import {inferLightGuide,relightPrompt} from "./relight-prompt";
import {resolveImageReference} from "./image-reference";
import {ExampleTiles} from "../team/ExampleTiles";
import {promoStillForImage,SQUAREHEAD_EXAMPLE_IMAGES} from "../team/reels";
import {routeTask} from "../capabilities/tasks";
import {TeamChoice,type TeamChoiceOption} from "../team/TeamChoice";
import {ToolHero} from "../team/heroes";
import {LibraryButton} from "../team/LibraryChoice";
import {ProductionContent} from "../team/ProductionWorkspace";
import {SourceCredit,WorkflowDescription} from "../team/workflow-info";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Clapperboard, Images, Maximize2, Pencil, RectangleHorizontal, Trash2 } from "lucide-react";
import { countOptions, frameControls } from "../capabilities/frame-controls";
import type { CapabilityManifestV2, Control, Readiness } from "../capabilities/types";
import { UploadSlot, Block, Canvas, ConfirmDialog, GenerateButton, HintButton, Meta, ModelCard, Notice, Panel, PanelSection, ParamButton, Params, PromptField, Button, ContactSheet, Dialog, Flashlight, IconButton, InfoButton, MediaViewer, MediaViewerInfo, ResultGrid, ResultTile, CameraAngleSheet, useToast, Row, SectionHeader, StatusText, TextField, Thumb, ThumbGrid, Toolbar, type ContactSheetItem, CompareWipe, LinkButton } from "../ds";
import {AngleBatchPanel} from "./AngleBatchPanel";
import {IdentityPhotoset} from "./IdentityPhotoset";
import {useRunInputs} from "./use-run-inputs";
import type {AngleBatchAction} from "./angle-batch-action";
import { assetUrl, workspacePath, type Call, type Asset, type Project, type Run, type Workspace, type CharacterRecord } from "../team/api";
import { characterPath } from "../team/characters/state";
import { activeRun, type ElementInputBinding } from "../team/state";
import {RunDevelop} from "../team/RunDevelop";
import {
  bypassFiboPromptEnhancer,
  characterReferenceBinding,
  handleImageStudioShortcut,
  imageControls,
  imageDraftIssues,
  imageGenerateStatus,
  isCharacterPort,
  type ImageDraft,
} from "./image-state";
import "./image.css";
import "../ds/reference-tag.css";

export type ImageStudioProps = {
  sharedFeed?: ReactNode;
  sharedCreate?: boolean;
  createModelIds?: string[];
  adStudio?: boolean;
  remixStudio?: boolean;
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
  onUseInStoryboard?: (assetId:string)=>void;
  /** The image models to choose from; a click on the model card opens them. */
  modelOptions?: TeamChoiceOption[];
  onModel?: (id:string,inputs?:Record<string,string>)=>void;
  batchContext?: {userId:string;workerId:string;call:Call;onChanged:()=>void;photosetAllowed?:boolean};
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

/** Include angle jobs found by the batch panel before the shared run list refreshes. */
export function mergeImageRuns(listed:Run[],known:Run[],capabilityId:string):Run[]{
  const result=new Map(listed.filter(run=>run.capability_id===capabilityId).map(run=>[run.id,run]));
  for(const run of known){
    if(run.capability_id!==capabilityId)continue;
    const existing=result.get(run.id);
    if(!existing||run.updated_at>existing.updated_at)result.set(run.id,run);
  }
  return [...result.values()];
}

export function createStartTarget(fileCount:number,models:TeamChoiceOption[],currentModel?:string):string|null{
  if(fileCount>0&&fileCount<=4&&currentModel?.startsWith("pruna-p-h3-")&&models.some(option=>option.value==="pruna-p-h3-edit"))return "pruna-p-h3-edit";
  // Several pictures need reference inputs, which only Fibo has; one picture takes the routed editor.
  const target=fileCount>1?models.find(option=>option.value==="fibo2-edit")?.value:routeTask("image.edit",models.map(option=>({id:option.value})))?.pack.id;
  return fileCount>0&&target?target:null;
}

export function createStartInputs(assetIds:string[]):Record<string,string>{
  const ids=assetIds.slice(0,4);
  if(!ids.length)return {};
  return Object.fromEntries([
    ["source_image",ids[0]],
    ids[1]&&["reference_image",ids[1]],
    ids[2]&&["reference_image_2",ids[2]],
    ids[3]&&["reference_image_3",ids[3]],
  ].filter((entry):entry is [string,string]=>!!entry));
}

export function toggleCreateReferenceSelection(selected:string[],assetId:string,max=4):string[]{
  if(selected.includes(assetId))return selected.filter(id=>id!==assetId);
  return selected.length<max?[...selected,assetId]:selected;
}

function runTone(state: string): "idle" | "active" | "ok" | "warn" {
  if (["queued", "submitting", "running", "submission_unknown"].includes(state)) return "active";
  if (state === "succeeded") return "ok";
  return state === "failed" ? "warn" : "idle";
}

/** The same bindings without this port, so a port never keeps a character it no longer shows. */
function withoutPort(bindings: ImageDraft["elementInputs"], port: string): ImageDraft["elementInputs"] {
  const next = { ...bindings };
  delete next[port];
  return next;
}

/** Megapixels read as "1 MP"; a named size keeps its own words. */
const sizeText=(id:string,value:unknown)=>id==="megapixels"&&Number.isFinite(Number(value))?`${value} MP`:String(value);

function ControlField({
  control,
  value,
  disabled,
  onChange,
  textareaRef,
}: {
  textareaRef?:RefObject<HTMLTextAreaElement>;
  control: Control;
  value: string | number | boolean | undefined;
  disabled: boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  if (control.id === "prompt" || control.type === "string") {
    return (
      <PromptField
        textareaRef={control.id==="prompt"?textareaRef:undefined}
        tokens={control.id==="prompt"?["@Image 1","@Image 2","@Image 3","@Image 4"]:undefined}
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
  /* A whole number with a short range (Images 1-4) is a choice, not a field to type into. */
  if (control.type === "integer" && control.min !== undefined && control.max !== undefined && control.max - control.min <= 8) {
    const options = Array.from({ length: control.max - control.min + 1 }, (_, index) => control.min! + index);
    const selected = (typeof value === "number" ? value : Number(control.default ?? control.min)) as number;
    return <Row disabled={disabled} label={control.label} display={String(selected)} value={selected} options={options.map((option) => ({ value: option, label: String(option) }))} onChange={onChange} />;
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
  adStudio = false,
  remixStudio = false,
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
  onUseInStoryboard,
  sharedCreate = false,
  createModelIds = [],
  sharedFeed,
  modelOptions,
  onModel,
}: ImageStudioProps) {
  const toast=useToast();
  const promptArea=useRef<HTMLTextAreaElement>(null);
  const [advanced,setAdvanced]=useState(false);
  const [batchBusy,setBatchBusy]=useState(false);
  const [angleAction,setAngleAction]=useState<AngleBatchAction|null>(null);
  const [angleKnownRuns,setAngleKnownRuns]=useState<Run[]>([]);
  const [angleSubmittingCount,setAngleSubmittingCount]=useState(0);
  const [createPickerOpen,setCreatePickerOpen]=useState(false);
  const [createPickerSelection,setCreatePickerSelection]=useState<string[]>([]);
  const currentDraft=useRef(draft); currentDraft.current=draft;
  const requests=useRef<Record<string,number>>({});
  const scope=useRef('');
  const scopeKey=`${workspace.id}/${project.id}/${manifest.id}`;
  if(scope.current!==scopeKey){scope.current=scopeKey;requests.current={};}
  useEffect(()=>{scope.current=scopeKey;return ()=>{if(scope.current===scopeKey)scope.current='';};},[scopeKey]);
  const beginRequest=(key:string)=>{const next=(requests.current[key]??0)+1;requests.current[key]=next;return next;};
  const isCurrent=(key:string,request:number,originalScope:string)=>scope.current===originalScope&&requests.current[key]===request;
  const busy=externalBusy||batchBusy;
  async function startFromAssets(assetIds:string[],additional:Asset[]=[]){
    if(!onModel||!assetIds.length)return;
    const target=createStartTarget(assetIds.length,modelOptions??[],manifest.id);
    if(!target){toast(assetIds.length>1?"The available image models cannot use multiple references.":"Image editing is unavailable right now.");return;}
    const request=beginRequest('create'),originalScope=scope.current;
    try{
      await Promise.all(assetIds.map(id=>resolveImageReference(id,[...additional,...assets],workspace.id,project.id,batchContext?.call)));
      if(!isCurrent('create',request,originalScope))return;
      setCreatePickerOpen(false);setCreatePickerSelection([]);onModel(target,createStartInputs(assetIds));
    }catch(error){if(isCurrent('create',request,originalScope))toast((error as Error).message);}
  }
  /* Text-to-image has no image input. One picture starts a simple edit; two to four
     become a source plus real Qwen reference inputs when that model is available. */
  async function startFromPictures(chosen:File[]){
    if(!batchContext||!onModel)return;
    const files=chosen.slice(0,4);
    if(!files.length)return;
    const target=createStartTarget(files.length,modelOptions??[],manifest.id);
    if(!target){toast(files.length>1?"The available image models cannot use multiple references.":"Image editing is unavailable right now.");return;}
    setBatchBusy(true);
    try{
      const uploaded:Asset[]=[];
      for(const file of files){
        const form=new FormData();form.append("file",file);
        uploaded.push(await batchContext.call<Asset>(workspacePath(workspace.id,`assets?projectId=${encodeURIComponent(project.id)}`),"POST",form));
      }
      batchContext.onChanged();await startFromAssets(uploaded.map(asset=>asset.id),uploaded);
    }catch(e){toast((e as Error).message);}
    finally{setBatchBusy(false);}
  }
  const hintId = useId();
  const controls = imageControls(manifest);
  /* Size and time of the result stay in the panel's row, never in Advanced (rule 66). */
  const frame=frameControls(manifest),imageSizeControl=frame.size,aspectControl=frame.aspect,countControl=frame.count;
  /* Megapixels are left at the workflow's default: the picture's shape is chosen as its Resolution, a named size
     (cloud models) stays a choice. */
  const shownSize=!sharedCreate&&imageSizeControl&&imageSizeControl.id!=="megapixels"?imageSizeControl:undefined;
  const valueOf=(control:Control)=>(draft.controls[control.id]??control.default??control.options?.[0]??control.min??"") as string|number;
  const imageInputs = manifest.inputs.filter((port) => port.type === "image");
  // Show every occupied port and at most one next empty port, including restored drafts with gaps.
  const lastImageInput = imageInputs.reduce((last,port,index)=>draft.inputs?.[port.id]||draft.elementInputs?.[port.id]?index:last,-1);
  const visibleImageInputs = imageInputs.slice(0,Math.min(imageInputs.length,Math.max(1,lastImageInput+2)));
  function mentionImage(index:number){const area=promptArea.current,prompt=String(draft.controls.prompt??""),inserted=insertReferenceMention(prompt,area?.selectionStart??prompt.length,area?.selectionEnd??prompt.length,`@Image ${index+1}`);onDraftChange({...draft,controls:{...draft.controls,prompt:inserted.value}});requestAnimationFrame(()=>{promptArea.current?.focus();promptArea.current?.setSelectionRange(inserted.caret,inserted.caret);});}
  const imageAssets = assets.filter((asset) => asset.media_type === "image");
  const issues = imageDraftIssues(manifest, draft);
  const status = imageGenerateStatus(readiness, issues, busy);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const listedImageRuns = runs.filter((run) => sharedCreate ? createModelIds.includes(run.capability_id) : run.capability_id === manifest.id);
  const imageRuns = sharedCreate ? listedImageRuns : mergeImageRuns(listedImageRuns,angleKnownRuns,manifest.id);
  const activeImageRuns=imageRuns.filter(run=>activeRun(run.state));
  const activeImageGeneration=activeImageRuns.length>0;
  const latest = imageRuns[0];
  const runInputs = useRunInputs(workspace.id, imageRuns);
  const outputsOf = (run: Run) => run.output_ids.map((id) => assetsById.get(id)).filter((asset): asset is Asset => asset?.media_type === "image" && asset.metadata?.libraryHidden !== true);
  const latestOutputs = latest ? outputsOf(latest) : [];
  /* Results are files, not run records: removed and empty outputs never become gray cards. */
  const visibleRuns = imageRuns.filter((run) => outputsOf(run).length > 0);
  /* Results and history are one gallery: newest runs first, every real image equal. */
  const resultItems = visibleRuns.flatMap((run) => outputsOf(run).map((asset) => ({ run, asset })));
  const [viewing, setViewing] = useState<Asset | null>(null);
  const viewingRun=resultItems.find(item=>item.asset.id===viewing?.id)?.run;
  const viewingInputs=useRunInputs(workspace.id,viewingRun?[viewingRun]:[],1);
  const [deleteAsset,setDeleteAsset]=useState<Asset|null>(null),[deleting,setDeleting]=useState(false),[deleteError,setDeleteError]=useState("");
  const [sheet, setSheet] = useState<{ run: Run; items: ContactSheetItem[]; caption: string } | null>(null);
  const [canceling, setCanceling] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [details, setDetails] = useState<Run | null>(null);
  async function cancelRun(run: Run) {
    if (!onCancel || canceling || canCancelRun?.(run) === false || run.state === "cancel_requested") return;
    setCanceling(run.id); setCancelError("");
    try { await onCancel(run); }
    catch (error) { setCancelError((error as Error).message); }
    finally { setCanceling(""); }
  }
  const [guideDirection, setGuideDirection] = useState<string>();
  const [guideTemperature, setGuideTemperature] = useState<string>();
  const inferredLight=inferLightGuide(String(draft.controls.prompt??""));
  const lightDirection=guideDirection??inferredLight.direction,lightTemperature=guideTemperature??inferredLight.temperature;
  const [characters, setCharacters] = useState<CharacterRecord[]>([]);
  const [pickerPort, setPickerPort] = useState("");
  const [imagePickerPort, setImagePickerPort] = useState("");
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
    beginRequest(portId);
    const current=currentDraft.current,inputs = { ...current.inputs };
    delete inputs[portId];
    const next={ ...current, inputs, elementInputs: { ...current.elementInputs, [portId]: binding } };
    currentDraft.current=next;onDraftChange(next);
    setPickerPort("");
  };
  const chooseImage = async (portId: string, assetId: string, known?:Asset) => {
    const request=beginRequest(portId),originalScope=scope.current;
    try{
      await resolveImageReference(assetId,known?[known,...assets]:assets,workspace.id,project.id,batchContext?.call);
      if(!isCurrent(portId,request,originalScope))return;
      const current=currentDraft.current;
      const next={ ...current, inputs: { ...current.inputs, [portId]: assetId }, elementInputs: withoutPort(current.elementInputs, portId) };
      currentDraft.current=next;onDraftChange(next);
      setImagePickerPort("");
    }catch(error){if(isCurrent(portId,request,originalScope))toast((error as Error).message);}
  };
  const uploadImage = async (portId: string, file: File | null) => {
    const request=beginRequest(portId),originalScope=scope.current;
    if (!file) {
      const current=currentDraft.current,inputs = { ...current.inputs }; delete inputs[portId];
      const next={ ...current, inputs, elementInputs: withoutPort(current.elementInputs, portId) };
      currentDraft.current=next;onDraftChange(next);
      return;
    }
    if (!batchContext) { toast("Uploading is unavailable right now."); return; }
    setBatchBusy(true);
    try {
      const form = new FormData(); form.append("file", file);
      const asset = await batchContext.call<Asset>(workspacePath(workspace.id, `assets?projectId=${encodeURIComponent(project.id)}`), "POST", form);
      batchContext.onChanged();
      if(isCurrent(portId,request,originalScope))await chooseImage(portId, asset.id,asset);
    } catch (error) { toast((error as Error).message); }
    finally { setBatchBusy(false); }
  };
  const relight = manifest.id === "flux2-klein-relight";
  const [relightSheet, setRelightSheet] = useState(false);
  const anglesRoute = manifest.id === "flux2-klein-angles" || manifest.id === "qwen-image-21-angles";
  const angleBatchMode=anglesRoute&&!!batchContext;
  const actionEnabled=angleBatchMode?!!angleAction?.enabled:status.enabled;
  const actionBusy=busy||activeImageGeneration||(angleBatchMode&&!!angleAction?.busy);
  const actionHint=angleBatchMode?(!actionEnabled&&readiness.state!=="ready"?readiness.reasons[0]??"Choose a ready worker.":angleAction?.hint??"Choose a source image and select angles."):status.text;
  const lightTemperatures = [
    { id: "auto", label: "From prompt" },
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
  const title = manifest.title.split(" (")[0];
  const changeControl = (id: string, value: string | number | boolean) =>
    onDraftChange({ ...draft, controls: { ...draft.controls, [id]: value } });
  const generate = () => {
    if(angleBatchMode){if(angleAction?.enabled)angleAction.invoke();return;}
    if (!status.enabled) return;
    const cleanDraft = anglesRoute ? draft : { ...draft, presetId: undefined };
    if (!relight) { onGenerate(cleanDraft); return; }
    const prompt = String(draft.controls.prompt ?? "").trim();
    const temperature=guideTemperature&&guideTemperature!=="auto"?lightTemperatures.find(item=>item.id===guideTemperature)?.label:undefined;
    onGenerate({ ...cleanDraft, controls: { ...cleanDraft.controls, prompt: relightPrompt(prompt,guideDirection,temperature), improve_prompt: false } });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    handleImageStudioShortcut(event.nativeEvent, actionEnabled, generate);
  };

  return (
    <form className="cf-image-studio" onSubmit={(event) => event.preventDefault()} onKeyDown={onKeyDown}>
      <WorkflowDescription title={manifest.title}><Meta>{manifest.description}</Meta><SourceCredit credit={manifest.credit}/></WorkflowDescription>
      <div className="cf-production">
        {(cancelError || latest?.state === "failed") && <Notice priority={30} title={cancelError ? "Cancellation failed" : "Image generation failed"}
          actions={<>{latest?.state === "failed" && onRetake && <Button variant="secondary" disabled={busy} onClick={() => onRetake(latest)}>Retake</Button>}{latest && <Button variant="ghost" onClick={() => setDetails(latest)}>Details</Button>}</>}>
          {cancelError || latest?.error || "The worker did not produce an image. The original assets are unchanged."}
        </Notice>}
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
                  label={actionBusy?"Generating…":angleBatchMode?angleAction?.label??"Generate angles":"Generate image"}
                  onClick={generate}
                />
              </>
            }
          >
            <Block label="Image workflow">
              {modelOptions&&modelOptions.length>1&&onModel?<TeamChoice variant="model" label="Model" display={title} subtitle={workerName ?? "Local ComfyUI"} image={promoStillForImage(manifest.id,adStudio,remixStudio)} value={manifest.id} options={modelOptions} onChange={onModel}/>:<ModelCard title={title} subtitle={workerName ?? "Local ComfyUI"} image={promoStillForImage(manifest.id,adStudio,remixStudio)} />}
              {workspace.role !== "viewer" && <LinkButton variant="ghost" href={`#nodes/feature/${manifest.id}`}>Edit in nodes</LinkButton>}
              {sharedCreate&&controls.filter(control=>control.id==="prompt").map((control) => (
                <ControlField key={control.id} control={control} textareaRef={promptArea} disabled={busy} value={draft.controls[control.id]} onChange={(value) => changeControl(control.id, value)} />
              ))}
              <div className={visibleImageInputs.length>1?"cf-image-input-grid":"cf-image-input-list"}>
              {visibleImageInputs.map((port) => {
                const selected = imageAssets.find((asset) => asset.id === draft.inputs?.[port.id]);
                const bound = draft.elementInputs?.[port.id];
                const imageAssetId = selected?.id ?? bound?.assetId;
                const character = bound ? characters.find((record) => record.elementId === bound.elementId) : undefined;
                const choices = isCharacterPort(port) ? characterChoices(port.id) : [];
                return (
                  <div className="cf-image-input" key={port.id} onClickCapture={event=>{if(imageAssetId&&!busy&&event.target instanceof HTMLImageElement){event.preventDefault();event.stopPropagation();mentionImage(imageInputs.findIndex(input=>input.id===port.id));}}}>
                    <UploadSlot
                      label={character?.name ?? (selected ? port.label : `Add ${port.label.toLowerCase()}`)}
                      hint={selected ? selected.name : "Drop a picture or choose from project"}
                      accept="image/png,image/jpeg,image/webp"
                      kinds={["image"]}
                      preview={imageAssetId ? assetUrl(workspace.id, imageAssetId) : undefined}
                      previewKind="image"
                      tile={visibleImageInputs.length>1}
                      removeLabel={`Remove ${port.label.toLowerCase()}`}
                      onAsset={(assetId) => chooseImage(port.id, assetId)}
                      disabled={busy}
                      onFile={(file) => void uploadImage(port.id, file)}
                    />
                    {imageAssetId&&<Button variant="ghost" className="cf-image-reference-tag" disabled={busy} aria-label={`Insert @Image ${imageInputs.findIndex(input=>input.id===port.id)+1} into prompt`} title="Insert into prompt" onClick={()=>mentionImage(imageInputs.findIndex(input=>input.id===port.id))}>@Image {imageInputs.findIndex(input=>input.id===port.id)+1}</Button>}
                    <LibraryButton chosen={!!imageAssetId} disabled={busy} onClick={()=>setImagePickerPort(port.id)}/>
                    {choices.length > 0 && <Toolbar>
                      <Button variant="secondary" disabled={busy} onClick={() => setPickerPort(port.id)}>{bound ? "Change character" : "Use saved character"}</Button>
                      {bound && <Button variant="ghost" disabled={busy} onClick={() => onDraftChange({ ...draft, elementInputs: withoutPort(draft.elementInputs, port.id) })}>Remove character</Button>}
                    </Toolbar>}
                  </div>
                );
              })}
              </div>
              {imageInputs.length > 0 && imageAssets.length === 0 && <Meta>Generate or upload an image in this project first.</Meta>}
              {!sharedCreate&&controls.filter(control=>control.id==="prompt").map(control=><ControlField key={control.id} control={control} textareaRef={promptArea} disabled={busy} value={draft.controls[control.id]} onChange={value=>changeControl(control.id,value)}/>)}
              {anglesRoute&&<PanelSection label="Angles">
                {angleBatchMode
                  ? <AngleBatchPanel manifest={manifest} draft={draft} workspace={workspace} project={project} {...batchContext!} runs={listedImageRuns} disabled={externalBusy||readiness.state!=="ready"} onBusy={setBatchBusy} onChanged={batchContext.onChanged} onAction={setAngleAction} onKnownRuns={setAngleKnownRuns} onSubmittingCount={setAngleSubmittingCount}/>
                  : <CameraAngleSheet compact source={{src:lightSource?assetUrl(workspace.id,lightSource.id):undefined}} items={manifest.presets.map(preset=>({id:preset.id,label:preset.title}))} selected={draft.presetId?[draft.presetId]:[]} multiple={false} disabled={busy} onChange={ids=>onDraftChange({...draft,presetId:ids[0]})}/>
                }
              </PanelSection>}
              {(adStudio||remixStudio)&&["fibo2-edit","qwen-image-21-edit","flux2-klein-edit"].includes(manifest.id)&&batchContext&&<IdentityPhotoset variant={adStudio?"ad":remixStudio?"remix":"character"} key={`${workspace.id}:${project.id}:${manifest.id}:${batchContext.workerId}:${adStudio?"ad":remixStudio?"remix":"character"}`} manifest={manifest} draft={draft} workspaceId={workspace.id} projectId={project.id} userId={batchContext.userId} workerId={batchContext.workerId} allowed={!!batchContext.photosetAllowed} disabled={externalBusy||readiness.state!=="ready"} call={batchContext.call} onChanged={batchContext.onChanged} onBusy={setBatchBusy}/>}
              {adStudio&&<LinkButton variant="ghost" href="#video/storyboard">Assemble shots in Storyboard</LinkButton>}
              {relight&&<PanelSection label="Light">
                <Flashlight compact src={lightSource ? assetUrl(workspace.id, lightSource.id) : undefined} alt={lightSource?.name ?? "Selected source image"} direction={lightDirection} temperature={lightTemperature} temperatures={lightTemperatures} onDirectionChange={setGuideDirection} onTemperatureChange={setGuideTemperature}/>
                <Meta>Guide is approximate; the written prompt defines the scene and light.</Meta>
              </PanelSection>}
              {imageInputs.length===0&&onModel&&batchContext&&!!createStartTarget(1,modelOptions??[])&&<><UploadSlot label="Add a reference" hint="Up to 4: one picture, or one plus 3 references" accept="image/png,image/jpeg,image/webp" kinds={["image"]} disabled={busy} multiple onAsset={assetId=>startFromAssets([assetId])} onFiles={files=>void startFromPictures(files)} onFile={file=>{if(file)void startFromPictures([file]);}}/><LibraryButton disabled={busy} onClick={()=>setCreatePickerOpen(true)}/></>}
              {!anglesRoute&&!relight&&(sharedCreate||shownSize||aspectControl||countControl)&&<Params>{sharedCreate&&!aspectControl&&<ParamButton<string> title="Aspect ratio (not available for this model)" icon={<RectangleHorizontal size={16}/>} disabled label="Source ratio" value="Source ratio" options={[]} onChange={()=>{}}/>}{aspectControl&&<ParamButton<string|number> title={aspectControl.label} icon={<RectangleHorizontal size={16}/>} disabled={busy} label={String(valueOf(aspectControl))} value={valueOf(aspectControl)} options={(aspectControl.options??[]).map(value=>({value,label:String(value)}))} onChange={value=>changeControl(aspectControl.id,value)}/>}{shownSize&&<ParamButton<string|number> title="Size" icon={<Maximize2 size={16}/>} disabled={busy} label={sizeText(shownSize.id,draft.controls[shownSize.id]??shownSize.default??"Choose size")} value={(draft.controls[shownSize.id]??shownSize.default??"") as string|number} options={(shownSize.options??[]).map(value=>({value,label:sizeText(shownSize.id,value)}))} onChange={value=>changeControl(shownSize.id,value)}/>}{sharedCreate&&!countControl&&<ParamButton<number> title="Image count (not available for this model)" icon={<Images size={16}/>} disabled label="1 image" value={1} options={[]} onChange={()=>{}}/>}{countControl&&<ParamButton<number> title={countControl.label} icon={<Images size={16}/>} disabled={busy} label={`${Number(valueOf(countControl))} ${Number(valueOf(countControl))===1?"image":"images"}`} value={Number(valueOf(countControl))} options={countOptions(countControl).map(value=>({value,label:String(value)}))} onChange={value=>changeControl(countControl.id,Number(value))}/>}</Params>}
              {!anglesRoute&&!relight&&controls.some(control=>control.id!=="prompt"&&!frame.ids.includes(control.id)&&(!sharedCreate||control.id==="seed"))&&<Row subtle label="Advanced settings" display="Optional controls" disabled={busy} onClick={()=>setAdvanced(true)}/>}
              <Dialog className="ds-advanced-dialog" open={advanced} title="Advanced" onClose={()=>setAdvanced(false)} footer={<Button variant="primary" onClick={()=>setAdvanced(false)}>Done</Button>}>
                {bypassFiboPromptEnhancer(manifest,draft)&&<Meta>Prompt enhancement is off while using references, so your instructions reach the image model directly.</Meta>}
                {controls.filter(control=>control.id!=="prompt"&&!frame.ids.includes(control.id)&&(!sharedCreate||control.id==="seed")).map(control=><ControlField key={control.id} control={control} disabled={busy} value={draft.controls[control.id]} onChange={value=>changeControl(control.id,value)}/>)}
              </Dialog>
            </Block>
          </Panel>
          <ProductionContent>
          {sharedFeed ? <>{angleSubmittingCount>0&&<ResultGrid count={angleSubmittingCount} aspect={0} label="Submitting images">{Array.from({length:angleSubmittingCount},(_,index)=><ResultTile key={index} develop={{label:"Submitting",active:true}}/>)}</ResultGrid>}{sharedFeed}</> : <><ToolHero kind={sharedCreate ? "picture" : remixStudio ? "remix" : adStudio ? "ad" : /angle/.test(manifest.id) ? "angles" : /relight/.test(manifest.id) ? "relight" : /edit|inpaint/.test(manifest.id) ? "imageedit" : "picture"} />
          <Canvas
            toolbarStart={<SectionHeader title="Result" />}
            toolbarEnd={
              <>
                {latest && onCancel && canCancelRun?.(latest) !== false && ["pending", "submitting", "submission_unknown", "queued", "running"].includes(latest.state) &&
                  <Button variant="secondary" disabled={!!canceling} onClick={() => void cancelRun(latest)}>Cancel</Button>}
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
            {(resultItems.length > 0 || activeImageRuns.length > 0 || angleSubmittingCount > 0) && <Block label="Generated images">
              <ResultGrid count={resultItems.length+activeImageRuns.length+angleSubmittingCount} aspect={0} label="Generated images">
                {Array.from({length:angleSubmittingCount},(_,index)=><ResultTile key={`submitting:${index}`} develop={{label:"Submitting",active:true}}/>)}
                {activeImageRuns.map(run=><RunDevelop key={`active:${run.id}`} workspaceId={workspace.id} run={run} cancelling={canceling===run.id||run.state==="cancel_requested"} onCancel={onCancel&&canCancelRun?.(run)!==false&&run.state!=="cancel_requested"?()=>void cancelRun(run):undefined}/>)}
                {resultItems.map(({run,asset}) => <ResultTile key={`${run.id}:${asset.id}`} dragAsset={{id:asset.id,url:assetUrl(workspace.id,asset.id),contentType:asset.content_type}} onOpen={() => setViewing(asset)} actions={<>
                  {workspace.role!=="viewer"&&batchContext&&<IconButton label="Delete image" onClick={()=>{setDeleteError("");setDeleteAsset(asset);}}><Trash2 size={14}/></IconButton>}
                  <IconButton label="Open full view" onClick={() => setViewing(asset)}><Maximize2 size={14} /></IconButton>
                  <IconButton label="Edit this image" onClick={() => editAsset(asset)}><Pencil size={14} /></IconButton>
                  {onUseInStoryboard&&<IconButton label="Add to storyboard" onClick={()=>onUseInStoryboard(asset.id)}><Clapperboard size={14}/></IconButton>}
                  {onUseInVideo&&<Button variant="ghost" onClick={()=>onUseInVideo(asset.id)}>Use in video</Button>}
                </>}><img draggable={false} src={assetUrl(workspace.id,asset.id)} alt={asset.name}/></ResultTile>)}
              </ResultGrid>
            </Block>}
            <ExampleTiles kind="image" imageSources={[...SQUAREHEAD_EXAMPLE_IMAGES,...(promoStillForImage(sharedCreate?"flux2-klein-t2i":manifest.id,adStudio,remixStudio)?[promoStillForImage(sharedCreate?"flux2-klein-t2i":manifest.id,adStudio,remixStudio)!]:[])]} caption="Illustration" />
          </Canvas></>}
          </ProductionContent>
      </div>
      <ConfirmDialog open={!!deleteAsset} title="Delete this image?" text="Remove this image from the library and results." confirmLabel="Delete image" busy={deleting} error={deleteError} onCancel={()=>{if(!deleting)setDeleteAsset(null);}} onConfirm={()=>{if(!deleteAsset||!batchContext||deleting)return;setDeleting(true);setDeleteError("");void batchContext.call(workspacePath(workspace.id,`assets/${encodeURIComponent(deleteAsset.id)}`),"DELETE").then(()=>{setDeleteAsset(null);batchContext.onChanged();}).catch(error=>setDeleteError((error as Error).message)).finally(()=>setDeleting(false));}}/>
      <MediaViewer open={!!viewing} src={viewing ? assetUrl(workspace.id, viewing.id) : ""} name={viewing?.name ?? ""} onClose={() => setViewing(null)} onActivate={() => viewing && editAsset(viewing)} info={viewingRun?<MediaViewerInfo model={viewingRun.capability_id===manifest.id?title:viewingRun.capability_id} inputs={Object.entries(viewingInputs[viewingRun.id]?.inputs??{}).filter(([,id])=>!!id).map(([port,id])=>({src:assetUrl(workspace.id,id),label:port.replaceAll("_"," ")}))} prompt={String(viewingInputs[viewingRun.id]?.controls?.prompt??"")} date={new Date(viewingRun.created_at).toLocaleString()}/>:undefined}
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
      <Dialog open={!!imagePickerPort} title="Choose from library" onClose={() => setImagePickerPort("")} footer={<Button variant="secondary" onClick={() => setImagePickerPort("")}>Close</Button>}>
        {imageAssets.length > 0 && <ThumbGrid label="Project images">
          {imageAssets.map((asset) => <Thumb key={asset.id} src={assetUrl(workspace.id, asset.id)} label={asset.name} onSelect={() => chooseImage(imagePickerPort, asset.id)} />)}
        </ThumbGrid>}
        {!imageAssets.length&&<Meta>No project images yet. Upload one from the image field.</Meta>}
      </Dialog>
      <Dialog wide open={createPickerOpen} title="Add source and references" onClose={()=>{setCreatePickerOpen(false);setCreatePickerSelection([]);}} footer={<><Button variant="ghost" onClick={()=>{setCreatePickerOpen(false);setCreatePickerSelection([]);}}>Cancel</Button><Button variant="primary" disabled={!createPickerSelection.length||busy} onClick={()=>startFromAssets(createPickerSelection)}>{createPickerSelection.length?`Use ${createPickerSelection.length} image${createPickerSelection.length===1?"":"s"}`:"Select images"}</Button></>}>
        <Meta>The first selected image is the starting point. The next three are references.</Meta>
        {imageAssets.length?<ThumbGrid label="Library images">{imageAssets.map(asset=><Thumb key={asset.id} src={assetUrl(workspace.id,asset.id)} label={asset.name} selected={createPickerSelection.includes(asset.id)} disabled={createPickerSelection.length>=4&&!createPickerSelection.includes(asset.id)} onSelect={()=>setCreatePickerSelection(current=>toggleCreateReferenceSelection(current,asset.id))}/>)}</ThumbGrid>:<Meta>No project images yet. Upload images above.</Meta>}
      </Dialog>
    </form>
  );
}
