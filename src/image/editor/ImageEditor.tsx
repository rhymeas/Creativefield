import type {ImageEditEntry} from "../../team/navigation";
import {alphaBounds,dragLayerTransform,applyLayerTransform,transformCorner,trimLayerToContent,type TransformHandle,type TransformPoint} from "./free-transform";
import "../../ds/modify-controls.css";
import {cloneLayerMask,effectiveLayerMaskKey} from "./layer-mask";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, ArrowUpRight, Brush, Paintbrush, Crop, Eraser, FlipHorizontal2, Hand, ImagePlus, Lasso, Maximize2, Move, Pipette, Pencil, Plus, Redo2, Square, Folder, FolderOpen, Contrast, Grid3x3, Lock, SlidersHorizontal, ScanSearch, Link, SquarePlus, Menu as MenuIcon, SquareDashed, Trash2, Undo2, WandSparkles, ZoomIn , X} from "lucide-react";
import { MediaPickerDialog, DropTarget, chooseDeviceFiles,
  AnnotationEditor, ActionBar, CommandBar, ContextMenu, Working, clipboardFile, DockStack, DockPanel, DockTabs, FloatingPanel, FxIcon, InlineSelect, InlineSlider, LabeledRow, MenuButton, Block, Button, ColorPicker, ForegroundBackground, Canvas, Checkbox, InfoButton, ShortcutSheet, type ShortcutGroup, OptionsBar, StatusBar, TextField, Dialog, EmptyState, IconButton, LayerList, LayerRow, Meta, Page, PanelSection, PromptField,
  ContactSheet,
  Notice, Badge, CropHandles, TransformHandles, ParamButton, Row, SegmentedTabs, SliderField, Split, Stage, Swatches, Thumb, ThumbGrid, ToolRail, Toolbar, UploadSlot, useToast, Progress,
  useMediaEditor,
} from "../../ds";
import { assetUrl, workspacePath, type Asset, type AssetPage, type Call, type Project, type Run, type Workspace, type CharacterRecord } from "../../team/api";
import {QuickUpscaleLaunch} from "./QuickUpscaleLaunch";
import {characterEditBindings,identityReferenceInstruction,identityReferenceSheetInstruction,type CharacterEditBindings} from "./character-references";
import {referenceSheetCanvas} from "./reference-sheet";
import {characterPath} from "../../team/characters/state";
import {CHARACTER_DRAG_TYPE,characterDropId,characterPlacementRect,characterPlacementInstruction} from "./character-placement";
import {swapCheckProvenance,swapCheckProvenanceName} from "./swap-check-provenance";
import {usePlacementDraft} from "./use-placement-draft";
import type { CapabilityManifestV2 } from "../../capabilities/types";
import {
  BLENDS, BLEND_LABELS, CROPS, addImageLayer, addPaintLayer, commit, commitContinuous, duplicateLayer, emptyDoc, flipLayer, moveLayer, redo, removeLayer,
  replace, alignLayer, mergeInto, moveLayerToEdge, selectLayer, selectedLayer, startHistory, toLayerPoint, undo, updateLayer, updateGroup, type AlignTo, type Blend, type GroupBlend, type CropId, type Doc, type History, type Layer,
} from "./doc";
import { blankCanvas, cloneBitmap, getBitmap, loadBitmap, setBitmap, sizeOf } from "./bitmaps";
import { filterChannels, layerCanvas, renderDoc, type Channels } from "./render";
import { AI_BUSY, AI_LABELS, aiInstruction, aiLayerName, selectionInstruction, padRect, requestsObjectRemoval, requestsObjectResize, resolveEditMode, resolveEditScope, type EditScope, type EditIntent, type AiMode, type Rect } from "./ai";
import {annotationCropInstruction,annotationGuide,annotationInstruction,annotationsInCrop,annotationStorageKey,imageAnnotationsSchema,type ImageAnnotation} from "../annotations";
import {editInstructionFor,mapAnnotationReferenceMentions,modifyReferenceBindings,selectionGuideFor} from "./modify-references";
import {insertReferenceMention,usesH3Prompt} from "../../team/prompt-reference";
import {plainProblem} from "../../team/problems";
import {readSubjectRelight,subjectRelightKey} from "../subject-relight";
import {annotationMatte} from "./annotation-matte";
import {prefillRemoval} from "./remove-prefill";
import {addAiResultLayer,cutoutModifiedResult,drawModifiedResult,featheredModifyMatte,freezeModifyMatte,harmonizePatch,resizePatchMatte,type ModifyMatte} from "./ai-layer";
import {createBrushStroke,compositeBrushStroke,brushEdgeBlur,paintSuperSoftRound,type BrushStroke} from "./brush-stroke";
import {useDocuments} from "./use-documents";
import {RecentDocuments} from "./RecentDocuments";
import {mergeLayerIds,smartObjectIds,createSmartObject,applySmartContents,type MergeMode} from "./layer-actions";
import {drawSelectionShimmer,maskOutlinePath,OUTLINE_FRAME_MS,OUTLINE_PHASES} from "./mask-outline";
import {cropViewport,exposedBorder,hasExposedBorder,normalizeViewport,scaleViewport} from "./crop-extend";
import {QUICK_SELECT_FIRST,quickSelectPlan,sameRegion,hitObject,imageSignature,type ObjectRegion} from "./region-tools";
import { cropHandleAt, dragCrop, fullCrop, isFullCrop, type CropHandle, type CropRect } from "./crop";
import { ADJUSTMENTS, addAdjustLayer, aiCropRect, type AdjustKind, groupLayers, groupSelectionState, groupAncestors, isGroupDescendant, moveWithLinks, reorderLayer, isVisible, ratioOf, resetAdjustment, toggleGroup, ungroupGroup, ungroupLayer, type Locks } from "./doc";
import { groupMergeSource } from "./layer-actions";
import { allShape, selectionInLayerSpace, selectLayerPixels, cropSelectionMask, applyMaskToLayer, combine, eraseRegionMask, featheredMask, featheredMaskOutside, ratioPoint, selectionBounds, editSelected, invertSelection, lassoShape, marqueeRect, maskBitmap, rectShape, tinted, wandShape, type SelectMode } from "./selection";
import "./editor.css";
import { channelPixels, type PreviewChannel } from "./channel-preview";
import { reorderVisible } from "../../ds/dock-layout";
import {DETAIL_TILE_PX, detailShare, featherTile, guardedPatch, MIN_DETAIL_SHARE, planQuickTiles, tileDetail, visibleDocumentRect, type QuickTile} from "./quick-upscale";
import type {PreservationRecord} from "../../capabilities/edit-preservation";
import {PrecisionReview,type PrecisionResult} from "./PrecisionReview";
import {cancelReferenceEdit,finishReferenceEdit,referenceEditFor} from "../../team/reference-return";

type DockId = "ai" | "layers" | "properties";
const DOCK_IDS: DockId[] = ["ai", "layers", "properties"];
type DockState = { order: DockId[]; collapsed: Partial<Record<DockId, boolean>> };
const DOCK_KEY = "cf-editor-dock-v2";
function readDock(): DockState {
  try {
    const v = JSON.parse(localStorage.getItem(DOCK_KEY) ?? "null");
    if (v && Array.isArray(v.order) && v.order.length === DOCK_IDS.length && DOCK_IDS.every((id) => v.order.includes(id))) return { order: v.order, collapsed: v.collapsed ?? {} };
  } catch { /* storage unavailable: defaults */ }
  return { order: [...DOCK_IDS], collapsed: {} };
}

type Tool = "hand" | "move" | "brush" | "maskBrush" | "eraser" | "magicEraser" | "rect" | "lasso" | "wand" | "subject" | "crop" | "eyedropper" | "zoom";
type BrushStyle = "round-hard" | "round-soft" | "round-super-soft" | "square-hard" | "square-soft" | "grain";
/* Stamp approach inspired by common open-source raster brush engines (Easy-Brush, MIT; libmypaint, ISC).
   The compact presets below are implemented locally, so no extra runtime dependency or preset asset ships here. */
const BRUSH_STYLES: Array<{ value: BrushStyle; label: string }> = [
  { value: "round-hard", label: "Hard round" },
  { value: "round-soft", label: "Soft round" },
  { value: "round-super-soft", label: "Super soft round" },
  { value: "square-hard", label: "Hard square" },
  { value: "square-soft", label: "Soft square" },
  { value: "grain", label: "Grain" },
];
const SELECT_TOOLS: Tool[] = ["rect", "lasso", "wand", "subject"];
/** Native controls and overlays own their keyboard input, including range arrows and Space. */
/** Who gets this key: text fields, sliders and open dialogs or menus keep every key; a focused button, link,
 * radio or row keeps only the keys that operate it (Space, Enter, arrows, Tab), so tool letters and Ctrl shortcuts
 * still reach the editor after a click on a layer, a button or a menu (Photoshop). Without a key: everything. */
function ownsKeyboard(target: EventTarget | null, key?: string): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (element?.isContentEditable || element?.closest('input,textarea,select,[role="slider"],[role="dialog"],[role="menu"],[data-comfy-menu]') || document.querySelector('[role="dialog"][aria-modal="true"],[data-comfy-menu]')) return true;
  if (!element?.closest('button,a[href],[role="radio"],[role="tab"],[role="option"],[tabindex]:not(canvas)')) return false;
  return key === undefined || key === " " || key === "Enter" || key === "Tab" || key.startsWith("Arrow");
}
const COLORS = ["#ffffff", "#202020", "#2fa8ff", "#f5c451", "#7ddc9b", "#f08a5d"];
/** A document as the crop geometry sees it. */
const dims = (d: Doc) => ({ w: d.width, h: d.height });

/* Shortcut reference for the Shortcuts dialog, grouped by what they do. */
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  { title: "Tools", items: [
    { keys: ["V"], label: "Move" }, { keys: ["H"], label: "Pan (or hold Space)" }, { keys: ["B"], label: "Brush" }, { keys: ["E"], label: "Eraser" },
    { keys: ["M"], label: "Rectangle" }, { keys: ["L"], label: "Lasso" }, { keys: ["W"], label: "Wand" }, { keys: ["C"], label: "Crop" },
    { keys: ["Q"], label: "Quick mask" }, { keys: ["S"], label: "Select subject (when available)" }, { keys: ["I"], label: "Eyedropper" }, { keys: ["Z"], label: "Zoom" },
  ] },
  { title: "Brush & color", items: [
    { keys: ["[", "]"], label: "Brush size" }, { keys: ["1–9", "0"], label: "Layer opacity" }, { keys: ["X"], label: "Swap colors" }, { keys: ["D"], label: "Default colors" },
    { keys: ["Ctrl+T"], label: "Free transform" }, { keys: ["R"], label: "Rotate 90°" }, { keys: ["Shift+R"], label: "Rotate âˆ’90°" }, { keys: ["Alt+click"], label: "Pick color" }, { keys: ["Shift+click"], label: "Straight line" },
  ] },
  { title: "Selection", items: [
    { keys: ["Shift"], label: "Add" }, { keys: ["Alt"], label: "Subtract" }, { keys: ["Shift+Alt"], label: "Intersect" },
    { keys: ["Shift"], label: "Square" }, { keys: ["Alt"], label: "From center" }, { keys: ["Ctrl+A"], label: "All" },
    { keys: ["Ctrl+D"], label: "Deselect" }, { keys: ["Ctrl+Shift+D"], label: "Reselect" }, { keys: ["Ctrl+Shift+I"], label: "Invert" },
  ] },
  { title: "Layers", items: [
    { keys: ["Ctrl+J"], label: "Layer via copy" }, { keys: ["Ctrl+Shift+J"], label: "Layer via cut" }, { keys: ["Ctrl+G"], label: "Group layers" }, { keys: ["Ctrl+Shift+G"], label: "Ungroup" }, { keys: ["Ctrl+E"], label: "Merge down" },
    { keys: ["Ctrl+Shift+E"], label: "Merge visible" }, { keys: ["Ctrl+["], label: "Move down" }, { keys: ["Ctrl+]"], label: "Move up" }, { keys: ["Alt+[ / ]"], label: "Select layer below / above" },
    { keys: ["Ctrl+click"], label: "Pick layer" },
  ] },
  { title: "Edit", items: [
    { keys: ["Delete"], label: "Erase selection" }, { keys: ["Alt+Backspace"], label: "Fill" }, { keys: ["Ctrl+Backspace"], label: "Fill background" },
    { keys: ["Arrows"], label: "Nudge (Shift ×10)" }, { keys: ["Ctrl+C"], label: "Copy layer" }, { keys: ["Ctrl+Shift+C"], label: "Copy merged" }, { keys: ["Ctrl+V"], label: "Paste in place" },
    { keys: ["Ctrl+Z"], label: "Undo" }, { keys: ["Ctrl+Shift+Z"], label: "Redo" },
  ] },
  { title: "View & file", items: [
    { keys: ["Ctrl+0"], label: "Fit" }, { keys: ["Ctrl+1"], label: "100%" }, { keys: ["Ctrl++", "Ctrl+âˆ’"], label: "Zoom" }, { keys: ["Wheel"], label: "Zoom with wheel" },
    { keys: ["Ctrl+S"], label: "Save" }, { keys: ["Ctrl+Shift+S"], label: "Download PNG" },
  ] },
  { title: "Mouse & gestures", items: [
    { keys: ["Shift+drag"], label: "Move on one axis" }, { keys: ["Esc"], label: "Cancel the current gesture" },
    { keys: ["Alt+â†‘", "Alt+â†“"], label: "Reorder panels" }, { keys: ["Drag"], label: "Panel grip" },
  ] },
];

const BLANKS: Array<{ id: string; label: string; w: number; h: number }> = [
  { id: "square", label: "Square 1:1", w: 1024, h: 1024 },
  { id: "wide", label: "Wide 16:9", w: 1280, h: 720 },
  { id: "tall", label: "Tall 9:16", w: 720, h: 1280 },
];

/** The ComfyUI inpaint workflow, offered only when its route is implemented and a worker is ready. */
export type InpaintRoute = { manifest: CapabilityManifestV2; workerId: string; routeId: string };
const floor8 = (n: number) => Math.max(8, Math.floor(n / 8) * 8);
const QUICK_UPSCALE_PROMPT = "Rebuild only this tile section as a photorealistic, high-detail image. Use the reference image as the whole-frame context: preserve the exact composition, framing, lighting, colours and identity, but replace blur, mush and compression with clean natural micro-detail, sharp realistic textures and crisp edges. Do not add, remove or move objects. If this tile is mostly flat colour or a smooth gradient, keep it clean and do not invent texture or details.";
const toPng = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be exported."))), "image/png"));

const shortEditModelName=(title:string)=>title
  .replace(/^Qwen Image 2\.1 guided edit$/i,"Qwen Edit")
  .replace(/^MiniMax H3 Image with references$/i,"MiniMax H3")
  .replace(/^MiniMax H3 Image$/i,"MiniMax H3")
  .replace(/\s+with references$/i,"")
  .replace(/\s+guided edit$/i,"");



export function ImageEditor({ workspace, project, userId, call, canEdit, authorized, inpaint, edit: defaultEdit, editOptions = [], segment, precision, maskedEdit, upscale, detailUpscale, openAssetId, openEntry, freeInput = false, onOpenModels, onExitSubjectRelight }: { workspace: Workspace; project: Project; userId:string; call: Call; canEdit: boolean; authorized: boolean; inpaint?: InpaintRoute; edit?: InpaintRoute; editOptions?: InpaintRoute[]; /** SAM 3.1: select parts by name. */ segment?: InpaintRoute; precision?: InpaintRoute; maskedEdit?: InpaintRoute; upscale?: InpaintRoute; /** A prompt-capable detail upscaler; falls back to the plain upscaler. */ detailUpscale?: InpaintRoute; /** An image from the Library to open right away (from Create Image). */ openAssetId?: string; openEntry?: ImageEditEntry; freeInput?: boolean; onOpenModels?:()=>void; onExitSubjectRelight?:()=>void }) {
  const [editModelId,setEditModelId]=useState(defaultEdit?.manifest.id ?? editOptions[0]?.manifest.id ?? "");
  const editModelChosen=useRef(false);
  useEffect(()=>{if(!editModelChosen.current&&defaultEdit)setEditModelId(defaultEdit.manifest.id);},[defaultEdit?.manifest.id]);
  const edit=editOptions.find(option=>option.manifest.id===editModelId) ?? defaultEdit;
  const [referenceTray,setReferenceTray]=useState(false);
  const referenceAnchor=useRef<HTMLSpanElement>(null);
  const toast = useToast();
  const [hist, setHist] = useState<History | null>(null);
  const smartSessions=useRef<Array<{history:History;layerId:string}>>([]);
  const [smartDepth,setSmartDepth]=useState(0);
  /* The crop box while the Crop tool is active. Null means the whole image; it resets when the tool or the image size changes. */
  const cropBox = useRef<CropRect | null>(null);
  const cropDrag = useRef<CropHandle | null>(null);
  const cropStart=useRef<{rect:CropRect;point:{x:number;y:number}}|null>(null);
  const [cropPreview, setCropPreview] = useState<CropRect | null>(null);
  const [tool, setTool] = useState<Tool>("move");
  const [quickMask,setQuickMask]=useState(false),[transforming,setTransforming]=useState(false);
  const quickMaskPreviousTool=useRef<Tool>("move");
  const transformSession=useRef<{history:History;tool:Tool}|null>(null);
  const transformDrag=useRef<{doc:Doc;layer:Layer;handle:TransformHandle;point:TransformPoint}|null>(null);
  const quickMaskPreview=useRef<{key:string;revision:number;color:string;canvas:HTMLCanvasElement}|null>(null);
  useEffect(() => { cropBox.current = null; cropDrag.current = null; setCropPreview(null); }, [tool, hist?.present.width, hist?.present.height]);
  function setCropBox(rect: CropRect | null) {
    cropBox.current = rect;
    setCropPreview(rect);
  }
  const [selMode, setSelMode] = useState<SelectMode>("replace");
  const [tolerance, setTolerance] = useState(32);
  const [contiguous, setContiguous] = useState(true);
  const [cropRatio, setCropRatio] = useState<CropId>("original");
  const [cropScale,setCropScale]=useState("100");
  const [panelTab, setPanelTab] = useState<"layers" | "channels">("layers");
  const [dock, setDockState] = useState<DockState>(readDock);
  /** Floating settings window for the selected layer: its adjustments or its layer style. */
  const [floating, setFloating] = useState<null | "adjust" | "style">(null);
  /** The working-color picker is independent from layer settings, so both can stay open. */
  const [colorOpen, setColorOpen] = useState(false);
  /** Extra layers selected with Shift (the primary one is doc.selectedId). */
  const [multi, setMulti] = useState<string[]>([]);
  const [altHeld, setAltHeld] = useState(false);
  const sideRef = useRef<HTMLDivElement>(null);
  const colorRef = useRef<HTMLDivElement>(null);
  const setDock = (f: (d: DockState) => DockState) => setDockState((d) => {
    const next = f(d);
    try { localStorage.setItem(DOCK_KEY, JSON.stringify(next)); } catch { /* not saved */ }
    return next;
  });
  const [channels, setChannels] = useState<Channels>({ r: true, g: true, b: true, a: true });
  const channelsRef = useRef(channels);
  const dragId = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /* The row under the pointer while a layer is dragged: it gets the drop highlight. */
  const [dropId, setDropId] = useState<string | null>(null);
  channelsRef.current = channels;
  const lastSelection = useRef<string | null>(null);
  const lastStroke = useRef<null | { layerId: string; p: { x: number; y: number } }>(null);
  const digits = useRef({ text: "", at: 0 });
  const [aiPrompt, setAiPrompt] = useState("");
  const [annotations,setAnnotations]=useState<ImageAnnotation[]>([]),[annotationSrc,setAnnotationSrc]=useState("");
  const annotationHandoff=useRef("");
  const [aiBusy, setAiBusy] = useState<AiMode | null>(null);
  const [upscaling,setUpscaling]=useState(false);
  /** A Modify, Harmonize or Fill run that ended without a result: said in the panel until the next run. */
  const [aiStop,setAiStop]=useState<{mode:AiMode;cancelled:boolean;error:string}|null>(null);
  const [quickProgress,setQuickProgress]=useState<{done:number;total:number}|null>(null);
  const [quickTiles,setQuickTiles]=useState<QuickTile[]>([]);
  /** Tiles a quick upscale left out of the model because they are flat colour (only enlarged). */
  const [quickSkipped,setQuickSkipped]=useState<number[]>([]);
  const [quickPreviews,setQuickPreviews]=useState<Array<HTMLCanvasElement|null>>([]);
  const quickAbort=useRef(false);
  const quickRun=useRef<string|null>(null);
  const [quickScale,setQuickScale]=useState<2|4>(2);
  const [editIntent,setEditIntent]=useState<EditIntent>("auto");
  const [preserveOriginal,setPreserveOriginal]=useState(false);
  const [editScope,setEditScope]=useState<EditScope>("auto");
  const subjectRelight=openEntry==="relight";
  const [selectionUnavailable,setSelectionUnavailable]=useState(false);
  const relightHandoff=useRef<string|null>(null);
  const [aiReference,setAiReference]=useState<Asset|null>(null),[referencePicker,setReferencePicker]=useState(false),[referenceBusy,setReferenceBusy]=useState(false);
  const [extraReferences,setExtraReferences]=useState<Array<Asset|null>>([null,null]);
  const [referenceSlot,setReferenceSlot]=useState(0);
  const aiPromptArea=useRef<HTMLTextAreaElement>(null);
  function mentionReference(index:number){const area=aiPromptArea.current,result=insertReferenceMention(aiPrompt,area?.selectionStart??aiPrompt.length,area?.selectionEnd??aiPrompt.length,`@Image ${index+1}`);setAiPrompt(result.value);requestAnimationFrame(()=>{aiPromptArea.current?.focus();aiPromptArea.current?.setSelectionRange(result.caret,result.caret);});}
  const [aiCharacter,setAiCharacter]=useState<CharacterRecord|null>(null);
  const [swapCheck,setSwapCheck]=useState<{source:string;reference:string;result:string;label:string;run:string}|null>(null);
  const [swapOpen,setSwapOpen]=useState(false);
  const [characterPlacement,setCharacterPlacement]=useState<string|null>(null),[placingCharacter,setPlacingCharacter]=useState(false);
  const [characterSwap,setCharacterSwap]=useState(false);
  const placementSequence=useRef(0),placementAbort=useRef<AbortController|null>(null);
  useEffect(()=>()=>{placementSequence.current++;placementAbort.current?.abort();},[workspace.id,project.id,openAssetId]);
  useEffect(()=>{setSwapCheck(null);setSwapOpen(false);},[workspace.id,project.id,openAssetId]);
  const hasReference=!!aiReference||extraReferences.some(Boolean)||!!aiCharacter;
  function chooseReference(asset:Asset,slot=referenceSlot){clearCharacterPlacement();setCharacterSwap(false);setAiCharacter(null);if(slot===0)setAiReference(asset);else setExtraReferences(previous=>previous.map((value,index)=>index===slot-1?asset:value));setPreserveOriginal(false);setReferencePicker(false);}
  const [preserveMode,setPreserveMode]=useState("replace");
  const [precisionContext,setPrecisionContext]=useState(32),[precisionFeather,setPrecisionFeather]=useState(.5);
  const layerAnchor=useRef<string|null>(null);
  const [precisionSettings,setPrecisionSettings]=useState(false);
  const [precisionRun,setPrecisionRun]=useState<Run|null>(null);
  const [precisionResult,setPrecisionResult]=useState<PrecisionResult|null>(null);
  const precisionMatte=useRef<{runId:string;matte:ModifyMatte}|null>(null);
  const [precisionOpen,setPrecisionOpen]=useState(false),[precisionError,setPrecisionError]=useState("");
  const [customOpen,setCustomOpen]=useState(false),[customW,setCustomW]=useState("1080"),[customH,setCustomH]=useState("1350");
  const precisionOpener=useRef<HTMLButtonElement>(null);
  function closePrecision(){setPrecisionOpen(false);requestAnimationFrame(()=>precisionOpener.current?.focus());}
  useEffect(()=>{
    if(!openAssetId||!authorized)return;
    const abort=new AbortController();
    void (async()=>{
      try{
        const asset=await call<Asset>(workspacePath(workspace.id,`assets/${openAssetId}`),"GET",undefined,{signal:abort.signal});
        const record=asset.metadata?.preservation as PreservationRecord|undefined;
        const generated=asset.metadata?.generatedBy as {producerRunId?:string}|undefined;
        if(asset.project_id!==project.id||record?.kind!=="klein_still_v1"||record.finalAssetId!==asset.id||!generated?.producerRunId)return;
        const run=await call<Run>(workspacePath(workspace.id,`runs/${generated.producerRunId}`),"GET",undefined,{signal:abort.signal});
        if(!abort.signal.aborted&&run.state==="succeeded"&&run.output_ids.includes(asset.id)){
          setPrecisionResult({runId:run.id,record});setPrecisionRun(run);
        }
      }catch{/* Ordinary images remain editable without a precision receipt. */}
    })();
    return()=>abort.abort();
  },[openAssetId,workspace.id,project.id,authorized,call]);
  /** The layer whose mask is being painted (click its mask thumbnail). */
  const [maskEdit, setMaskEdit] = useState<string | null>(null);
  const [collapsedGroups,setCollapsedGroups]=useState<Set<string>>(()=>new Set());
  const strokeMask = useRef(false);
  const strokeErase=useRef(false),outlineRevision=useRef(0),outlinePhase=useRef(0);
  /* Quick select analysis: idle (null) -> analysing (n of N concepts) -> ready | failed, per picture signature. */
  const [objectScan,setObjectScan]=useState<{signature:string;status:"analysing"|"ready"|"failed";done:number;total:number}|null>(null);
  const scanToken=useRef(0);
  const objectRegions=useRef<{signature:string;regions:ObjectRegion[]}|null>(null),hoveredObject=useRef(-1);
  const ringRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<null | { x: number; y: number; items: Array<{ id: string; label: string; onSelect: () => void; danger?: boolean }> }>(null);
  const [subject, setSubject] = useState("");
  const [magicMode,setMagicMode]=useState<"colour"|"semantic">("colour");
  const magicSource=useRef<{signature:string;layerId:string|null}|null>(null);
  const liveDoc=useRef<Doc|null>(null);
  const [selecting, setSelecting] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const preview = useRef<null | { kind: "rect" | "lasso"; pts: Array<{ x: number; y: number }>; rect?: { x: number; y: number; w: number; h: number }; /** Alt held: clicks add straight segments. */ poly?: boolean; rubber?: { x: number; y: number } }>(null);
  const pointerDown = useRef(false);
  const finishPoly = useRef<() => void>(() => {});
  const [brush, setBrush] = useState<{ size: number; style: BrushStyle; flow: number; hardness:number; opacity:number }>({ size: 40, style: "round-hard", flow: 100, hardness:100, opacity:100 });
  const [colors, setColors] = useState<{ fg: string; bg: string; editing: "fg" | "bg" }>({ fg: "#000000", bg: "#ffffff", editing: "fg" });
  const [bitmapsReady, setBitmapsReady] = useState(0);
  const [picker, setPicker] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const savePending = useRef(false);
  const downloadPending = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const quickOverlayRef = useRef<HTMLCanvasElement>(null);
  const outlineCanvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const view = useRef({ zoom: 1, x: 0, y: 0 });
  const [cropScreen,setCropScreen]=useState({x:0,y:0,w:0,h:0});
  const [zoomLabel, setZoomLabel] = useState(100);
  const applyView = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const v = view.current;
    c.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    if(stageRef.current){const a=c.getBoundingClientRect(),b=stageRef.current.getBoundingClientRect();setCropScreen({x:a.left-b.left,y:a.top-b.top,w:a.width,h:a.height});}
    setZoomLabel(Math.round(v.zoom * (c.clientWidth / (c.width || 1)) * 100));
  }, []);
  const fit = useCallback(() => {
    view.current = { zoom: 1, x: 0, y: 0 };
    applyView();
  }, [applyView]);
  const panning = useRef<null | { px: number; py: number; vx: number; vy: number }>(null);
  const spaceDown = useRef(false);
  const altDown = useRef(false);
  const thumbs = useRef(new Map<string, string>());
  const moveFrame = useRef<{ raf: number; dx: number; dy: number } | null>(null);
  const gesture = useRef<null | { kind: "move"; start: Doc; px: number; py: number; lx: number; ly: number } | { kind: "move-selection"; start: Doc; px:number; py:number } | { kind:"wand"; start:Doc; at:{x:number;y:number}; clientX:number; tolerance:number; mode:SelectMode } | { kind: "select"; start: Doc; mode: SelectMode; crop?: boolean } | { kind: "paint"; start: Doc; canvas: HTMLCanvasElement; surface:BrushStroke; layer: Layer; last: { x: number; y: number }; lastDoc: { x: number; y: number } }>(null);
  const brushTrail = useRef({ x: 0, y: 0, started: false, stamp: 0 });
  const pickCanvas = useRef<HTMLCanvasElement | null>(null);

  const doc = hist?.present ?? null;
  useEffect(()=>{
    if(!doc||!openEntry)return;
    const frame=requestAnimationFrame(()=>{const panel=document.querySelector<HTMLElement>('.ds-dock[aria-label="AI"]');if(panel?.hasAttribute("data-collapsed"))panel.querySelector<HTMLButtonElement>(".ds-dock__toggle")?.click();panel?.querySelector<HTMLTextAreaElement>("textarea")?.focus();});
    return()=>cancelAnimationFrame(frame);
  },[!!doc,openAssetId,openEntry]);
  useEffect(()=>{
    if(!doc||!openAssetId||openEntry!=="annotate")return;
    const key=annotationStorageKey(workspace.id,openAssetId),raw=sessionStorage.getItem(key);
    if(!raw||annotationHandoff.current===raw)return;
    try{setAnnotations(imageAnnotationsSchema.parse(JSON.parse(raw)));setEditScope("image");setEditIntent("modify");annotationHandoff.current=raw;}catch{toast("The annotations could not be restored. Draw them again.");}
  },[!!doc,openAssetId,openEntry]);
  useEffect(()=>{
    if(!doc||!openAssetId||openEntry!=="relight")return;
    let raw:string|null=null;
    try{raw=sessionStorage.getItem(subjectRelightKey(workspace.id,project.id,openAssetId));}catch{toast("The relight instructions could not be read from browser storage.");return;}
    if(raw&&relightHandoff.current===raw)return;
    const handoff=readSubjectRelight(raw,{workspaceId:workspace.id,projectId:project.id,assetId:openAssetId});
    if(!handoff){toast("The relight instructions are unavailable. Return to Relight and choose Relight subject again.");return;}
    relightHandoff.current=raw;setAiPrompt(handoff.prompt);setEditIntent("modify");setEditScope("layer");setPreserveOriginal(true);setPreserveMode("replace");setPrecisionFeather(0);setAnnotations([]);setAiReference(null);setAiCharacter(null);clearCharacterPlacement();setExtraReferences([null,null]);setSubject("person");setTool(segment?"subject":"lasso");
  },[!!doc,openAssetId,openEntry,workspace.id,project.id]);
  function openAnnotations(){if(!doc)return;const canvas=blankCanvas(doc.width,doc.height);renderDoc(canvas.getContext("2d")!,{...doc,selection:null},{background:true});setAnnotationSrc(canvas.toDataURL("image/png"));}
  liveDoc.current=doc;
  const placementDraft=usePlacementDraft({scope:{userId,workspaceId:workspace.id,projectId:project.id,assetId:openAssetId??""},doc,bitmapRevision:bitmapsReady,character:aiCharacter,placementId:characterPlacement,prompt:aiPrompt,manifest:edit?.manifest,enabled:authorized&&canEdit&&!subjectRelight,call,currentDoc:()=>liveDoc.current,onRestore:(snapshot,record,mask,prompt)=>{
    if(!alive.current||liveDoc.current!==snapshot)return;
    apply({...snapshot,selection:mask?combine(snapshot,mask,"replace"):null});setAiCharacter(record);setAiReference(null);setExtraReferences([null,null]);setAnnotations([]);setAiPrompt(prompt);setCharacterPlacement(record.id);setEditScope("layer");setEditIntent("modify");setPreserveOriginal(false);setTool("rect");toast("Placement draft restored. Review the selection before generating.");
  }});
  function clearCharacterPlacement(){placementDraft.clear();setCharacterPlacement(null);setCharacterSwap(false);}

  const layer = doc ? selectedLayer(doc) : null;
  const [documentPicker,setDocumentPicker]=useState(false);
  const [groupSettingsId,setGroupSettingsId]=useState<string|null>(null);
  function rootDocument(){let root=transformSession.current?.history.present??liveDoc.current;if(!root)return null;for(const session of [...smartSessions.current].reverse()){
      const flat=blankCanvas(root.width,root.height);renderDoc(flat.getContext("2d")!,root);const key=`bmp:recovery:${crypto.randomUUID()}`;setBitmap(key,flat);root=applySmartContents(session.history.present,session.layerId,root,key);
    }return root;}
  const documents=useDocuments({workspaceId:workspace.id,projectId:project.id,call,doc:transforming?(transformSession.current?.history.present??doc):doc,enabled:authorized&&canEdit,getRoot:rootDocument,
    onLoad:restored=>{setAnnotations([]);const previous=smartSessions.current.length?rootDocument():null;smartSessions.current=[];setSmartDepth(0);setHist(h=>h?commit(previous?startHistory(previous):h,restored):startHistory(restored));setMulti([]);setMaskEdit(null);setQuickMask(false);setTool("move");thumbs.current.clear();setDocumentPicker(false);fit();},
  });
  const documentDialog=<Dialog open={documentPicker} title="Recent documents" onClose={()=>setDocumentPicker(false)} footer={<Button variant="secondary" onClick={()=>setDocumentPicker(false)}>Close</Button>}>
    {documents.records.length
      ? <RecentDocuments records={documents.records} workspaceId={workspace.id} projectId={project.id} call={call} busy={documents.busy} onOpen={id=>void documents.open(id).catch(()=>{})}/>
      : <Meta>No saved documents or recovery drafts in this project.</Meta>}
  </Dialog>;
  /* A document problem is said once, wherever the editor shows it, with the step that retries it (rule 36). */
  const documentProblem=documents.error?plainProblem(documents.error):null;
  const documentNotice=documentProblem&&<Notice priority={60} title={documentProblem.title||"The document didn't save"} actions={<>{/document not saved|not saved/i.test(documents.error)
    ?<Button variant="secondary" disabled={documents.busy} onClick={()=>void documents.save().catch(()=>{})}>Save again</Button>
    :<Button variant="secondary" disabled={documents.busy} onClick={()=>void documents.refresh().catch(()=>{})}>Check again</Button>}</>} details={documents.error}>{documentProblem.text}</Notice>;
  const groupSettings=doc&&groupSettingsId?doc.groups?.[groupSettingsId]:undefined;
  const groupSettingsDialog=<Dialog open={!!groupSettings} title={groupSettings?.name??"Group settings"} onClose={()=>setGroupSettingsId(null)} footer={<>{canEdit&&authorized&&<Button variant="secondary" onClick={()=>{apply(ungroupGroup(doc!,groupSettingsId!));setGroupSettingsId(null);}}>Ungroup</Button>}<Button variant="secondary" onClick={()=>setGroupSettingsId(null)}>Done</Button></>}>
    {groupSettings&&<>
      <SliderField label="Group opacity" unit="%" min={0} max={100} value={Math.round((groupSettings.opacity??1)*100)} onChange={value=>applyLive(`group-opacity-${groupSettingsId!}`,d=>updateGroup(d,groupSettingsId!,{opacity:value/100}))}/>
      <InlineSelect label="Group blend" value={groupSettings.blend??"pass-through"} options={[{value:"pass-through",label:"Pass through"},...BLENDS.map(blend=>({value:blend,label:BLEND_LABELS[blend]}))]} onChange={value=>apply(updateGroup(doc!,groupSettingsId!,{blend:value as GroupBlend}))}/>
    </>}
  </Dialog>;

  const [channelThumbs, setChannelThumbs] = useState<Partial<Record<PreviewChannel, string>>>({});
  useEffect(() => {
    if (!doc || panelTab !== "channels" || dock.collapsed.layers) return;
    const composite = blankCanvas(doc.width, doc.height);
    renderDoc(composite.getContext("2d")!, doc);
    const width = Math.max(1, Math.round(64 * Math.min(1, doc.width / doc.height)));
    const height = Math.max(1, Math.round(64 * Math.min(1, doc.height / doc.width)));
    const small = blankCanvas(width, height);
    const ctx = small.getContext("2d")!;
    ctx.drawImage(composite, 0, 0, width, height);
    const source = ctx.getImageData(0, 0, width, height);
    const previews: Partial<Record<PreviewChannel, string>> = {};
    for (const channel of ["rgb", "r", "g", "b", "a"] as const) {
      ctx.putImageData(new ImageData(channelPixels(source.data, channel), width, height), 0, 0);
      previews[channel] = small.toDataURL();
    }
    setChannelThumbs(previews);
  }, [doc, bitmapsReady, panelTab, dock.collapsed.layers]);

  const refreshBitmaps = () => setBitmapsReady((v) => v + 1);

  /* Selection outlines are display-only and never tint or change exported pixels. */
  const paint = useCallback((d: Doc) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width !== d.width) canvas.width = d.width;
    if (canvas.height !== d.height) canvas.height = d.height;
    const ctx = canvas.getContext("2d")!;
    renderDoc(ctx, d);
    const outline=outlineCanvasRef.current,stage=stageRef.current;
    let outlineCtx:CanvasRenderingContext2D|null=null;
    if(outline&&stage){
      const bounds=stage.getBoundingClientRect(),image=canvas.getBoundingClientRect(),ratio=window.devicePixelRatio||1;
      const width=Math.max(1,Math.round(bounds.width*ratio)),height=Math.max(1,Math.round(bounds.height*ratio));
      if(outline.width!==width)outline.width=width;
      if(outline.height!==height)outline.height=height;
      outlineCtx=outline.getContext("2d");
      if(outlineCtx){outlineCtx.setTransform(1,0,0,1,0,0);outlineCtx.clearRect(0,0,width,height);outlineCtx.setTransform(ratio*image.width/d.width,0,0,ratio*image.height/d.height,ratio*(image.left-bounds.left),ratio*(image.top-bounds.top));}
    }
    const ch = channelsRef.current;
    if (!(ch.r && ch.g && ch.b && ch.a)) filterChannels(ctx, d.width, d.height, ch);
    if (d.selection) {
      const mask=getBitmap(d.selection),style=getComputedStyle(canvas);
      if(quickMask){
        const color=style.getPropertyValue("--accent").trim();let cached=quickMaskPreview.current;
        if(!cached||cached.key!==d.selection||cached.revision!==outlineRevision.current||cached.color!==color){const overlay=tinted(d.selection,color);cached=overlay?{key:d.selection,revision:outlineRevision.current,color,canvas:overlay}:null;quickMaskPreview.current=cached;}
        if(cached){ctx.save();ctx.globalAlpha=.24;ctx.drawImage(cached.canvas,0,0,d.width,d.height);ctx.restore();}
      }
      if(mask&&outlineCtx)drawSelectionShimmer(outlineCtx,mask,outlineRevision.current,d.width/Math.max(1,canvas.getBoundingClientRect().width),style.getPropertyValue("--accent").trim()||"#2fa8ff");
    }
    if(tool==="subject"&&objectRegions.current?.signature===imageSignature(d)&&hoveredObject.current>=0){
      const region=objectRegions.current.regions[hoveredObject.current],style=getComputedStyle(canvas);
      if(region&&outlineCtx)drawSelectionShimmer(outlineCtx,region.canvas,0,d.width/Math.max(1,canvas.getBoundingClientRect().width),style.getPropertyValue("--accent").trim()||"#2fa8ff",.6);
    }
    if (tool === "crop") {
      const box = cropBox.current ?? fullCrop(dims(d));
      const inset = Math.max(2, d.width / 500);
      const style = getComputedStyle(canvas);
      const stroke = style.getPropertyValue("--text-secondary").trim() || "#9ca3af";
      const backing = style.getPropertyValue("--surface-panel").trim() || "#131517";
      ctx.save();
      /* Dim everything outside the crop box, then outline the box and draw the handles on it. */
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, d.width, box.y);
      ctx.fillRect(0, box.y + box.h, d.width, d.height - box.y - box.h);
      ctx.fillRect(0, box.y, box.x, box.h);
      ctx.fillRect(box.x + box.w, box.y, d.width - box.x - box.w, box.h);
      ctx.strokeStyle = backing;
      ctx.lineWidth = Math.max(3, d.width / 320);
      ctx.globalAlpha = 0.65;
      ctx.strokeRect(box.x + inset, box.y + inset, box.w - inset * 2, box.h - inset * 2);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(1.5, d.width / 700);
      ctx.globalAlpha = 0.95;
      ctx.strokeRect(box.x + inset, box.y + inset, box.w - inset * 2, box.h - inset * 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = stroke;
      ctx.strokeStyle = backing;
      ctx.lineWidth = Math.max(1.5, d.width / 900);
      ctx.restore();
    }
    const shape = preview.current;
    if (shape && (shape.pts.length > 1 || shape.rect || shape.rubber)) {
      ctx.save();
      ctx.strokeStyle = "#2fa8ff";
      ctx.lineWidth = Math.max(1, d.width / 600);
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      if (shape.kind === "rect") {
        if (shape.rect) ctx.rect(shape.rect.x, shape.rect.y, shape.rect.w, shape.rect.h);
      } else {
        shape.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        if (shape.rubber) ctx.lineTo(shape.rubber.x, shape.rubber.y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }, [tool,quickMask]);
  useEffect(() => {
    if (doc) paint(doc);
  });
  useEffect(()=>{
    if(!doc?.selection||quickMask||(typeof matchMedia==="function"&&matchMedia("(prefers-reduced-motion: reduce)").matches))return;
    let frame=0,last=0;
    const animate=(time:number)=>{
      if(time-last>=OUTLINE_FRAME_MS){outlinePhase.current=(outlinePhase.current+1)%OUTLINE_PHASES;const current=liveDoc.current;if(current)paint(current);last=time;}
      frame=requestAnimationFrame(animate);
    };
    frame=requestAnimationFrame(animate);
    return()=>cancelAnimationFrame(frame);
  },[doc?.selection,quickMask,paint]);
  useEffect(() => {
    if (!doc) return;
    const canvas = pickCanvas.current ?? (pickCanvas.current = document.createElement("canvas"));
    if (canvas.width !== doc.width) canvas.width = doc.width;
    if (canvas.height !== doc.height) canvas.height = doc.height;
    renderDoc(canvas.getContext("2d")!, doc, { background: true });
  }, [doc, bitmapsReady]);
  useEffect(() => { canvasRef.current?.focus({ preventScroll: true }); }, [tool]);

  /* Wheel zooms around the cursor; the picture under the pointer stays put. */
  const hasDoc = !!hist;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(applyView);
    observer.observe(canvas);
    if(stageRef.current)observer.observe(stageRef.current);
    applyView();
    return () => observer.disconnect();
  }, [applyView, hasDoc]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const cx = event.clientX - (rect.left + rect.width / 2);
      const cy = event.clientY - (rect.top + rect.height / 2);
      const v = view.current;
      const next = Math.min(32, Math.max(0.1, v.zoom * Math.exp(-event.deltaY * 0.0015)));
      const k = next / v.zoom;
      view.current = { zoom: next, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
      applyView();
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [applyView, hasDoc]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.defaultPrevented || e.isComposing || ownsKeyboard(e.target, e.key)) return; if (e.key === "Alt") { altDown.current = true; setAltHeld(true); } if (e.code === "Space") { spaceDown.current = true; e.preventDefault(); } };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown.current = false;
      if (e.key === "Alt") { altDown.current = false; setAltHeld(false); }
      if (e.key === "Alt" && preview.current?.poly && !pointerDown.current) { e.preventDefault(); finishPoly.current(); }
    };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    const reset = () => { spaceDown.current = false; altDown.current = false; setAltHeld(false); panning.current = null; };
    addEventListener("blur", reset);
    return () => { removeEventListener("keydown", down); removeEventListener("keyup", up); removeEventListener("blur", reset); };
  }, []);

  const apply = useCallback((doc2: Doc) => {if(!transformSession.current)setHist((h) => (h ? commit(h, doc2) : startHistory(doc2)));}, []);
  /** Continuous changes (a slider) fold into one undo step. */
  const applyLive = useCallback((key: string, make: (d: Doc) => Doc) => {
    setHist((h) => {
      if (!h) return h;
      return commitContinuous(h, make(h.present), key, Date.now());
    });
  }, []);


  useEffect(() => {
    if (openAssetId && !hist) void addImage("Image", assetUrl(workspace.id, openAssetId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAssetId]);

  useEffect(() => {
    if ((!picker&&!referencePicker) || !authorized) return;
    let current = true;
    void call<AssetPage>(workspacePath(workspace.id, `assets?projectId=${project.id}`)).then((page) => {
      if (current) setAssets(page.items.filter((a) => a.media_type === "image"||a.media_type==="reference"));
    }).catch(() => {});
    return () => { current = false; };
  }, [picker,referencePicker, authorized, call, workspace.id, project.id]);

  async function addImage(name: string, src: string) {
    try {
      const { w, h } = await loadBitmap(src);
      setHist((h0) => {
        const next = addImageLayer(h0?.present ?? emptyDoc(w, h), name, src, w, h);
        return h0 ? commit(h0, next) : startHistory(next);
      });
      refreshBitmaps();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  function addFile(file: File | null) {
    if (!file) return;
    if (/\.(psd|psb)$/i.test(file.name)) {
      void (async () => {
        try {
          const {importPsd, placePsd} = await import("./import-psd");
          const imported = await importPsd(file);
          const current = liveDoc.current;
          const next = current ? placePsd(current, imported.doc) : imported.doc;
          setHist(h => current && h ? commit(h, next) : startHistory(next));
          if (!current) { setAnnotations([]); setQuickMask(false); }
          refreshBitmaps();
          toast(imported.warnings.length ? `PSD imported. ${imported.warnings.join(" ")}` : "PSD imported with layers.");
        } catch (error) { toast(`Could not import PSD: ${(error as Error).message}`); }
      })();
    } else void addImage(file.name, URL.createObjectURL(file));
  }

  function blank(w: number, h: number) {
    setAnnotations([]);
    const canvas = blankCanvas(w, h);
    const key = `bmp:blank${Date.now().toString(36)}`;
    setBitmap(key, canvas);
    const base = emptyDoc(w, h);
    const next = addPaintLayer(base, key);
    setQuickMask(false);
    setHist(startHistory({ ...next, layers: next.layers.map((l) => ({ ...l, name: "Background" })) }));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    refreshBitmaps();
  }

  async function uploadPng(canvas: HTMLCanvasElement, kind: "image" | "mask", name: string, parentId?:string, intermediate=false) {
    const form = new FormData();
    form.append("file", new File([await toPng(canvas)], name, { type: "image/png" }));
    return call<Asset>(workspacePath(workspace.id, `assets?projectId=${project.id}&kind=${kind}${parentId?`&parentId=${encodeURIComponent(parentId)}`:""}${intermediate?"&purpose=intermediate":""}`), "POST", form);
  }
  async function addReference(file:File|null,slot=referenceSlot){
    if(!file||!canEdit||!authorized||referenceBusy)return;setReferencePicker(false);setReferenceBusy(true);
    const url=URL.createObjectURL(file);
    try{const {bitmap,w,h}=await loadBitmap(url);if(w*h>67108864)throw new Error("The reference image is too large.");const c=blankCanvas(w,h);c.getContext("2d")!.drawImage(bitmap,0,0);const asset=await uploadPng(c,"image",`${file.name.replace(/\.[^.]+$/,"")}.png`);if(alive.current){chooseReference(asset,slot);}}
    catch(error){if(alive.current)toast((error as Error).message);}
    finally{URL.revokeObjectURL(url);if(alive.current)setReferenceBusy(false);}
  }
  /** A picture dropped on the Modify card or the free input becomes the next free reference (desktop file or Library
   *  asset); with all three in use it replaces the first, as a drop on the Modify card always did. */
  const dropReferenceSlot=()=>Math.max(0,[aiReference,...extraReferences].findIndex(asset=>!asset));
  function dropReferenceFiles(files:File[]){
    const file=files.find(item=>item.type.startsWith("image/"));if(!file){toast("Drop a picture as reference.");return;}
    void addReference(file,dropReferenceSlot());
  }
  function dropReferenceAsset(id:string){
    const asset=assets.find(item=>item.id===id);if(!asset||!asset.content_type.startsWith("image/")){toast("Drop a picture as reference.");return;}
    chooseReference(asset,dropReferenceSlot());
  }
  const referenceDrop={label:"Drop a picture as reference",disabled:subjectRelight||!!aiBusy||referenceBusy||!canEdit||!authorized,onFiles:dropReferenceFiles,onAsset:dropReferenceAsset};

  async function runAndWait(route: InpaintRoute, inputs: Record<string, string>, extra: Record<string, unknown>,onRun?:(run:Run)=>void,elementInputs:CharacterEditBindings={}): Promise<Run | null> {
    const controls: Record<string, unknown> = Object.fromEntries(route.manifest.controls.map((c) => [c.id, c.default]));
    Object.assign(controls, extra);
    if ("seed" in controls && typeof extra.seed!=="number") controls.seed = Math.floor(Math.random() * 2147483647);
    const run = await call<Run>(workspacePath(workspace.id, "runs"), "POST", {
      projectId: project.id, workerId: route.workerId, idempotencyKey: crypto.randomUUID(), capabilityId: route.manifest.id,
      version: route.manifest.version, routeId: route.routeId, inputs, ...(Object.keys(elementInputs).length?{elementInputs}:{}), controls, audioPolicy: "mute",
    });
    onRun?.(run);
    while (alive.current) {
      await new Promise((r) => setTimeout(r, 2000));
      const runs = await call<Run[]>(workspacePath(workspace.id, `runs?projectId=${project.id}`));
      const found = runs.find((r) => r.id === run.id);
      if(found)onRun?.(found);
      if (found && ["succeeded", "failed", "canceled"].includes(found.state)) return found;
    }
    return null;
  }

  async function runPrecision(mode:AiMode){
    if(!doc||!doc.selection||!precision||aiBusy||!canEdit||!authorized)return;
    const snapshot=doc;
    setAiBusy(mode);setPrecisionRun(null);setPrecisionResult(null);setPrecisionError("");setPrecisionOpen(true);
    try{
      if(snapshot.width%8||snapshot.height%8||snapshot.width>2048||snapshot.height>2048)
        throw new Error("Use a canvas up to 2048 pixels per side with width and height divisible by 8 for this precision workflow.");
      const matte=mode==="fill"?null:freezeModifyMatte(snapshot,mode==="harmonize"||!!snapshot.selection?"composite":"layer");
      const flat=blankCanvas(snapshot.width,snapshot.height);
      renderDoc(flat.getContext("2d")!,{...snapshot,selection:null},{background:true});
      const mask=blankCanvas(snapshot.width,snapshot.height),ctx=mask.getContext("2d")!;
      ctx.fillStyle="#000";ctx.fillRect(0,0,mask.width,mask.height);
      const white=tinted(snapshot.selection!,"#fff");if(!white)throw new Error("The selected mask is unavailable.");ctx.drawImage(white,0,0);
      const source=await uploadPng(flat,"image",`precision-original-${Date.now()}.png`);
      const painted=await uploadPng(mask,"mask",`precision-mask-${Date.now()}.png`);
      const done=await runAndWait(precision,{source_image:source.id,edit_mask:painted.id},{prompt:aiInstruction(mode,aiPrompt),mask_mode:preserveMode,context_pixels:precisionContext,feather_pct:precisionFeather},run=>{if(alive.current)setPrecisionRun(run);});
      if(!done||!alive.current)return;
      if(done.state!=="succeeded"||!done.output_ids[0])return;
      await readPrecisionResult(done,source.id,matte);
    }catch(e){if(alive.current)setPrecisionError((e as Error).message);}
    finally{if(alive.current)setAiBusy(null);}
  }
  async function readPrecisionResult(done:Run,sourceId:string,matte:ModifyMatte|null=null){
    const final=await call<Asset>(workspacePath(workspace.id,`assets/${done.output_ids[0]}`));
    const record=final.metadata?.preservation as PreservationRecord|undefined;
    if(!record||record.kind!=="klein_still_v1"||record.finalAssetId!==final.id||record.sourceAssetId!==sourceId
      ||!done.output_ids.includes(record.effectiveMaskAssetId)||!done.output_ids.includes(record.candidateAssetId))throw new Error("This run has no complete measured preservation receipt.");
    if(alive.current){precisionMatte.current=matte?{runId:done.id,matte}:null;setPrecisionResult({runId:done.id,record});}
  }
  async function retakePrecision(){
    if(!precision||!precisionRun||aiBusy||!canEdit||!authorized)return;
    const prior=precisionRun;
    const matte=precisionMatte.current?.runId===prior.id?precisionMatte.current.matte:null;
    setAiBusy("modify");setPrecisionResult(null);setPrecisionRun(null);setPrecisionError("");setPrecisionOpen(true);
    try{
      const original=await call<Run>(workspacePath(workspace.id,`runs/${prior.id}`));
      if(original.project_id!==project.id||original.capability_id!==precision.manifest.id||!original.invocation||!original.worker_id)
        throw new Error("The original precision inputs are not available in this project.");
      const done=await runAndWait({...precision,workerId:original.worker_id},original.invocation.inputs,original.invocation.controls,run=>{if(alive.current)setPrecisionRun(run);});
      if(done?.state==="succeeded"&&alive.current)await readPrecisionResult(done,original.invocation.inputs.source_image,matte);
    }catch(error){if(alive.current)setPrecisionError((error as Error).message);}
    finally{if(alive.current)setAiBusy(null);}
  }
  async function placeCharacter(value:string|CharacterRecord,point:{x:number;y:number}){
    if(!doc||!edit||subjectRelight||aiBusy||!canEdit||!authorized)return;
    const snapshot=doc,ticket=++placementSequence.current;
    placementAbort.current?.abort();const abort=new AbortController();placementAbort.current=abort;
    setPlacingCharacter(true);
    try{
      const record=typeof value==="string"?await call<CharacterRecord>(characterPath(workspace.id,project.id,value),"GET",undefined,{signal:abort.signal}):value;
      if(abort.signal.aborted||!alive.current||ticket!==placementSequence.current)return;
      characterEditBindings(record,edit.manifest,project.id);
      if(liveDoc.current!==snapshot)throw new Error("The image changed while loading the character. Place it again on the current image.");
      const rect=characterPlacementRect(snapshot.width,snapshot.height,point);
      apply({...snapshot,selection:combine(snapshot,rectShape(snapshot,rect),"replace")});
      setAiCharacter(record);setAiReference(null);setExtraReferences([null,null]);setAnnotations([]);
      setCharacterPlacement(record.id);setCharacterSwap(false);setEditIntent("modify");setEditScope("layer");setPreserveOriginal(false);setTool("rect");
      setAiPrompt(previous=>previous.trim()?previous:`Place ${record.name} naturally in this scene.`);
      toast("Character positioned. Review or refine the selection, then choose Place character.");
    }catch(error){if(!abort.signal.aborted&&alive.current&&ticket===placementSequence.current)toast((error as Error).message);}
    finally{if(alive.current&&ticket===placementSequence.current)setPlacingCharacter(false);}
  }

  async function removeSelected(){
    if(!doc?.selection||!precision||aiBusy||!canEdit||!authorized)return;
    const snapshot=doc,selection=doc.selection,signature=imageSignature(doc),bounds=selectionBounds(selection);
    if(!bounds){toast("The selection is empty.");return;}
    const region=padRect(bounds,doc.width,doc.height,.35);
    const factor=Math.min(1,2048/Math.max(region.w,region.h));
    const w=Math.max(8,Math.ceil(region.w*factor/8)*8),h=Math.max(8,Math.ceil(region.h*factor/8)*8);
    setAiBusy("fill");
    try{
      const flat=blankCanvas(doc.width,doc.height);renderDoc(flat.getContext("2d")!,{...snapshot,selection:null},{background:true});
      const crop=blankCanvas(w,h);crop.getContext("2d")!.drawImage(flat,region.x,region.y,region.w,region.h,0,0,w,h);
      const white=tinted(selection,"#fff");if(!white)throw new Error("The selected mask is unavailable.");
      const mask=blankCanvas(w,h),mc=mask.getContext("2d")!;mc.fillStyle="#000";mc.fillRect(0,0,w,h);mc.drawImage(white,region.x,region.y,region.w,region.h,0,0,w,h);
      const cc=crop.getContext("2d",{willReadFrequently:true})!,pixels=cc.getImageData(0,0,w,h);
      prefillRemoval(pixels,mc.getImageData(0,0,w,h));cc.putImageData(pixels,0,0);
      const source=await uploadPng(crop,"image",`remove-source-${Date.now()}.png`),painted=await uploadPng(mask,"mask",`remove-mask-${Date.now()}.png`);
      const done=await runAndWait(precision,{source_image:source.id,edit_mask:painted.id},{prompt:selectionInstruction(aiPrompt,true)+" Fill the blank masked region with the surrounding background. Do not add any object there; match the nearby textures, lighting and perspective.",mask_mode:"replace",context_pixels:32,feather_pct:.5});
      if(!done||!alive.current)return;
      if(done.state!=="succeeded"||!done.output_ids[0])throw new Error(done.error||"Removing the selection did not finish.");
      const final=await call<Asset>(workspacePath(workspace.id,`assets/${done.output_ids[0]}`));
      const receipt=final.metadata?.preservation as PreservationRecord|undefined;
      if(!receipt||receipt.kind!=="klein_still_v1"||receipt.sourceAssetId!==source.id||!done.output_ids.includes(receipt.candidateAssetId))throw new Error("The masked workflow did not return its aligned candidate image.");
      // KleinEditComposite may warp its final image with optical flow. The stitch
      // candidate is already aligned to the input crop; blend it here instead.
      const {bitmap}=await loadBitmap(assetUrl(workspace.id,receipt.candidateAssetId));
      if(!liveDoc.current||imageSignature(liveDoc.current)!==signature)throw new Error("The image changed. The result remains in Library; this canvas was kept unchanged.");
      const result=blankCanvas(snapshot.width,snapshot.height),ctx=result.getContext("2d")!;ctx.drawImage(bitmap,0,0,w,h,region.x,region.y,region.w,region.h);
      const soft=featheredMaskOutside(snapshot,selection,Math.max(3,Math.round(Math.min(region.w,region.h)*.035)));
      if(!soft)throw new Error("The selected mask is unavailable.");
      ctx.globalCompositeOperation="destination-in";ctx.drawImage(soft,0,0);
      const key=`bmp:remove:${crypto.randomUUID()}`;setBitmap(key,result);
      setHist(old=>old&&imageSignature(old.present)===signature?commit(old,addAiResultLayer(old.present,key,"Remove")):old);
      thumbs.current.clear();refreshBitmaps();toast("Removed selection added as a new layer");
    }catch(error){toast((error as Error).message);}finally{if(alive.current)setAiBusy(null);}
  }

  async function requestAi(mode:AiMode){
    if(annotations.length&&!subjectRelight){
      if(referenceBusy||placingCharacter){toast("Wait for the reference to finish loading.");return;}
      if(!edit){toast("A ready image edit workflow is required for annotations.");return;}
      /* Every edit model understands one box on its own crop; several boxes in one guide picture got mixed up
         (FLUX 3 Klein made the bench rusty instead of the tank). So each box is its own run, one after another,
         each on the canvas the previous one left. */
      const all=annotations;
      for(const [index,box] of all.entries()){
        const before=liveDoc.current;
        if(!await runAi("modify",[box])){if(index>0)toast(`${index} of ${all.length} annotations were applied.`);return;}
        // Wait for the new layer to render, so the next box starts from it.
        for(let wait=0;wait<40&&liveDoc.current===before;wait++)await new Promise(resolve=>setTimeout(resolve,25));
      }
      return;
    }
    if(characterSwap&&!doc?.selection){toast("Select the person to replace before swapping.");return;}
    if(placingCharacter){toast("Wait for the character reference pack to finish loading.");return;}
    if(characterPlacement){
      if(!aiCharacter||aiCharacter.id!==characterPlacement||!doc?.selection){toast("Place the character again or select its target region before generating.");return;}
      return runAi("modify");
    }
    if(subjectRelight){
      if(!precision){toast("A ready precision-edit workflow is required for subject-only relighting.");return;}
      if(!doc?.selection){toast("Select the subject before relighting. The background will stay outside the edit mask.");return;}
      if(!aiPrompt.trim()){toast("Enter the lighting change before relighting.");return;}
      return runPrecision("modify");
    }
    if(referenceBusy){toast("Wait for the reference image to finish uploading.");return;}
    // MiniMax H3 Image is chosen on purpose for edits a masked fill cannot do (glasses, expressions, materials):
    // it gets the selection crop and guide itself, and its result is blended back only inside the selection.
    const fullEditModel=!!edit&&usesH3Prompt(edit.manifest);
    if(doc?.selection&&requestsObjectRemoval(aiPrompt)&&!hasReference&&!fullEditModel){
      if(!precision){toast("A ready masked image-edit workflow is needed to remove the selection.");return;}
      return removeSelected();
    }
    const scope=resolveEditScope(editScope,aiPrompt,!!doc?.selection);
    if(mode!=="harmonize"&&scope!=="image"&&!hasReference&&!fullEditModel&&precision&&preserveOriginal&&doc?.selection)return runPrecision(mode);
    if(mode!=="harmonize"&&scope==="image"){
      if(!edit){toast("A ready whole-image edit workflow is required for this request.");return;}
      return runAi("modify");
    }
    return mode==="fill"&&!edit&&inpaint?fillWithAi():runAi(mode);
  }
  async function keepPrecision(){
    if(!precisionResult||!doc||!canEdit||!authorized)return;
    const {record}=precisionResult;
    if(doc.width!==record.qa.width||doc.height!==record.qa.height)throw new Error("The canvas size changed. Restore its original dimensions before applying this result.");
    const {bitmap}=await loadBitmap(assetUrl(workspace.id,record.finalAssetId));
    const matte=precisionMatte.current?.runId===precisionResult.runId?precisionMatte.current.matte:null;
    const result=matte?cutoutModifiedResult(bitmap,{x:0,y:0,w:doc.width,h:doc.height},matte):blankCanvas(doc.width,doc.height);
    if(!matte)result.getContext("2d")!.drawImage(bitmap,0,0);
    const key=`bmp:preserved${crypto.randomUUID()}`;setBitmap(key,result);
    setHist(h=>{
      if(!h||h.present.width!==record.qa.width||h.present.height!==record.qa.height)return h;
      return commit(h,addAiResultLayer(h.present,key,"Precision edit",matte?.bounds));
    });
    refreshBitmaps();closePrecision();toast("Applied the reviewed result as a new layer");
  }
  async function cancelPrecision(){
    if(!precisionRun)return;
    const result=await call<{state:string}>(workspacePath(workspace.id,`runs/${precisionRun.id}/cancel`),"POST");
    setPrecisionRun(old=>old?{...old,state:result.state}:old);
  }

  /** Model input may use opaque context. Modify restores the frozen element alpha
      and cropped placement; fill/harmonize retain their existing composite behavior. */
  /** `only`: the annotation boxes of this run (one at a time, see requestAi). The run starts from the
   *  canvas as it is now, so a second box builds on the first box's layer. True when a layer was added. */
  async function runAi(mode: AiMode, only?: ImageAnnotation[]) {
    const boxes=only??annotations,live=liveDoc.current??doc;
    if (!live || !edit || aiBusy || !canEdit || !authorized || (mode !== "harmonize" && !aiPrompt.trim()&&!boxes.length)) return false;
    const annotated=boxes.length>0;
    setAiStop(null);
    const wholeImage=annotated||(!characterPlacement&&mode!=="harmonize"&&resolveEditScope(editScope,aiPrompt,!!live.selection)==="image");
    const sel = wholeImage?null:live.selection;
    let runEdit=mode==="modify"&&!annotated&&sel&&edit.manifest.id==="qwen-image-21-edit"&&maskedEdit?maskedEdit:edit;
    if (mode === "fill" && !sel) return false;
    const snapshot = wholeImage?{...live,selection:null}:live;
    setAiBusy(mode);
    try {
      // One box is edited on its own crop by any model; several boxes share one crop and a guide picture.
      const singleBox=boxes.length===1;
      if(annotated&&!singleBox&&!edit.manifest.inputs.some(input=>input.id==="reference_image"))throw new Error("Choose a guided image edit workflow to apply several annotations at once.");
      if(annotated&&aiCharacter)throw new Error("Annotations and saved character packs cannot be combined in this workflow. Choose image references instead.");
      const integration=mode==="harmonize"?harmonizePatch(snapshot):null;
      let matte=annotated?annotationMatte(snapshot,boxes):mode==="fill"?null:integration?.matte??freezeModifyMatte(snapshot,wholeImage||!!characterPlacement||!!sel?"composite":"layer");
      const bounds=matte?.bounds??(sel?selectionBounds(sel):null);
      if(sel&&!bounds)return;
      const resizeSelection=!!sel&&mode==="modify"&&!annotated&&requestsObjectResize(aiPrompt);
      const region:Rect=annotated?padRect(matte!.bounds,snapshot.width,snapshot.height,0.35):integration?.region??(bounds?padRect(bounds,snapshot.width,snapshot.height,mode==="fill"||resizeSelection?0.35:0.15):{x:0,y:0,w:snapshot.width,h:snapshot.height});
      if(resizeSelection)matte=resizePatchMatte(snapshot.width,snapshot.height,region);
      // Every edit model's result fades in across the selection edge, inside and outside, so a slight tone
      // shift of the model never shows as a hard line. The fade (about twice the radius) stays inside the
      // crop's padding, so the crop's own border never shows either.
      if(matte&&sel&&bounds&&!annotated&&!resizeSelection){
        const soft=featheredMask(snapshot,sel,Math.max(6,Math.round(Math.min(bounds.w,bounds.h)*.06)));
        if(soft)matte=featheredModifyMatte(soft,region);
      }
      const flat = blankCanvas(snapshot.width, snapshot.height);
      renderDoc(flat.getContext("2d")!, { ...snapshot, selection: null }, { background: true });
      const crop = blankCanvas(region.w, region.h);
      crop.getContext("2d")!.drawImage(flat, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
      const source = await uploadPng(crop, "image", `${mode}-source-${Date.now()}.png`);
      let reference=source;
      // The boxes as they sit in the crop: one box needs no guide, several get one drawn on the crop.
      const cropAnnotations=annotated?annotationsInCrop(boxes,{width:snapshot.width,height:snapshot.height},region):annotations;
      if(annotated&&!singleBox)reference=await uploadPng(annotationGuide(crop,cropAnnotations),"image",`annotation-guide-${Date.now()}.png`);
      else if(aiReference)reference=aiReference;
      else if(integration){const target=blankCanvas(region.w,region.h);target.getContext("2d")!.drawImage(integration.target,region.x,region.y,region.w,region.h,0,0,region.w,region.h);reference=await uploadPng(target,"image",`harmonize-element-${Date.now()}.png`);}
      const explicitReferences=[aiReference,...extraReferences];
      const ports=runEdit.manifest.inputs.map(input=>input.id);
      // No model gets a picture with the blue selection overlay: Qwen and MiniMax reproduce it as a blue tint
      // (seen 2026-11-11 and 2026-11-15). The masked edit gets the real mask, and every result is cut to the
      // selection with a soft edge anyway.
      const selectionGuide=null as Asset|null;
      const mentionStyle=usesH3Prompt(runEdit.manifest)?"h3" as const:"plain" as const;
      const mapped=modifyReferenceBindings(source.id,annotated?(singleBox?undefined:reference.id):selectionGuide?.id,explicitReferences.map(asset=>asset?.id??null),ports,aiPrompt,mentionStyle);
      const inputs:Record<string,string>=mapped.inputs;
      if(runEdit===maskedEdit&&sel){
        const mask=cropSelectionMask(sel,region);if(!mask)throw new Error("The selected mask is unavailable.");
        // Alignment needs surrounding pixels; a full-frame selection uses the normal editor.
        if(mask.hasProtectedPixels)inputs.edit_mask=(await uploadPng(mask.canvas,"mask",`modify-mask-${Date.now()}.png`)).id;
        else runEdit=edit;
      }
      // A model that requires a second picture (Qwen) gets the crop itself; a single annotation box has no guide.
      if((!annotated||singleBox)&&!selectionGuide&&!explicitReferences.some(Boolean)&&(!!integration||edit.manifest.inputs.some(i=>i.id==="reference_image"&&i.required)))inputs.reference_image=reference.id;
      const elementInputs=!annotated&&aiCharacter?characterEditBindings(aiCharacter,edit.manifest,project.id):{};
      for(const port of Object.keys(elementInputs))delete inputs[port];
      const referenceCount=aiCharacter?aiCharacter.referencePack.references.length:hasReference?(aiReference?1:0)+extraReferences.filter(Boolean).length:0;
      const characterIds=aiCharacter?.referencePack.references.map(reference=>reference.assetId)??[];
      let referenceSheet:Asset|null=null;
      if(!annotated&&aiCharacter&&characterIds.length>1){
        const sheet=await referenceSheetCanvas(characterIds.map(id=>assetUrl(workspace.id,id)));
        referenceSheet=await uploadPng(sheet,"image",`character-reference-sheet-${Date.now()}.png`,characterIds[0]);
        elementInputs.reference_image={...(elementInputs.reference_image??{elementId:aiCharacter.elementId}),assetId:referenceSheet.id};
        delete elementInputs.reference_image_2;
        delete elementInputs.reference_image_3;
        // The sheet replaces all separate reference ports. Remove any leftover
        // UI-provided extra references so Qwen never receives a four-image set.
        delete inputs.reference_image_2;
        delete inputs.reference_image_3;
      }
      const referenceInstruction=referenceSheet?identityReferenceSheetInstruction(characterIds.length):aiCharacter?identityReferenceInstruction(referenceCount):"";
      const mappedAnnotations=annotated?mapAnnotationReferenceMentions(cropAnnotations,source.id,singleBox?undefined:reference.id,explicitReferences.map(asset=>asset?.id??null),ports,mentionStyle):annotations;
      const instruction=annotated?(singleBox?annotationCropInstruction(mappedAnnotations[0],mapped.prompt):annotationInstruction(mappedAnnotations,mapped.prompt)):[aiInstruction(mode,characterPlacement&&aiCharacter?characterPlacementInstruction(aiCharacter.name,aiPrompt):selectionInstruction(mapped.prompt,!!sel)),selectionGuide?selectionGuideFor(mentionStyle):"",referenceInstruction].filter(Boolean).join(" ");
      // Modify must follow the user's actual instruction, including replacement details.
      // Fibo's optional prompt enhancer can rewrite those details before the edit model sees them.
      const directPrompt=(mode==="modify"||annotated||explicitReferences.some(Boolean))&&edit.manifest.controls.some(control=>control.id==="improve_prompt");
      // The model works at the size the picture needs, not its fixed default: FLUX 3 Klein, Qwen and Fibo default
      // to 1 MP (a 2048x1157 picture came back soft), MiniMax H3 Image to 12 MP (400 s for a 0.1 MP crop). The
      // smallest option that covers the section; an annotation crop asks for four times its pixels.
      const sizeOptions=(runEdit.manifest.controls.find(control=>control.id==="megapixels")?.options??[]).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
      // MiniMax H3 Image renders at least 8 MP in Modify (user, 2026-11-15): its detail at 4 MP stays behind.
      // Fibo at 2 MP (and 8 steps, its manifest default) keeps the original's saturation and gains detail; Qwen
      // stays at 1 MP, where it is sharpest (face test 2026-11-15, rated by the user).
      const fiboCrop=runEdit.manifest.id==="fibo2-edit";
      const minMegapixels=usesH3Prompt(runEdit.manifest)?8:fiboCrop?2:1;
      const cropMegapixels=sizeOptions.length?sizeOptions.find(option=>option>=Math.max(minMegapixels,region.w*region.h*(annotated?4:1)/1e6))??sizeOptions[sizeOptions.length-1]:undefined;
      // Fibo and Qwen come out a little waxy with plain euler; an ancestral sampler adds fresh noise at every
      // step inside the model, which gives natural skin and surface texture without grain on the result.
      const sampler=runEdit.manifest.controls.find(control=>control.id==="sampler")?.options?.includes("euler_ancestral")?{sampler:"euler_ancestral"}:{};
      // Qwen reads a small crop at its own size and copies its blur, a damaged eye included; enlarged to at
      // least 1024 px it redraws the detail cleanly (face test 2026-11-15). Larger crops keep their size.
      const referenceControl=runEdit.manifest.controls.find(control=>control.id==="reference_resolution");
      const referenceSize=referenceControl?{reference_resolution:Math.min(referenceControl.max??2048,Math.max(1024,Math.ceil(Math.sqrt(region.w*region.h)/32)*32))}:{};
      const done = await runAndWait(runEdit, inputs, { prompt: editInstructionFor(mentionStyle,instruction),...(directPrompt?{improve_prompt:false}:{}),...(cropMegapixels!==undefined?{megapixels:cropMegapixels}:{}),...sampler,...referenceSize },undefined,elementInputs);
      if (!done || !alive.current) return;
      const out = done.output_ids[0];
      // A run that was cancelled (Jobs menu) or failed is said in the panel, not only in a passing toast.
      if (done.state !== "succeeded" || !out) { setAiStop({mode,cancelled:done.state==="canceled",error:done.error??""}); return false; }
      if(!annotated&&(hasReference||aiCharacter)){const referenceId=aiCharacter?.referencePack.references[0]?.assetId??reference.id;setSwapCheck({source:source.id,reference:referenceId,result:out,label:aiCharacter?.name??"Edited result",run:done.id});}
      const { bitmap } = await loadBitmap(assetUrl(workspace.id, out));
      // Qwen scales each source dimension to its latent grid without cropping; MiniMax H3 Image keeps
      // Picture 1's proportions by default. Map the complete generated frame back to the source crop.
      const sourceAligned=edit.manifest.id==="qwen-image-21-edit"||usesH3Prompt(runEdit.manifest);
      const result = matte?cutoutModifiedResult(bitmap,region,matte,sourceAligned,fiboCrop,sel&&!annotated?flat:undefined):blankCanvas(snapshot.width, snapshot.height);
      const rc = result.getContext("2d")!;
      if(!matte)drawModifiedResult(rc,bitmap,region,sourceAligned,fiboCrop);
      if (sel&&!matte) {
        const soft = featheredMask(snapshot, sel, Math.max(2, Math.round(Math.min(region.w, region.h) * 0.01)),true);
        if (soft) {
          rc.globalCompositeOperation = "destination-in";
          rc.drawImage(soft, 0, 0);
        }
      }
      // The layer says what was asked and by which model; annotation runs list their box instructions.
      const layerName=aiLayerName(shortEditModelName(edit.manifest.title),aiPrompt.trim()||(annotated?boxes.map(box=>box.instruction).join("; "):""),AI_LABELS[mode]);
      const key = `bmp:ai${Date.now().toString(36)}`;
      setBitmap(key, result);
      if(!liveDoc.current||imageSignature(liveDoc.current)!==imageSignature(snapshot))throw new Error("The image changed. The generated result remains in Library; this canvas was kept unchanged.");
      setHist((h0) => {
        if (!h0||imageSignature(h0.present)!==imageSignature(snapshot)) return h0;
        return commit(h0,addAiResultLayer(h0.present,key,layerName,matte?.bounds));
      });
      thumbs.current.clear();
      refreshBitmaps();
      toast(`${AI_LABELS[mode]} added as a new layer`);
      return true;
    } catch (e) {
      toast((e as Error).message);
      return false;
    } finally {
      if (alive.current) setAiBusy(null);
    }
  }

  async function upscaleEditor(scope:"image"|"layer"){
    if(!doc||!upscale||aiBusy||!canEdit||!authorized)return;
    const snapshot=doc,signature=imageSignature(doc),selected=selectedLayer(doc);
    if(scope==="layer"&&(!selected||selected.kind==="adjust")){toast("Choose an image layer first.");return;}
    if(scope==="image"&&(doc.width*2>8192||doc.height*2>8192||doc.width*doc.height*4>67108864)){toast("A 2× canvas must be no larger than 8192 px per side.");return;}
    setUpscaling(true);setAiBusy("modify");
    try{
      const flat=scope==="layer"&&selected?layerCanvas(snapshot,selected):blankCanvas(snapshot.width,snapshot.height);
      if(!flat)throw new Error("The selected layer is not loaded yet.");
      if(scope==="image")renderDoc(flat.getContext("2d")!,{...snapshot,selection:null},{background:true});
      const source=await uploadPng(flat,"image",`upscale-source-${Date.now()}.png`);
      const done=await runAndWait(upscale,{source_image:source.id},{scale_by:0.5});
      if(!done||!alive.current)return;
      if(done.state!=="succeeded"||!done.output_ids[0])throw new Error(done.error||"Upscaling did not finish.");
      const {bitmap,w,h}=await loadBitmap(assetUrl(workspace.id,done.output_ids[0]));
      const output=blankCanvas(w,h),ctx=output.getContext("2d")!;ctx.drawImage(bitmap,0,0,w,h);
      if(scope==="layer"){ctx.globalCompositeOperation="destination-in";ctx.drawImage(flat,0,0,w,h);}
      if(!liveDoc.current||imageSignature(liveDoc.current)!==signature)throw new Error("The image changed. The result remains in Library; this canvas was kept unchanged.");
      const scaled=scope==="image"?scaleViewport(snapshot,200,8192):null;
      const key=`bmp:upscale:${crypto.randomUUID()}`;setBitmap(key,output);
      setHist(old=>{
        if(!old||imageSignature(old.present)!==signature)return old;
        let next=addAiResultLayer(scaled??old.present,key,scope==="image"?"Upscaled image":"Upscaled layer");
        if(scope==="layer"&&selected){
          const resultId=next.selectedId!;
          next={...next,layers:next.layers.map(item=>item.id===selected.id?{...item,visible:false}:item.id===resultId?{...item,opacity:selected.opacity,blend:selected.blend,clip:selected.clip,group:selected.group}:item)};
          next=reorderLayer(next,resultId,selected.id);
        }
        return commit(old,next);
      });
      thumbs.current.clear();refreshBitmaps();toast(scope==="image"?"Image upscaled 2×":"Upscaled layer added");
    }catch(error){toast((error as Error).message);}finally{if(alive.current){setUpscaling(false);setAiBusy(null);}}
  }

  async function quickUpscaleVisible(mode:"fast"|"detail"="fast"){
    const engine=mode==="detail"?(detailUpscale??upscale):upscale;
    if(!doc||!engine||aiBusy||!canEdit||!authorized)return;
    const canvas=canvasRef.current,stage=stageRef.current;
    if(!canvas||!stage)return;
    const snapshot=doc,signature=imageSignature(doc);
    const canvasRect=canvas.getBoundingClientRect(),stageRect=stage.getBoundingClientRect();
    const visible=visibleDocumentRect(canvasRect,stageRect,doc.width,doc.height);
    if(!visible){toast("Show part of the picture before quick upscaling.");return;}
    const documentPerScreen=doc.width/Math.max(1,canvasRect.width);
    // Detailed: as few runs as the redraw size allows (DETAIL_TILE_PX); Fast keeps small, quick tiles.
    // A picture whose 2x result fits the model's working size (about 1 MP in, 4 MP out) goes in one run: no seams.
    const wholeAtOnce=mode==="detail"&&visible.w*visible.h<=DETAIL_TILE_PX*DETAIL_TILE_PX;
    const screenPx=wholeAtOnce?Math.ceil(Math.max(visible.w,visible.h)/documentPerScreen)+2:mode==="detail"?Math.max(96,Math.round(DETAIL_TILE_PX/documentPerScreen)):Math.max(240,Math.min(420,Math.round(Math.min(stageRect.width,stageRect.height)*0.36)));
    const tiles=planQuickTiles(visible,doc.width,doc.height,{screenPx,documentPerScreen,maxTiles:24});
    if(!tiles.length)return;
    /* A zoomed-in region gets the model's full 4x output; a full or large canvas stays at 2x. */
    const big=doc.width*doc.height>4_000_000;
    const maxFactor=Math.min(8192/doc.width,8192/doc.height,Math.sqrt(67108864/(doc.width*doc.height)));
    if(maxFactor<2){toast("This canvas is too large to upscale further.");return;}
    const factor:2|4=mode==="detail"?2:!big&&maxFactor>=4&&visible.w*visible.h<doc.width*doc.height*.75?4:2;
    const scaled=scaleViewport(snapshot,factor*100,8192);
    const flat=blankCanvas(doc.width,doc.height);renderDoc(flat.getContext("2d")!,{...snapshot,selection:null},{background:true});
    /* A detailed model that needs a second picture gets the whole frame as context; one that only may take it
       (Fibo) does not: given the whole dragon, it drew the whole dragon instead of the tile (tile test 2026-11-16). */
    let contextId:string|undefined;
    if(mode==="detail"&&engine.manifest.inputs.some(input=>input.id==="reference_image"&&input.required)){
      const context=await uploadPng(flat,"image",`quick-upscale-context-${Date.now()}.png`,undefined,true);
      contextId=context.id;
    }
    const result=blankCanvas(scaled.width,scaled.height),resultContext=result.getContext("2d")!;
    quickAbort.current=false;quickRun.current=null;setQuickTiles(tiles);setQuickSkipped([]);setQuickPreviews(new Array(tiles.length).fill(null));setQuickScale(factor);setUpscaling(true);setAiBusy("modify");setQuickProgress({done:0,total:tiles.length});
    try{
      for(const [index,tile] of tiles.entries()){
        if(!alive.current)return;
        const source=blankCanvas(tile.source.w,tile.source.h);
        source.getContext("2d")!.drawImage(flat,tile.source.x,tile.source.y,tile.source.w,tile.source.h,0,0,tile.source.w,tile.source.h);
        // Detailed mode: the original's own texture decides. A tile that is nearly all flat colour is simply
        // enlarged (no model pass, nothing to invent, much faster); a mixed tile is guarded after the pass.
        const detail=mode==="detail"?tileDetail(source):null;
        if(detail&&detailShare(detail)<MIN_DETAIL_SHARE){
          setQuickSkipped(current=>[...current,index]);
          const patch=blankCanvas(tile.source.w*factor,tile.source.h*factor);
          patch.getContext("2d")!.drawImage(source,0,0,patch.width,patch.height);
          featherTile(patch,tile.feather*factor);
          resultContext.drawImage(patch,tile.source.x*factor,tile.source.y*factor);
          setQuickPreviews(current=>{const next=[...current];next[index]=patch;return next;});
          setQuickProgress({done:index+1,total:tiles.length});
          continue;
        }
        const asset=await uploadPng(source,"image",`quick-upscale-${Date.now()}-${index}.png`,undefined,true);
        const hasPrompt=engine.manifest.controls.some(control=>control.id==="prompt");
        const hasDetail=engine.manifest.controls.some(control=>control.id==="denoise");
        const hasMegapixels=engine.manifest.controls.some(control=>control.id==="megapixels");
        const detailControls:Record<string,unknown>=hasPrompt?{prompt:QUICK_UPSCALE_PROMPT}:{};
        if(hasDetail)detailControls.denoise=0.3;
        /* Speed: the smallest size that still covers the tile at its target resolution (usually 1 MP, not 2),
           and fewer steps, since the model refines a picture it is given instead of inventing one. */
        if(hasMegapixels){const options=(engine.manifest.controls.find(control=>control.id==="megapixels")?.options??[]).map(Number).filter(Number.isFinite).sort((x,y)=>x-y);const need=tile.source.w*tile.source.h*factor*factor/1e6;detailControls.megapixels=options.find(option=>option>=need)??options[options.length-1]??2;}
        /* A refinement needs half the steps of a fresh picture (Fibo: 4 of 8, 18 s per 1024 tile instead of 35 s, with
           more detail and closer to the original than Z-Image); the ancestral sampler keeps the texture natural and the
           prompt goes in as written, not rewritten by the model's prompt helper. */
        const steps=engine.manifest.controls.find(control=>control.id==="steps");
        if(engine!==upscale&&steps)detailControls.steps=Math.max(steps.min??1,Math.round(Number(steps.default??16)/2));
        if(engine.manifest.controls.find(control=>control.id==="sampler")?.options?.includes("euler_ancestral"))detailControls.sampler="euler_ancestral";
        if(engine.manifest.controls.some(control=>control.id==="improve_prompt"))detailControls.improve_prompt=false;
        if(engine.manifest.controls.find(control=>control.id==="aspect_ratio")?.options?.includes("Same as Picture 1"))detailControls.aspect_ratio="Same as Picture 1";
        if(engine===upscale)detailControls.scale_by=factor===4?1:0.5;
        const done=await runAndWait(engine,{source_image:asset.id,...(contextId?{reference_image:contextId}:{})},detailControls,run=>{quickRun.current=run.id;});
        if(quickAbort.current||!alive.current)return;
        if(!done)return;
        if(done.state!=="succeeded"||!done.output_ids[0])throw new Error(done.error||"Quick upscale did not finish.");
        /* MiniMax rebuilds the tile at its 4 MP working size; the existing AI upscaler then takes
           that rebuilt detail to the real 2x/4x document resolution. */
        let outputId=done.output_ids[0];
        const {bitmap}=await loadBitmap(assetUrl(workspace.id,outputId));
        const patch=blankCanvas(tile.source.w*factor,tile.source.h*factor);
        const patchContext=patch.getContext("2d")!;
        const wholeAspect=doc.width/doc.height,bmpAspect=bitmap.width/bitmap.height;
        /* Some edit models answer with the whole frame even when only a tile is wanted.
           In that case keep only the rebuilt region that belongs to this tile. */
        if(mode==="detail"&&contextId&&Math.abs(bmpAspect-wholeAspect)<0.06){
          patchContext.drawImage(bitmap,
            tile.source.x/doc.width*bitmap.width,tile.source.y/doc.height*bitmap.height,
            tile.source.w/doc.width*bitmap.width,tile.source.h/doc.height*bitmap.height,
            0,0,patch.width,patch.height);
        }else{
          patchContext.drawImage(bitmap,0,0,patch.width,patch.height);
        }
        // Keep the rebuilt detail only where the original has texture and the answer still matches it.
        if(detail){const guarded=guardedPatch(source,patch,detail);patchContext.clearRect(0,0,patch.width,patch.height);patchContext.drawImage(guarded,0,0);}
        featherTile(patch,tile.feather*factor);
        resultContext.drawImage(patch,tile.source.x*factor,tile.source.y*factor);
        setQuickPreviews(current=>{const next=[...current];next[index]=patch;return next;});
        setQuickProgress({done:index+1,total:tiles.length});
      }
      if(quickAbort.current)return;
      if(!liveDoc.current||imageSignature(liveDoc.current)!==signature)throw new Error("The image changed. The quick upscale was not applied.");
      const key=`bmp:quick-upscale:${crypto.randomUUID()}`;setBitmap(key,result);
      setHist(old=>{
        if(!old||imageSignature(old.present)!==signature)return old;
        return commit(old,addAiResultLayer(scaled,key,"Quick upscale"));
      });
      requestAnimationFrame(()=>{const v=view.current;view.current={zoom:v.zoom/factor,x:v.x/factor,y:v.y/factor};applyView();});
      thumbs.current.clear();refreshBitmaps();toast(`Quick upscale ${mode==="detail"?"detailed":"fast"} ${factor}× applied to the visible area (${tiles.length} tile${tiles.length===1?"":"s"}).`);
    }catch(error){toast((error as Error).message);}
    finally{quickRun.current=null;if(alive.current){setUpscaling(false);setAiBusy(null);setQuickProgress(null);setQuickTiles([]);setQuickPreviews([]);}}
  }

  /* Marked regions (annotations) on the picture: numbered dashed frames over the canvas, following zoom and pan.
     Drawn on the quick-upscale overlay while no upscale runs; never part of the image. */
  useEffect(()=>{
    if(!annotations.length||quickProgress||subjectRelight||tool==="subject")return;
    let frame=0;
    const draw=()=>{
      const stage=stageRef.current,canvas=canvasRef.current,overlay=quickOverlayRef.current;
      if(stage&&canvas&&overlay&&doc){
        const stageRect=stage.getBoundingClientRect(),canvasRect=canvas.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1);
        const width=Math.max(1,Math.round(stageRect.width*dpr)),height=Math.max(1,Math.round(stageRect.height*dpr));
        if(overlay.width!==width||overlay.height!==height){overlay.width=width;overlay.height=height;}
        const ctx=overlay.getContext("2d")!;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,stageRect.width,stageRect.height);
        const root=getComputedStyle(document.documentElement),accent=root.getPropertyValue("--accent").trim()||"#2fa8ff";
        const left=canvasRect.left-stageRect.left,top=canvasRect.top-stageRect.top;
        ctx.font=`600 11px ${getComputedStyle(document.body).fontFamily}`;
        annotations.forEach((box,index)=>{
          const x=left+box.x*canvasRect.width,y=top+box.y*canvasRect.height,w=box.w*canvasRect.width,h=box.h*canvasRect.height;
          ctx.strokeStyle=accent;ctx.lineWidth=1.5;ctx.setLineDash([6,4]);ctx.globalAlpha=.95;ctx.strokeRect(x,y,w,h);ctx.setLineDash([]);
          ctx.fillStyle=accent;ctx.fillRect(x,y-18,18,18);ctx.fillStyle="#0b1520";ctx.fillText(String(index+1),x+5.5,y-5);
        });
        ctx.globalAlpha=1;
      }
      frame=requestAnimationFrame(draw);
    };
    frame=requestAnimationFrame(draw);
    return()=>{cancelAnimationFrame(frame);const overlay=quickOverlayRef.current;if(overlay)overlay.getContext("2d")?.clearRect(0,0,overlay.width,overlay.height);};
  },[annotations,quickProgress,subjectRelight,doc,tool]);

  /* Quick select starts its analysis by itself: when the tool is chosen and whenever the picture changes. */
  const pictureSignature=doc?imageSignature(doc):"";
  useEffect(()=>{
    if(tool!=="subject"){if(objectScan?.status==="analysing"){scanToken.current++;setObjectScan(null);}return;}
    if(!pictureSignature||!segment||!canEdit||!authorized||aiBusy)return;
    if(objectScan?.signature===pictureSignature)return;
    void analyseObjects();
  // analyseObjects reads the current doc; the signature stands for it here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[tool,pictureSignature,segment,canEdit,authorized,aiBusy]);

  /* Quick select on the picture: while analysing a light band sweeps the whole image and the outlines found so
     far march; when ready every region keeps a quiet outline. Drawn on the overlay, never into the image. */
  useEffect(()=>{
    if(tool!=="subject"||!objectScan||quickProgress)return;
    let frame=0;
    const draw=(now:number)=>{
      const stage=stageRef.current,canvas=canvasRef.current,overlay=quickOverlayRef.current;
      if(stage&&canvas&&overlay&&doc){
        const stageRect=stage.getBoundingClientRect(),canvasRect=canvas.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1);
        const width=Math.max(1,Math.round(stageRect.width*dpr)),height=Math.max(1,Math.round(stageRect.height*dpr));
        if(overlay.width!==width||overlay.height!==height){overlay.width=width;overlay.height=height;}
        const ctx=overlay.getContext("2d")!;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,stageRect.width,stageRect.height);
        const left=canvasRect.left-stageRect.left,top=canvasRect.top-stageRect.top,scale=canvasRect.width/Math.max(1,doc.width);
        const analysing=objectScan.status==="analysing"&&objectScan.signature===imageSignature(doc);
        if(analysing){
          const sweep=left-120+((now/1400)%1)*(canvasRect.width+240);
          const sheen=ctx.createLinearGradient(sweep-110,0,sweep+110,0);
          sheen.addColorStop(0,"rgba(255,255,255,0)");sheen.addColorStop(.5,"rgba(255,255,255,.22)");sheen.addColorStop(1,"rgba(255,255,255,0)");
          ctx.fillStyle=sheen;ctx.fillRect(left,top,canvasRect.width,canvasRect.height);
        }
        const regions=objectRegions.current?.signature===imageSignature(doc)?objectRegions.current.regions:[];
        if(regions.length){
          ctx.save();ctx.translate(left,top);ctx.scale(scale,scale);
          ctx.lineWidth=1.25/scale;ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()||"#2fa8ff";ctx.globalAlpha=analysing?.8:.45;
          if(analysing){ctx.setLineDash([5/scale,5/scale]);ctx.lineDashOffset=-(now/60)/scale;}
          for(const region of regions)ctx.stroke(maskOutlinePath(region.canvas));
          ctx.restore();
        }
      }
      frame=requestAnimationFrame(draw);
    };
    frame=requestAnimationFrame(draw);
    return()=>{cancelAnimationFrame(frame);const overlay=quickOverlayRef.current;if(overlay)overlay.getContext("2d")?.clearRect(0,0,overlay.width,overlay.height);};
  },[tool,objectScan,quickProgress,doc]);

  useEffect(()=>{
    if(!quickTiles.length||!quickProgress)return;
    let frame=0;
    const draw=(now:number)=>{
      const stage=stageRef.current,canvas=canvasRef.current,overlay=quickOverlayRef.current;
      if(!stage||!canvas||!overlay){frame=requestAnimationFrame(draw);return;}
      const stageRect=stage.getBoundingClientRect(),canvasRect=canvas.getBoundingClientRect();
      const dpr=Math.min(2,window.devicePixelRatio||1);
      const width=Math.max(1,Math.round(stageRect.width*dpr)),height=Math.max(1,Math.round(stageRect.height*dpr));
      if(overlay.width!==width||overlay.height!==height){overlay.width=width;overlay.height=height;}
      const ctx=overlay.getContext("2d")!;
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.clearRect(0,0,stageRect.width,stageRect.height);
      const root=getComputedStyle(document.documentElement);
      const accent=root.getPropertyValue("--accent").trim()||"#2fa8ff";
      const soft=root.getPropertyValue("--accent-soft").trim()||"rgba(47,168,255,.12)";
      const left=canvasRect.left-stageRect.left,top=canvasRect.top-stageRect.top;
      const xScale=canvasRect.width/Math.max(1,doc?.width??1),yScale=canvasRect.height/Math.max(1,doc?.height??1);
      const rounded=(x:number,y:number,w:number,h:number,r:number)=>{
        const radius=Math.min(r,w/2,h/2);
        ctx.beginPath();ctx.moveTo(x+radius,y);ctx.arcTo(x+w,y,x+w,y+h,radius);ctx.arcTo(x+w,y+h,x,y+h,radius);ctx.arcTo(x,y+h,x,y,radius);ctx.arcTo(x,y,x+w,y,radius);ctx.closePath();
      };
      for(const [index,tile] of quickTiles.entries()){
        const preview=quickPreviews[index];
        const x=left+tile.source.x*xScale,y=top+tile.source.y*yScale;
        const w=Math.max(1,tile.source.w*xScale),h=Math.max(1,tile.source.h*xScale);
        const done=index<quickProgress.done,active=index===quickProgress.done&&quickProgress.done<quickProgress.total;
        if(preview){ctx.save();rounded(x,y,w,h,8);ctx.clip();ctx.drawImage(preview,x,y,w,h);ctx.restore();}
        ctx.save();
        rounded(x,y,w,h,8);
        if(active){
          ctx.clip();
          ctx.fillStyle=soft;ctx.globalAlpha=.18;ctx.fillRect(x,y,w,h);
          /* A soft light band sweeps the working tile, so the active square reads as busy. */
          const sweep=x-40+((now/820)%1)*(w+80);
          const sheen=ctx.createLinearGradient(sweep-42,0,sweep+42,0);
          sheen.addColorStop(0,"rgba(255,255,255,0)");sheen.addColorStop(.5,"rgba(255,255,255,.28)");sheen.addColorStop(1,"rgba(255,255,255,0)");
          ctx.globalAlpha=1;ctx.fillStyle=sheen;ctx.fillRect(x,y,w,h);
          ctx.restore();
          ctx.save();
          rounded(x+1,y+1,w-2,h-2,7);
          ctx.strokeStyle=accent;ctx.lineWidth=1.6;ctx.globalAlpha=.95;
          ctx.shadowColor=accent;ctx.shadowBlur=9;ctx.stroke();ctx.shadowBlur=0;
          /* Corner ticks: a camera-focus mark instead of a plain box. */
          const tick=Math.min(14,w*.22,h*.22);
          ctx.lineWidth=2;ctx.globalAlpha=1;ctx.beginPath();
          ctx.moveTo(x+4,y+4+tick);ctx.lineTo(x+4,y+4);ctx.lineTo(x+4+tick,y+4);
          ctx.moveTo(x+w-4-tick,y+4);ctx.lineTo(x+w-4,y+4);ctx.lineTo(x+w-4,y+4+tick);
          ctx.moveTo(x+4,y+h-4-tick);ctx.lineTo(x+4,y+h-4);ctx.lineTo(x+4+tick,y+h-4);
          ctx.moveTo(x+w-4-tick,y+h-4);ctx.lineTo(x+w-4,y+h-4);ctx.lineTo(x+w-4,y+h-4-tick);
          ctx.stroke();
          const scan=y+8+((now/1400)%1)*(h-16);
          ctx.globalAlpha=.22;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x+8,scan);ctx.lineTo(x+w-8,scan);ctx.stroke();
        }else if(done&&quickSkipped.includes(index)){
          /* Flat colour: only enlarged, no model pass. A quiet frame and the word, no check mark. */
          ctx.strokeStyle=accent;ctx.globalAlpha=.18;ctx.lineWidth=1;ctx.stroke();
          ctx.globalAlpha=.75;ctx.fillStyle=root.getPropertyValue("--text-secondary").trim()||"#898a8b";
          ctx.font=`500 11px ${getComputedStyle(document.body).fontFamily}`;ctx.fillText("Flat",x+9,y+18);
        }else if(done){
          ctx.strokeStyle=accent;ctx.globalAlpha=.4;ctx.lineWidth=1;ctx.stroke();
          ctx.globalAlpha=.9;ctx.strokeStyle=accent;ctx.lineWidth=1.8;ctx.beginPath();
          ctx.moveTo(x+9,y+14);ctx.lineTo(x+13,y+18);ctx.lineTo(x+20,y+9);ctx.stroke();
        }else{
          ctx.strokeStyle=accent;ctx.globalAlpha=.32;ctx.lineWidth=1;ctx.setLineDash([4,7]);ctx.stroke();ctx.setLineDash([]);
        }
        ctx.restore();
      }
      ctx.globalAlpha=1;
      frame=requestAnimationFrame(draw);
    };
    frame=requestAnimationFrame(draw);
    return()=>{
      cancelAnimationFrame(frame);
      const overlay=quickOverlayRef.current;
      if(overlay)overlay.getContext("2d")?.clearRect(0,0,overlay.width,overlay.height);
    };
  },[quickTiles,quickPreviews,quickProgress,quickSkipped,doc?.width,doc?.height]);

  async function cancelQuickUpscale(){
    quickAbort.current=true;
    const id=quickRun.current;
    /* Stop the picture at once; the API cancellation catches up with the worker. */
    setQuickProgress(null);setQuickTiles([]);setQuickPreviews([]);setUpscaling(false);setAiBusy(null);
    if(id){try{await call(workspacePath(workspace.id,`runs/${id}/cancel`),"POST",{});}catch{/* the run may already be ending */}}
  }

  async function analyseObjects():Promise<ObjectRegion[]|undefined>{
    if(!doc||!segment||!canEdit||!authorized)return;
    const snapshot=doc,signature=imageSignature(doc),token=++scanToken.current;let total=QUICK_SELECT_FIRST.length+quickSelectPlan(true).length;
    const current=()=>token===scanToken.current&&alive.current&&!!liveDoc.current&&imageSignature(liveDoc.current)===signature;
    hoveredObject.current=-1;objectRegions.current={signature,regions:[]};setObjectScan({signature,status:"analysing",done:0,total});
    try{
      const flat=blankCanvas(doc.width,doc.height);renderDoc(flat.getContext("2d")!,{...doc,selection:null},{background:true});
      const source=await uploadPng(flat,"image",`objects-source-${Date.now()}.png`);
      // Masks are cleaned before they become regions: a light blur and threshold fills pinholes and drops specks.
      const soften=Math.max(2,Math.round(Math.min(snapshot.width,snapshot.height)*.006));
      const concepts:string[]=[...QUICK_SELECT_FIRST];
      for(let index=0;index<concepts.length;index++){
        const concept=concepts[index];
        if(!current())return;
        if(concept==="person"){/* parts are planned once it is known whether there is a person */}
        const done=await runAndWait(segment,{source_image:source.id},{prompt:concept,individual_masks:true});
        if(!done||!current())return;
        if(done.state!=="succeeded")throw new Error(done.error||"The picture could not be analysed.");
        let found=false;
        for(const id of done.output_ids.slice(0,6)){
          const {bitmap}=await loadBitmap(assetUrl(workspace.id,id)),canvas=blankCanvas(snapshot.width,snapshot.height),c=canvas.getContext("2d",{willReadFrequently:true})!;
          c.filter=`blur(${soften}px)`;c.drawImage(bitmap,0,0,snapshot.width,snapshot.height);c.filter="none";
          const pixels=c.getImageData(0,0,snapshot.width,snapshot.height);let area=0;
          for(let i=0;i<pixels.data.length;i+=4){const v=pixels.data[i]>127?255:0;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=255;pixels.data[i+3]=v;if(v)area++;}
          // Specks are not regions anyone clicks: at least 0.2 % of the picture, and not a copy of one found already.
          const region={canvas,alpha:pixels.data,area,label:concept};
          if(area>snapshot.width*snapshot.height*.002&&!objectRegions.current.regions.some(other=>sameRegion(other,region))){c.putImageData(pixels,0,0);objectRegions.current.regions.push(region);found=true;}
        }
        if(!current())return;
        if(concept==="person"){concepts.push(...quickSelectPlan(found));total=concepts.length;}
        setObjectScan({signature,status:"analysing",done:index+1,total});
      }
      setObjectScan({signature,status:"ready",done:total,total});
      return objectRegions.current.regions;
    }catch(error){
      if(token===scanToken.current&&alive.current){setObjectScan({signature,status:"failed",done:0,total});toast((error as Error).message);}
    }
  }
  /** Select subject: SAM 3.1 finds the named parts in the visible picture; the mask becomes the selection. */
  function saveSelection() {
    if (!doc?.selection) return;
    const key = maskBitmap(doc);
    if (!key) return;
    const n = (doc.saved?.length ?? 0) + 1;
    apply({ ...doc, saved: [...(doc.saved ?? []), { id: `s${Date.now().toString(36)}`, name: `Selection ${n}`, key }] });
  }

  async function selectSubject(prompt=subject,{erase=tool==="magicEraser"}:{erase?:boolean}={}) {
    const query=prompt.trim();
    if (!doc || !segment || selecting || !query) return;
    const snapshot = doc;
    const sourceSignature=imageSignature(snapshot);
    const mode = erase ? "replace" : altDown.current ? "subtract" : selMode;
    setSelecting(true);
    try {
      const flat = blankCanvas(snapshot.width, snapshot.height);
      renderDoc(flat.getContext("2d")!, { ...snapshot, selection: null }, { background: true });
      const source = await uploadPng(flat, "image", `select-source-${Date.now()}.png`);
      const done = await runAndWait(segment, { source_image: source.id }, { prompt: query });
      if (!done || !alive.current) return;
      const out = done.output_ids[0];
      if (done.state !== "succeeded" || !out) throw new Error(done.error || "The selection did not finish.");
      const { bitmap } = await loadBitmap(assetUrl(workspace.id, out));
      const shape = blankCanvas(snapshot.width, snapshot.height);
      const sc = shape.getContext("2d", { willReadFrequently: true })!;
      sc.drawImage(bitmap, 0, 0, snapshot.width, snapshot.height);
      const img = sc.getImageData(0, 0, snapshot.width, snapshot.height);
      let found = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const v = img.data[i];
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = v;
        if (v > 127) found++;
      }
      if (!found) throw new Error(`Nothing found for "${query}". Try another word or a lower threshold.`);
      sc.putImageData(img, 0, 0);
      if(!liveDoc.current||imageSignature(liveDoc.current)!==sourceSignature){toast("The image changed. Analyse the region again.");return;}
      const selected={...snapshot,selection:combine(snapshot,shape,mode)};
      if(erase){
        const target=selectedLayer(snapshot);magicSource.current={signature:sourceSignature,layerId:snapshot.selectedId};
        if(target)eraseMagicRegion(selected,target);
      }else setHist((h0) => (h0&&imageSignature(h0.present)===sourceSignature ? commit(h0, selected) : h0));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      if (alive.current) setSelecting(false);
    }
  }

  function eraseMagicRegion(source:Doc|null=doc,target:Layer|null=layer){
    if(!source||!target||!source.selection||!canEdit||selecting)return;
    if(magicSource.current&&(magicSource.current.signature!==imageSignature(source)||magicSource.current.layerId!==target.id)){toast("The image or target layer changed. Find the region again.");return;}
    const key=eraseRegionMask(source,target);if(!key){toast("The selected region could not be erased.");return;}
    const next=updateLayer(source,target.id,{mask:key,maskOff:false,defringe:1});thumbs.current.clear();magicSource.current=null;
    apply({...next,selection:null});toast("Region erased with an editable layer mask");
  }

  async function fillWithAi() {
    if (!doc || !doc.selection || !inpaint || aiBusy || !canEdit || !authorized || !aiPrompt.trim()) return;
    const w = floor8(doc.width);
    const h = floor8(doc.height);
    setAiBusy("fill");
    try {
      const source = blankCanvas(w, h);
      renderDoc(source.getContext("2d")!, { ...doc, width: w, height: h }, { background: true });
      const mask = blankCanvas(w, h);
      const m = mask.getContext("2d")!;
      m.fillStyle = "#000";
      m.fillRect(0, 0, w, h);
      const white = tinted(doc.selection, "#fff");
      if (white) m.drawImage(white, 0, 0);
      const up = async (canvas: HTMLCanvasElement, kind: "image" | "mask", name: string) => {
        const form = new FormData();
        form.append("file", new File([await toPng(canvas)], name, { type: "image/png" }));
        return call<Asset>(workspacePath(workspace.id, `assets?projectId=${project.id}&kind=${kind}`), "POST", form);
      };
      const [src, msk] = [await up(source, "image", `fill-source-${Date.now()}.png`), await up(mask, "mask", `fill-mask-${Date.now()}.png`)];
      const controls = Object.fromEntries(inpaint.manifest.controls.map((c) => [c.id, c.default]));
      controls.prompt = aiPrompt.trim();
      if ("denoise" in controls) controls.denoise = 1;
      if ("seed" in controls) controls.seed = Math.floor(Math.random() * 2147483647);
      const run = await call<Run>(workspacePath(workspace.id, "runs"), "POST", {
        projectId: project.id, workerId: inpaint.workerId, idempotencyKey: crypto.randomUUID(), capabilityId: inpaint.manifest.id,
        version: inpaint.manifest.version, routeId: inpaint.routeId, inputs: { source_image: src.id, edit_mask: msk.id }, controls, audioPolicy: "mute",
      });
      let finished: Run | undefined;
      while (alive.current && !finished) {
        await new Promise((r) => setTimeout(r, 2000));
        const runs = await call<Run[]>(workspacePath(workspace.id, `runs?projectId=${project.id}`));
        const found = runs.find((r) => r.id === run.id);
        if (found && ["succeeded", "failed", "canceled"].includes(found.state)) finished = found;
      }
      if (!finished || !alive.current) return;
      const out = finished.output_ids[0];
      if (finished.state !== "succeeded" || !out) throw new Error(finished.error || "The fill did not finish.");
      const sel = doc.selection;
      const { bitmap } = await loadBitmap(assetUrl(workspace.id, out));
      const result = blankCanvas(doc.width, doc.height);
      const rc = result.getContext("2d")!;
      rc.drawImage(bitmap, 0, 0, w, h);
      const soft = featheredMask(doc, sel, Math.max(2, Math.round(Math.min(doc.width, doc.height) * 0.004)),true);
      if (soft) {
        rc.globalCompositeOperation = "destination-in";
        rc.drawImage(soft, 0, 0);
      }
      const key = `bmp:fill${Date.now().toString(36)}`;
      setBitmap(key, result);
      setHist((h0) => {
        if (!h0) return h0;
        const added = addPaintLayer(h0.present, key);
        const named = { ...added, layers: added.layers.map((l) => (l.id === added.selectedId ? { ...l, name: "Generative fill" } : l)) };
        return commit(h0, moveLayerToEdge(named, named.selectedId!, "top"));
      });
      thumbs.current.clear();
      refreshBitmaps();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      if (alive.current) setAiBusy(null);
    }
  }

  function addEmptyLayer() {
    if (!doc) return;
    const key = `bmp:new${Date.now().toString(36)}`;
    setBitmap(key, blankCanvas(doc.width, doc.height));
    apply(addPaintLayer(doc, key));
    setTool("brush");
  }

  /** Duplicate every selected layer (Shift-click selects several, like Photoshop). */
  function duplicate() {
    if (!doc || !layer) return;
    const ids = multiIds();
    let next = doc;
    for (const id of ids) {
      const l = next.layers.find((x) => x.id === id);
      if (!l) continue;
      next = duplicateLayer(selectLayer(next, id), id, l.kind === "adjust" ? "" : cloneBitmap(l.src, l.w, l.h).key);
    }
    setMulti([]);
    thumbs.current.clear();
    apply(next);
  }

  function multiIds() {
    if (!doc || !layer) return [];
    return [layer.id, ...multi.filter((id) => id !== layer.id && doc.layers.some((l) => l.id === id))];
  }

  function deleteSelected() {
    if (!doc) return;
    let next = doc;
    for (const id of multiIds()) next = removeLayer(next, id);
    setMulti([]);
    apply(next);
  }

  /** Link: several selected layers are linked together; one layer toggles its link. */
  function linkSelected() {
    if (!doc || !layer) return;
    const ids = multiIds();
    const on = ids.length > 1 ? !ids.every((id) => doc.layers.find((l) => l.id === id)?.linked) : !layer.linked;
    let next = doc;
    for (const id of ids) next = updateLayer(next, id, { linked: on });
    apply(next);
  }

  function groupSelected(forceGroup = false) {
    if (!doc || !layer || !canEdit) return;
    const ids = multiIds();
    if (!forceGroup && ids.length === 1 && layer.group) return apply(ungroupLayer(doc, layer.id));
    const state=groupSelectionState(doc,ids);
    if(state==="already-grouped"){toast("These layers are already in the same group.");return;}
    if(state==="depth-limit"){toast("This group is too deeply nested. Ungroup a folder before grouping again.");return;}
    setMulti([]);
    apply(groupLayers(doc, ids));
  }

  function makeSmartObject(){
    if(!doc||!canEdit)return;
    try{
      const ids=smartObjectIds(doc,multiIds()),flat=blankCanvas(doc.width,doc.height);
      renderDoc(flat.getContext("2d")!,{...doc,selection:null,layers:doc.layers.filter(l=>ids.includes(l.id))});
      const key=`bmp:smart${crypto.randomUUID()}`;setBitmap(key,flat);
      setMulti([]);thumbs.current.clear();apply(createSmartObject(doc,ids,key));
    }catch(error){toast((error as Error).message);}
  }
  function editSmartContents(){
    if(!hist||!layer?.smartObject||!canEdit)return;
    if(smartSessions.current.length>=8){toast("Apply the current smart object contents before nesting further.");return;}
    smartSessions.current.push({history:hist,layerId:layer.id});setSmartDepth(smartSessions.current.length);
    setMulti([]);setMaskEdit(null);setQuickMask(false);setHist(startHistory(layer.smartObject));setTool("move");thumbs.current.clear();
  }
  function finishSmartContents(keep:boolean){
    const parent=smartSessions.current.at(-1);if(!parent||!doc)return;
    try{
      let next=parent.history;
      if(keep){
        const flat=blankCanvas(doc.width,doc.height);renderDoc(flat.getContext("2d")!,doc);
        const key=`bmp:smart${crypto.randomUUID()}`;
        const updated=applySmartContents(parent.history.present,parent.layerId,doc,key);setBitmap(key,flat);next=commit(parent.history,updated);
      }
      smartSessions.current.pop();setSmartDepth(smartSessions.current.length);setHist(next);setMulti([]);setMaskEdit(null);thumbs.current.clear();refreshBitmaps();
    }catch(error){toast((error as Error).message);}
  }

  /** Topmost layer with a visible pixel under the point (Ctrl+click with Move picks it, as in Photoshop). */
  function layerAt(d: Doc, p: { x: number; y: number }): string | null {
    const probe = blankCanvas(1, 1).getContext("2d", { willReadFrequently: true })!;
    for (let i = d.layers.length - 1; i >= 0; i--) {
      const l = d.layers[i];
      const bitmap = isVisible(d, l) ? getBitmap(l.src) : undefined;
      if (!bitmap) continue;
      const q = toLayerPoint(l, p.x, p.y);
      if (q.x < 0 || q.y < 0 || q.x >= l.w || q.y >= l.h) continue;
      probe.clearRect(0, 0, 1, 1);
      const { w, h } = sizeOf(bitmap);
      probe.drawImage(bitmap, (q.x * w) / l.w, (q.y * h) / l.h, 1, 1, 0, 0, 1, 1);
      if (probe.getImageData(0, 0, 1, 1).data[3] > 8) return l.id;
    }
    return null;
  }

  /** Ctrl+J: copy the selected pixels to a new layer (Ctrl+Shift+J cuts them). Without a selection: duplicate. */
  function viaCopy(cut: boolean) {
    if (!doc || !layer) return;
    if(cut&&layer.smartObject){toast("Rasterize this smart object before cutting its pixels.");return;}
    if (!doc.selection) return cut ? undefined : duplicate();
    const mask = getBitmap(doc.selection);
    if (!mask) return;
    const only = blankCanvas(doc.width, doc.height);
    renderDoc(only.getContext("2d")!, { ...doc, selection: null, layers: [{ ...layer, visible: true, opacity: 1, blend: "normal" }] });
    const c = only.getContext("2d")!;
    c.globalCompositeOperation = "destination-in";
    c.drawImage(mask, 0, 0);
    const key = `bmp:copy${Date.now().toString(36)}`;
    setBitmap(key, only);
    let next = addPaintLayer(doc, key);
    if (cut && layer.kind !== "adjust" && !layer.locks?.paint) {
      const target = getBitmap(layer.src);
      const edited = target && editSelected(doc, layer, { kind: "delete" }, target);
      if (edited) next = updateLayer(next, layer.id, { src: edited.key });
    }
    thumbs.current.clear();
    apply({ ...next, selection: null });
  }

  /** Ctrl+E merges the layer into the one below, Ctrl+Shift+E merges everything visible. */
  function merge(mode: boolean|MergeMode) {
    if (!doc || !layer||!canEdit) return;
    const several = multiIds();
    const resolved:MergeMode=typeof mode==="boolean"?(mode?"visible":several.length>1?"selected":"down"):mode;
    const ids=mergeLayerIds(doc,several,resolved);
    if (ids.length < 2) return;
    const flat = blankCanvas(doc.width, doc.height);
    const source=resolved==="group"?groupMergeSource(doc,ids,layer.group!):{...doc,layers:doc.layers.filter(l=>ids.includes(l.id))};
    renderDoc(flat.getContext("2d")!, { ...source, selection: null });
    const key = `bmp:merge${Date.now().toString(36)}`;
    setBitmap(key, flat);
    thumbs.current.clear();
    setMulti([]);
    const mergeGroup=resolved==="group"?(doc.groups?.[layer.group!]?.parent??null):undefined;
    apply(mergeInto(doc, ids, key, resolved==="group"?doc.groups?.[layer.group!]?.name??"Merged group":resolved==="down"?doc.layers.find(l=>l.id===ids[0])!.name:"Merged",mergeGroup));
  }

  /** Zoom as Photoshop shows it: 100% means one picture pixel per screen pixel. */
  const fitScale = () => {
    const c = canvasRef.current;
    return c && doc ? c.clientWidth / doc.width : 1;
  };
  function zoomActual(percent: number) {
    view.current = { zoom: Math.min(32, Math.max(0.05, percent / 100 / fitScale())), x: 0, y: 0 };
    applyView();
  }
  function zoomStep(factor: number) {
    const v = view.current;
    const next = Math.min(32, Math.max(0.05, v.zoom * factor));
    view.current = { zoom: next, x: (v.x * next) / v.zoom, y: (v.y * next) / v.zoom };
    applyView();
  }

  /** Photoshop's mask button: from the selection (Alt hides it instead), or a mask that shows everything. Again removes it. */
  function addMask(hide: boolean) {
    if (!doc || !layer) return;
    if (layer.mask) return apply(updateLayer(doc, layer.id, { mask: undefined }));
    let key: string | null = null;
    if (doc.selection) key = hide ? invertSelection(doc) : maskBitmap(doc);
    else {
      const full = allShape(doc);
      key = `bmp:mask${Date.now().toString(36)}`;
      setBitmap(key, full);
    }
    if (!key) return;
    thumbs.current.clear();
    setMaskEdit(layer.id);
    apply({ ...updateLayer(doc, layer.id, { mask: key }), selection: null });
  }

  function beginTransform(){
    if(!hist||!layer||!canEdit||!authorized||layer.kind==="adjust"||layer.locks?.position||quickMask||maskEdit||aiBusy||documents.busy||gesture.current||cropDrag.current||transformSession.current)return false;
    // The box sits on the visible pixels, not the layer's whole canvas; Cancel returns to the untrimmed history.
    const trimmed=trimLayerToContent(hist.present,layer.id);
    transformSession.current={history:hist,tool};if(trimmed){setHist(current=>current?{...current,present:trimmed}:current);thumbs.current.clear();}setTransforming(true);setTool("move");return true;
  }
  function finishTransform(accept:boolean){
    const session=transformSession.current;if(!session)return;transformDrag.current=null;transformSession.current=null;setTransforming(false);
    setHist(current=>accept&&current?commit(session.history,current.present):session.history);setTool(session.tool);thumbs.current.clear();
  }
  function startTransformDrag(handle:TransformHandle,event:React.PointerEvent<HTMLButtonElement>){
    if(event.button!==0||!transformSession.current)return;const current=liveDoc.current,target=current&&selectedLayer(current);if(!current||!target)return;
    transformDrag.current={doc:current,layer:target,handle,point:point(event)};event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveTransformDrag(event:React.PointerEvent<HTMLButtonElement>){
    const drag=transformDrag.current;if(!drag||!transformSession.current)return;
    const next=applyLayerTransform(drag.doc,drag.layer.id,dragLayerTransform(drag.layer,drag.handle,drag.point,point(event),{center:event.altKey,snap:event.shiftKey}));
    setHist(current=>current?replace(current,next):current);
  }
  function cancelTransformDrag(){const drag=transformDrag.current;transformDrag.current=null;if(drag&&transformSession.current)setHist(current=>current?replace(current,drag.doc):current);}
  function nudgeTransform(handle:TransformHandle,dx:number,dy:number){
    const current=liveDoc.current,target=current&&selectedLayer(current);if(!current||!target||!transformSession.current)return;
    const p=handle==="move"?{x:target.x,y:target.y}:transformCorner(target,handle);
    const next=handle==="rotate"?{...target,rotation:target.rotation+dx+dy}:dragLayerTransform(target,handle,p,{x:p.x+dx,y:p.y+dy});
    setHist(h=>h?replace(h,applyLayerTransform(current,target.id,next)):h);
  }

  function toggleQuickMask(){
    if(!doc||!canEdit||!authorized||gesture.current)return;
    setMaskEdit(null);
    if(quickMask){setQuickMask(false);setTool(quickMaskPreviousTool.current);}
    else{quickMaskPreviousTool.current=tool;setQuickMask(true);setTool("maskBrush");}
  }

  // Choosing another tool also leaves Quick Mask, keeping its instructions and
  // selection overlay in sync with what the canvas will actually do.
  useEffect(() => {
    if (quickMask && tool !== "maskBrush") setQuickMask(false);
  }, [quickMask, tool]);

  function selectionAction(kind: "invert" | "clear" | "mask" | "delete" | "fill" | "fillbg" | "all" | "reselect") {
    if (!doc) return;
    if (kind === "clear") {
      if (doc.selection) lastSelection.current = doc.selection;
      return apply({ ...doc, selection: null });
    }
    if (kind === "all") return apply({ ...doc, selection: combine(doc, allShape(doc), "replace") });
    if (kind === "reselect") return lastSelection.current ? apply({ ...doc, selection: lastSelection.current }) : undefined;
    if (kind === "invert") return apply({ ...doc, selection: invertSelection(doc) });
    if (kind === "mask") {
      const key = maskBitmap(doc);
      if (!key) return;
      const named = addPaintLayer(doc, key);
      return apply({ ...named, layers: named.layers.map((l) => (l.id === named.selectedId ? { ...l, name: "Mask" } : l)) });
    }
    const target = layer && getBitmap(layer.src);
    if (!layer || !target) return;
    if(layer.smartObject){toast("Rasterize this smart object before changing its pixels, or edit its contents.");return;}
    if (layer.kind === "adjust" || layer.locks?.paint) return;
    const edited = editSelected(doc, layer, kind === "delete" ? { kind: "delete" } : { kind: "fill", color: kind === "fillbg" ? colors.bg : colors.fg }, target);
    if (edited) {
      thumbs.current.clear();
      apply(updateLayer(doc, layer.id, { src: edited.key }));
    }
  }

  const [autoExtend,setAutoExtend]=useState(false);
  async function applyCropPreview() {
    if (!doc || !cropBox.current || isFullCrop(cropBox.current, dims(doc))) return;
    if(aiBusy||!canEdit)return;
    const snapshot=doc,signature=imageSignature(snapshot);
    try{
      const extending=hasExposedBorder(cropBox.current,doc.width,doc.height),rect=normalizeViewport(cropBox.current,extending);
      let next=cropViewport(snapshot,rect);
      if(extending){
        const route=precision??inpaint;
        if(!autoExtend||!route||!authorized)throw new Error("Enable Auto extend with a ready local fill workflow to generate the exposed border.");
        setAiBusy("fill");
        const source=blankCanvas(rect.w,rect.h);renderDoc(source.getContext("2d")!,next,{background:true});
        const border=exposedBorder(snapshot,rect),mask=blankCanvas(rect.w,rect.h),mc=mask.getContext("2d")!;
        mc.fillStyle="#000";mc.fillRect(0,0,rect.w,rect.h);mc.drawImage(border,0,0);
        const sourceAsset=await uploadPng(source,"image",`extend-source-${Date.now()}.png`);
        const maskAsset=await uploadPng(mask,"mask",`extend-mask-${Date.now()}.png`);
        const done=await runAndWait(route,{source_image:sourceAsset.id,edit_mask:maskAsset.id},{prompt:aiPrompt.trim()||"Extend the existing scene naturally beyond its borders with continuous perspective, lighting and texture. Do not add text or a frame.",...(precision?{mask_mode:"replace",feather_pct:0,context_pixels:64}:{denoise:1})});
        if(!done||!alive.current)return;
        if(done.state!=="succeeded"||!done.output_ids[0])throw new Error(done.error||"The extension did not finish. Your canvas was kept unchanged.");
        const {bitmap}=await loadBitmap(assetUrl(workspace.id,done.output_ids[0])),result=blankCanvas(rect.w,rect.h),rc=result.getContext("2d")!;
        rc.drawImage(bitmap,0,0,rect.w,rect.h);rc.globalCompositeOperation="destination-in";rc.drawImage(border,0,0);
        const key=`bmp:extend:${crypto.randomUUID()}`;setBitmap(key,result);next=addAiResultLayer(next,key,"Extended border");
      }
      if(!liveDoc.current||imageSignature(liveDoc.current)!==signature)throw new Error("The image changed while extending. The result remains in Library; the canvas was kept unchanged.");
      next=scaleViewport(next,Number(cropScale)||100);
      apply(next);fit();setCropBox(null);refreshBitmaps();
    }catch(error){toast((error as Error).message);}
    finally{if(alive.current)setAiBusy(null);}
  }

  function cancelCropPreview() {
    cropDrag.current = null;
    pointerDown.current = false;
    setCropBox(null);
    if (doc) paint(doc);
  }

  function cancelGesture() {
    if (cropDrag.current) {
      cropDrag.current = null;
      pointerDown.current = false;
      setCropPreview(cropBox.current);
      if (hist) paint(hist.present);
      return;
    }
    const current = gesture.current;
    const pan = panning.current;
    if (moveFrame.current) cancelAnimationFrame(moveFrame.current.raf);
    moveFrame.current = null;
    gesture.current = null;
    preview.current = null;
    pointerDown.current = false;
    panning.current = null;
    if (pan) { view.current = { ...view.current, x: pan.vx, y: pan.vy }; applyView(); }
    if (current) {
      thumbs.current.clear();
      setHist(h => h ? replace(h, current.start) : h);
      paint(current.start);
    }
  }

  finishPoly.current = () => up();
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if(e.defaultPrevented||e.isComposing)return;
    const target=e.target instanceof HTMLElement?e.target:null;
    if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==="g"&&target?.closest('.ds-layerrow__main')&&!document.querySelector('[role="dialog"][aria-modal="true"],[data-comfy-menu],[role="menu"]')){if(canEdit&&doc){e.preventDefault();groupSelected(true);}return;}
    if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==="t"&&!target?.isContentEditable&&!target?.closest('input,textarea,select')&&!document.querySelector('[role="dialog"][aria-modal="true"],[data-comfy-menu],[role="menu"]')){if(beginTransform())e.preventDefault();return;}
    if(ownsKeyboard(e.target, e.key))return;
    if (!hist || !doc) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // A focused control (button, radio, row, tab) gives the editor only tool keys, Escape, undo/redo, copy and the
    // select-all/deselect pair. Keys that erase, recolour, rotate or retune the layer need the picture or no focus:
    // typing a prompt with a button focused must not erase the selection or change the layer.
    const fromControl=!!target?.closest('button,a[href],[role="radio"],[role="tab"],[role="option"],[tabindex]:not(canvas)');
    if(fromControl&&!(mod?/^[zycad]$/.test(key):/^(?:[vhbemlwcisz]|escape)$/.test(key)))return;
    if(mod&&key==="t"&&(e.shiftKey||e.altKey))return;
    if(transformSession.current){e.preventDefault();if(key==="escape"||(mod&&key==="z"))finishTransform(false);else if(key==="enter")finishTransform(true);else if(e.key.startsWith("Arrow")){const d=e.shiftKey?10:1;nudgeTransform("move",e.key==="ArrowLeft"?-d:e.key==="ArrowRight"?d:0,e.key==="ArrowUp"?-d:e.key==="ArrowDown"?d:0);}return;}
    if(mod&&key==="t"){e.preventDefault();beginTransform();return;}
    const done = () => e.preventDefault();
    if (key === "escape" && (gesture.current || panning.current)) { done(); cancelGesture(); return; }
    if (key === "escape" && cropPreview) { done(); cancelCropPreview(); return; }
    if (preview.current?.poly && (key === "enter" || key === "escape")) {
      done();
      if (key === "escape") { preview.current = null; gesture.current = null; paint(doc); } else up();
      return;
    }
    if (gesture.current || panning.current) return;
    if (mod) {
      if (key === "z") { done(); setHist((h) => (h ? (e.shiftKey ? redo(h) : undo(h)) : h)); }
      else if (key === "c" && !window.getSelection()?.toString()) { done(); void copyImage(e.shiftKey); }
      else if (key === "y") { done(); setHist((h) => (h ? redo(h) : h)); }
      else if (key === "d") { done(); selectionAction(e.shiftKey ? "reselect" : "clear"); }
      else if (key === "i" && e.shiftKey) { done(); selectionAction("invert"); }
      else if (key === "a") { done(); selectionAction("all"); }
      else if (key === "j") { done(); viaCopy(e.shiftKey); }
      else if (key === "g" && !e.shiftKey && !e.altKey && canEdit) { done(); groupSelected(true); }
      else if (key === "g" && e.shiftKey && !e.altKey && canEdit && layer?.group) { done(); apply(ungroupLayer(doc, layer.id)); }
      else if (key === "e") { done(); merge(e.shiftKey); }
      else if ((key === "[" || key === "]") && layer) { done(); apply(e.shiftKey ? moveLayerToEdge(doc, layer.id, key === "]" ? "top" : "bottom") : moveLayer(doc, layer.id, key === "]" ? "up" : "down")); }
      else if (key === "0") { done(); fit(); }
      else if (key === "1") { done(); zoomActual(100); }
      else if (key === "=" || key === "+") { done(); zoomStep(1.25); }
      else if (key === "-") { done(); zoomStep(0.8); }
      else if (key === "s") { done(); if (e.shiftKey) void download(); else void documents.save().then(()=>toast("Layered document saved")).catch(()=>{}); }
      else if (key === "backspace") { done(); selectionAction("fillbg"); }
      return;
    }
    if (e.altKey && key === "backspace") { done(); selectionAction("fill"); return; }
    if (e.altKey && (key === "[" || key === "]") && layer) {
      const index=doc.layers.findIndex(item=>item.id===layer.id),next=doc.layers[index+(key==="]" ? 1 : -1)];
      if(next){done();layerAnchor.current=next.id;apply(selectLayer(doc,next.id));}
      return;
    }
    // Alt temporarily modifies the current tool; it must not activate bare-key shortcuts.
    if (e.altKey) return;
    if (key === "delete" || key === "backspace") { done(); if (doc.selection) selectionAction("delete"); else deleteSelected(); return; }
    if(key==="q"&&!e.shiftKey){done();toggleQuickMask();return;}
    const letters: Record<string, Tool> = { ...(segment ? { s: "subject" as Tool } : {}), v: "move", h: "hand", b: "brush", e: "eraser", m: "rect", l: "lasso", w: "wand", c: "crop", i: "eyedropper", z: "zoom" };
    if (key === "x" && !e.shiftKey) { done(); setColors((c) => ({ ...c, fg: c.bg, bg: c.fg })); return; }
    if (key === "d" && !e.shiftKey) { done(); setColors((c) => ({ ...c, fg: "#000000", bg: "#ffffff" })); return; }
    if (key === "r" && layer) { done(); apply(updateLayer(doc, layer.id, { rotation: ((layer.rotation + (e.shiftKey ? -90 : 90)) % 360 + 360) % 360 })); return; }
    if (letters[key] && !e.shiftKey) { done(); setTool(letters[key]); return; }
    if (key === "[" || key === "]") {
      done();
      setBrush((b) => ({ ...b, size: Math.min(200, Math.max(1, b.size + (key === "]" ? 1 : -1) * (b.size < 50 ? 5 : 10))) }));
      return;
    }
    if (/^[0-9]$/.test(e.key) && layer) {
      done();
      const now = Date.now();
      const text = now - digits.current.at < 700 ? digits.current.text + e.key : e.key;
      digits.current = { text: text.slice(-2), at: now };
      const percent = text.length >= 2 ? Number(text.slice(-2)) : e.key === "0" ? 100 : Number(e.key) * 10;
      applyLive(`o${layer.id}`, (d) => updateLayer(d, layer.id, { opacity: Math.min(1, percent / 100) }));
      return;
    }
    if (tool === "move" && layer && !layer.locks?.position && e.key.startsWith("Arrow")) {
      done();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      applyLive(`n${layer.id}`, (d) => moveWithLinks(d, layer.id, dx, dy));
    }
  };
  /* Clipboard like Photoshop: paste an image as a new layer; copy the selected pixels (or the whole picture). */
  const pasteHandler = useRef<(e: ClipboardEvent) => void>(() => {});
  const layerClip = useRef<{ key: string; bounds: Rect; name: string } | null>(null);
  pasteHandler.current = (e: ClipboardEvent) => {
    if (e.defaultPrevented || !canEdit || ownsKeyboard(e.target, "v")) return;
    const file = clipboardFile(e.clipboardData);
    const clip = layerClip.current;
    if (!file || !file.type.startsWith("image/")) {
      // The browser may not have allowed writing to the system clipboard: our own copy is still here.
      if (clip) { e.preventDefault(); pasteLayerClip(clip); }
      return;
    }
    e.preventDefault();
    // Our own copy comes back at its place; an image from elsewhere is added as before.
    void createImageBitmap(file).then((image) => {
      const ours = !!clip && image.width === clip.bounds.w && image.height === clip.bounds.h;
      image.close();
      if (ours) pasteLayerClip(clip!); else void addImage(file.name, URL.createObjectURL(file));
    }).catch(() => void addImage(file.name, URL.createObjectURL(file)));
  };
  /** A pasted copy is a new layer at the copied place, named after its source; the clipboard keeps it. */
  function pasteLayerClip(clip: { key: string; bounds: Rect; name: string }) {
    const current = liveDoc.current; if (!current) return;
    const fresh = cloneBitmap(clip.key, clip.bounds.w, clip.bounds.h).key;
    apply(addAiResultLayer(current, fresh, clip.name, clip.bounds));
  }
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => pasteHandler.current(e);
    addEventListener("paste", onPaste);
    return () => removeEventListener("paste", onPaste);
  }, []);

  /* Photoshop: Ctrl+C copies the active layer (inside the selection), Ctrl+Shift+C everything merged. The copy is
     kept here, outside the history, so undoing any number of steps never loses it; the system clipboard gets it too. */
  async function copyImage(merged = false) {
    if (!doc) return;
    const source = !merged && layer && layer.kind !== "adjust" ? layerCanvas(doc, layer) : null;
    const flat = source ?? blankCanvas(doc.width, doc.height);
    if (!source) renderDoc(flat.getContext("2d")!, { ...doc, selection: null });
    if (doc.selection) {
      const mask = getBitmap(doc.selection), c = flat.getContext("2d")!;
      if (mask) { c.globalCompositeOperation = "destination-in"; c.drawImage(mask, 0, 0); c.globalCompositeOperation = "source-over"; }
    }
    const pixels = flat.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, doc.width, doc.height).data;
    const bounds = alphaBounds(pixels, doc.width, doc.height);
    if (!bounds) { toast(doc.selection ? "The selected area is empty on this layer." : "This layer is empty."); return; }
    const out = blankCanvas(bounds.w, bounds.h);
    out.getContext("2d")!.drawImage(flat, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
    const key = `bmp:clip${Date.now().toString(36)}`; setBitmap(key, out);
    layerClip.current = { key, bounds, name: source && layer ? `${layer.name} copy` : "Merged copy" };
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": await toPng(out) })]);
    } catch { /* the editor's own copy still pastes */ }
    toast(source ? (doc.selection ? "Selection copied from the layer" : "Layer copied") : "Merged copy");
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const point = (event: React.PointerEvent<HTMLElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) * doc!.width) / rect.width, y: ((event.clientY - rect.top) * doc!.height) / rect.height };
  };

  const capture = (event: React.PointerEvent<HTMLElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* a pointer that cannot be captured still draws */
    }
  };

  /** Color of the visible picture at a document point, as hex. */
  function sampleHex(p: { x: number; y: number }): string {
    const canvas = pickCanvas.current;
    const source = canvas && canvas.width === doc!.width && canvas.height === doc!.height ? canvas : blankCanvas(doc!.width, doc!.height);
    if (source !== canvas) renderDoc(source.getContext("2d")!, doc!, { background: true });
    const px = source.getContext("2d")!.getImageData(Math.min(doc!.width - 1, Math.max(0, Math.floor(p.x))), Math.min(doc!.height - 1, Math.max(0, Math.floor(p.y))), 1, 1).data;
    return `#${[px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  function down(event: React.PointerEvent<HTMLElement>) {
    if(transformSession.current){canvasRef.current?.focus();return;}
    if (event.button !== 0 && event.button !== 1) return;
    canvasRef.current?.focus({ preventScroll: true });
    pointerDown.current = true;
    if(tool==="subject"&&doc&&event.button===0&&!spaceDown.current){
      if(!canEdit||!segment){pointerDown.current=false;if(canEdit&&!segment)setSelectionUnavailable(true);return;}
      const cached=objectRegions.current,p=point(event);
      const mode=event.altKey?"subtract":event.shiftKey?"add":selMode, signature=imageSignature(doc);
      const select=(regions:ObjectRegion[])=>{const current=liveDoc.current;if(!current||imageSignature(current)!==signature)return;const index=hitObject(regions,p.x,p.y,current.width,current.height);if(index>=0){apply({...current,selection:combine(current,regions[index].canvas,mode)});const label=regions[index].label;if(label)toast(`Selected ${label}`);}else toast("No region found at this point.");};
      if(cached?.signature===signature&&(cached.regions.length||objectScan?.status!=="analysing"))select(cached.regions);
      else if(objectScan?.signature===signature&&objectScan.status==="analysing")toast("Still analysing the picture.");
      else void analyseObjects().then(regions=>{if(regions)select(regions);});
      pointerDown.current=false;return;
    }
    if (tool === "crop" && doc) {
      const box = cropBox.current ?? fullCrop(dims(doc));
      const hit = cropHandleAt(box, point(event), Math.max(12, doc.width * 0.025));
      if (hit) {
        cropBox.current = box;
        cropDrag.current = hit;
        cropStart.current={rect:box,point:point(event)};
        capture(event);
        return;
      }
    }
    if (gesture.current?.kind === "select" && preview.current?.poly && doc) {
      capture(event);
      preview.current.pts.push(point(event));
      preview.current.rubber = undefined;
      paint(doc);
      return;
    }
    if (tool === "hand" || event.button === 1 || spaceDown.current) {
      capture(event);
      panning.current = { px: event.clientX, py: event.clientY, vx: view.current.x, vy: view.current.y };
      return;
    }
    const selectionStroke=tool==="maskBrush";
    if (!doc || !canEdit) return;
    const p = point(event);
    if(tool==="move"&&!layer){const hit=layerAt(doc,p);if(hit)apply(selectLayer(doc,hit));pointerDown.current=false;return;}
    if (SELECT_TOOLS.includes(tool)) {
      const mode: SelectMode = event.shiftKey && event.altKey ? "intersect" : event.shiftKey ? "add" : event.altKey ? "subtract" : selMode;
      const mask=doc.selection?getBitmap(doc.selection):undefined;
      const x=Math.floor(p.x),y=Math.floor(p.y);
      const hit=mask&&x>=0&&y>=0&&x<doc.width&&y<doc.height?(()=>{const pixel=blankCanvas(1,1),ctx=pixel.getContext("2d")!;ctx.drawImage(mask,x,y,1,1,0,0,1,1);return ctx.getImageData(0,0,1,1).data[3]>0;})():false;
      if((tool==="rect"||tool==="lasso")&&mode==="replace"&&hit){capture(event);gesture.current={kind:"move-selection",start:doc,px:p.x,py:p.y};return;}
      if(tool==="wand"){capture(event);gesture.current={kind:"wand",start:doc,at:p,clientX:event.clientX,tolerance,mode};setHist(h=>h?replace(h,{...doc,selection:combine(doc,wandShape(doc,p,tolerance,{contiguous}),mode)}):h);return;}
      if(tool==="rect"||tool==="lasso"){capture(event);gesture.current={kind:"select",start:doc,mode};preview.current={kind:tool,pts:[p]};return;}
    }
    if (!layer || (!layer.visible&&!selectionStroke)) return;
    capture(event);
    if(tool==="magicEraser"){
      if(magicMode==="colour"){
        magicSource.current={signature:imageSignature(doc),layerId:layer.id};
        eraseMagicRegion({...doc,selection:combine(doc,wandShape(doc,p,tolerance,{contiguous,onlyLayer:layer.id}),"replace")},layer);
      }
      pointerDown.current=false;return;
    }
    if (tool === "move") {
      const hit = event.ctrlKey || event.metaKey ? layerAt(doc, p) : null;
      if (hit && hit !== layer.id) {
        apply(selectLayer(doc, hit));
        return;
      }
      if (layer.locks?.position) return;
      gesture.current = { kind: "move", start: doc, px: p.x, py: p.y, lx: layer.x, ly: layer.y };
      return;
    }
    if (tool === "zoom") {
      zoomStep(event.altKey ? 0.8 : 1.25);
      return;
    }
    if (tool === "crop") {
      gesture.current = { kind: "select", start: doc, mode: "replace", crop: true };
      preview.current = { kind: "rect", pts: [p] };
      return;
    }
    if (tool === "eyedropper" || (tool === "brush" && event.altKey && !quickMask)) {
      const hex = sampleHex(p);
      setColors((c) => ({ ...c, [tool === "eyedropper" && event.altKey ? "bg" : "fg"]: hex }));
      return;
    }
    const onSelection=selectionStroke;
    const onMask = maskEdit === layer.id && !!layer.mask && (tool === "brush" || tool === "eraser");
    if(layer.smartObject&&!onSelection&&!onMask&&(tool==="brush"||tool==="eraser")){pointerDown.current=false;toast("Rasterize this smart object before painting its pixels, or edit its contents.");return;}
    strokeMask.current = onMask||onSelection;
    strokeErase.current=tool==="eraser"||(onSelection&&event.altKey);
    if (!onMask && !onSelection && (layer.kind === "adjust" || layer.locks?.paint)) return;
    const copy = onSelection?cloneBitmap(doc.selection??"",doc.width,doc.height):onMask ? cloneLayerMask(doc,layer) : cloneBitmap(layer.src, layer.w, layer.h);
    const next = onSelection?{...doc,selection:copy.key}:updateLayer(doc, layer.id, onMask ? { mask: copy.key, maskOff: false } : { src: copy.key });
    const painted: Layer = onMask||onSelection ? { ...layer,id:onSelection?"precision-selection":layer.id,src: copy.key, w: doc.width, h: doc.height, x: doc.width / 2, y: doc.height / 2, scale: 1, rotation: 0, flipX: false, locks: undefined } : { ...layer, src: copy.key };
    /* Shift-click draws a straight line from where the last stroke ended. */
    const from = event.shiftKey && lastStroke.current?.layerId === painted.id ? lastStroke.current.p : p;
    gesture.current = { kind: "paint", start: doc, canvas: copy.canvas, surface:createBrushStroke(copy.canvas,onSelection?null:selectionInLayerSpace(doc,painted)), layer: painted, last: toLayerPoint(painted, p.x, p.y), lastDoc: p };
    brushTrail.current = { x: 0, y: 0, started: false, stamp: 0 };
    setHist((h) => (h ? replace(h, next) : h));
    stroke(copy.canvas, painted, toLayerPoint(painted, from.x, from.y), gesture.current.last);
    refreshBitmaps();
  }

  function stamp(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
    const trail = brushTrail.current;
    ctx.save();
    ctx.fillStyle = color;
    const superSoft=brush.style==="round-super-soft";
    const blur=superSoft?0:brushEdgeBlur(size,brush.hardness);if(blur>0)ctx.filter=`blur(${blur}px)`;
    if (brush.style === "grain") {
      let seed = (Math.imul(trail.stamp + 1, 1664525) + 1013904223) >>> 0;
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      ctx.globalAlpha *= 0.72;
      ctx.beginPath();
      ctx.arc(x, y, size * 0.34, 0, Math.PI * 2);
      ctx.fill();
      for (let dot = 0; dot < 12; dot++) {
        const angle = random() * Math.PI * 2;
        const radius = size * 0.46 * Math.sqrt(random());
        const speck = size * (0.045 + random() * 0.075);
        ctx.beginPath();
        ctx.arc(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, speck, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      if(superSoft){
        paintSuperSoftRound(ctx,x,y,size,color,brush.hardness);
      } else if (brush.style.startsWith("square")) {
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    trail.stamp += 1;
  }

  function stroke(canvas: HTMLCanvasElement, painted: Layer, from: { x: number; y: number }, to: { x: number; y: number }) {
    if(strokeMask.current)outlineRevision.current++;
    const active=gesture.current;if(active?.kind!=="paint")return;
    const ctx = active.surface.paint.getContext("2d")!;
    const finish=()=>compositeBrushStroke(canvas,active.surface,brush.opacity,strokeErase.current?"destination-out":painted.locks?.transparent?"source-atop":"source-over");
    const size = Math.max(1, brush.size / (painted.scale || 1));
    const color = strokeMask.current ? "#fff" : colors.fg;
    ctx.save();
    ctx.globalAlpha = brush.flow / 100;
    ctx.globalCompositeOperation = "source-over";
    const trail = brushTrail.current;
    if (!trail.started) {
      trail.started = true;
      trail.x = from.x;
      trail.y = from.y;
      stamp(ctx, from.x, from.y, size, color);
    }
    const dx = to.x - trail.x, dy = to.y - trail.y, distance = Math.hypot(dx, dy);
    const spacing = Math.max(1, size * (brush.style === "grain" ? 0.22 : 0.12));
    if (distance < spacing) {
      ctx.restore();finish();
      return;
    }
    const ux = dx / distance, uy = dy / distance;
    let travelled = spacing;
    while (travelled <= distance) {
      stamp(ctx, trail.x + ux * travelled, trail.y + uy * travelled, size, color);
      travelled += spacing;
    }
    const last = travelled - spacing;
    trail.x += ux * last;
    trail.y += uy * last;
    ctx.restore();finish();
  }

  function moveEvent(event: React.PointerEvent<HTMLElement>) {
    if(tool==="subject"&&doc&&!pointerDown.current){
      const cached=objectRegions.current,p=point(event),index=cached?.signature===imageSignature(doc)?hitObject(cached.regions,p.x,p.y,doc.width,doc.height):-1;
      if(index!==hoveredObject.current){hoveredObject.current=index;paint(doc);}return;
    }
    if (cropDrag.current && doc) {
      if(cropStart.current)setCropBox(dragCrop(cropStart.current.rect,cropDrag.current,cropStart.current.point,point(event),dims(doc),autoExtend));
      paint(doc);
      return;
    }
    const ring = ringRef.current;
    if (ring) {
      if ((tool === "brush" || tool === "eraser"||tool==="maskBrush") && doc) {
        const r = event.currentTarget.getBoundingClientRect();
        const d = Math.max(4, brush.size * (r.width / doc.width));
        ring.style.display = "block";
        ring.style.width = `${d}px`;
        ring.style.height = `${d}px`;
        ring.style.borderRadius = brush.style.startsWith("square") ? "12%" : "50%";
        ring.style.left = `${event.clientX}px`;
        ring.style.top = `${event.clientY}px`;
      } else ring.style.display = "none";
    }
    if (panning.current) {
      view.current = { ...view.current, x: panning.current.vx + event.clientX - panning.current.px, y: panning.current.vy + event.clientY - panning.current.py };
      applyView();
      return;
    }
    if ((tool === "eyedropper" || (tool === "brush" && event.altKey && !quickMask)) && doc && pointerDown.current) {
      const p = point(event);
      const hex = sampleHex(p);
      const channel = tool === "brush" ? "fg" : event.altKey ? "bg" : "fg";
      setColors((c) => (c[channel] === hex ? c : { ...c, [channel]: hex }));
      return;
    }
    const g = gesture.current;
    if (!g || !doc) return;
    const p = point(event);
    if(g.kind==="move-selection") { const source=g.start.selection&&getBitmap(g.start.selection);if(source){const shape=blankCanvas(g.start.width,g.start.height);shape.getContext("2d")!.drawImage(source,Math.round(p.x-g.px),Math.round(p.y-g.py));setHist(h=>h?replace(h,{...g.start,selection:combine(g.start,shape,"replace")}):h);}return; }
    if(g.kind==="wand") { const next=Math.max(0,Math.min(255,Math.round(g.tolerance+event.clientX-g.clientX)));setTolerance(next);setHist(h=>h?replace(h,{...g.start,selection:combine(g.start,wandShape(g.start,g.at,next,{contiguous}),g.mode)}):h);return; }
    if (g.kind === "select") {
      const pts = preview.current!.pts;
      if (preview.current!.kind === "rect") {
        const ratio = g.crop ? ratioOf(cropRatio) : null;
        const q = ratio ? ratioPoint(pts[0], p, ratio) : p;
        preview.current!.pts = [pts[0], q];
        preview.current!.rect = marqueeRect(pts[0], q, g.crop ? false : event.shiftKey, g.crop ? false : event.altKey && g.mode === "replace");
      } else if (event.altKey || (preview.current!.poly && !(event.buttons & 1))) {
        preview.current!.rubber = p;
      } else {
        pts.push(p);
        preview.current!.rubber = undefined;
      }
      paint(doc);
      return;
    }
    if (g.kind === "move") {
      /* One update per animation frame with the latest pointer position keeps dragging smooth on big images. */
      const pending = moveFrame.current ?? (moveFrame.current = { raf: 0, dx: 0, dy: 0 });
      pending.dx = p.x - g.px;
      pending.dy = p.y - g.py;
      if (event.shiftKey) {
        if (Math.abs(pending.dx) >= Math.abs(pending.dy)) pending.dy = 0;
        else pending.dx = 0;
      }
      if (!pending.raf) pending.raf = requestAnimationFrame(() => {
        pending.raf = 0;
        setHist((h) => (h ? replace(h, moveWithLinks(g.start, g.start.selectedId!, pending.dx, pending.dy)) : h));
      });
      return;
    }
    const to = toLayerPoint(g.layer, p.x, p.y);
    stroke(g.canvas, g.layer, g.last, to);
    g.last = to;
    g.lastDoc = p;
    if (hist) paint(hist.present);
  }

  function up(event?: React.PointerEvent<HTMLElement>) {
    if (event?.type === "pointerup" || event?.type === "pointercancel") pointerDown.current = false;
    if (cropDrag.current) {
      cropDrag.current = null;
      setCropPreview(cropBox.current);
      return;
    }
    if (panning.current) {
      panning.current = null;
      return;
    }
    const open = gesture.current?.kind === "select" && preview.current?.kind === "lasso" ? preview.current : null;
    if (open && event) {
      if (event.type !== "pointerup") { if (open.poly) return; }
      else if (event.altKey) {
        open.poly = true;
        open.pts.push(point(event));
        open.rubber = undefined;
        if (hist) paint(hist.present);
        return;
      }
    }
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const queued = moveFrame.current;
    if (queued) {
      cancelAnimationFrame(queued.raf);
      moveFrame.current = null;
      if (g.kind === "move") setHist((h) => (h ? replace(h, moveWithLinks(g.start, g.start.selectedId!, queued.dx, queued.dy)) : h));
    }
    if (g.kind === "select") {
      const shape = preview.current;
      preview.current = null;
      if (g.crop) {
        if (shape?.rect) {
          setCropBox(shape.rect);
          paint(g.start);
        } else {
          setCropBox(null);
          if (hist) paint(hist.present);
        }
        return;
      }
      if (shape && (shape.pts.length > 2 || (shape.kind === "rect" && shape.rect))) {
        const canvas = shape.kind === "rect" ? rectShape(g.start, shape.rect!) : lassoShape(g.start, shape.pts);
        apply({ ...g.start, selection: combine(g.start, canvas, g.mode) });
      } else if (shape && shape.kind === "rect" && g.start.selection) apply({ ...g.start, selection: null });
      else if (hist) paint(hist.present);
      return;
    }
    if (g.kind === "paint") lastStroke.current = { layerId: g.layer.id, p: g.lastDoc };
    thumbs.current.clear();
    setHist((h) => (h && h.present !== g.start ? { past: [...h.past, g.start].slice(-40), present: h.present, future: [] } : h));
    refreshBitmaps();
  }

  /** Saves the flattened picture as a new version of the open asset. Throws when it could not be saved. */
  async function savePng(): Promise<Asset | undefined> {
    const canvas = canvasRef.current;
    if (!canvas || !doc || savePending.current || !canEdit || !authorized) return undefined;
    savePending.current = true;
    setSaving(true);
    try {
      const out = blankCanvas(doc.width, doc.height);
      renderDoc(out.getContext("2d")!, doc);
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("The image could not be exported.");
      const form = new FormData();
      form.append("file", new File([blob], `edit-${Date.now()}.png`, { type: "image/png" }));
      const parent = openAssetId ? `&parentId=${encodeURIComponent(openAssetId)}` : "";
      return await call<Asset>(workspacePath(workspace.id, `assets?projectId=${project.id}${parent}`), "POST", form);
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  }
  async function save() {
    try { if (await savePng()) toast("Saved to Library"); } catch (e) { toast((e as Error).message); }
  }
  /* Use as first frame: the picture goes to the same places as from the full view (TeamApp mediaTools):
     Create Video as its start picture, or Swap a thing as its first frame. Only targets ready here are listed; the
     picture is saved to the Library first, so the tool receives a project file. */
  const mediaTools = useMediaEditor().tools;
  const FIRST_FRAME = ["animate", "swap-first-frame"];
  const firstFrameTargets = (mediaTools?.({ src: "", name: "", mediaType: "image" })?.openIn ?? []).filter((target) => FIRST_FRAME.includes(target.id));
  async function useAsFirstFrame(id: string) {
    try {
      const asset = await savePng();
      if (!asset) return;
      await mediaTools?.({ src: assetUrl(workspace.id, asset.id), name: asset.name, mediaType: "image" })?.openIn?.find((target) => target.id === id)?.run();
    } catch (e) { toast((e as Error).message); }
  }
  /* Opened from a tool's reference slot: the edited picture goes back into that slot. */
  const [returnTicket] = useState(() => referenceEditFor(workspace.id, openAssetId));
  const [returnError, setReturnError] = useState("");
  async function useInTool() {
    if (!returnTicket) return;
    setReturnError("");
    try {
      const asset = await savePng();
      if (!asset) return;
      finishReferenceEdit(returnTicket, asset.id);
      location.hash = returnTicket.returnHash;
    } catch (e) { setReturnError((e as Error).message); }
  }
  function backWithoutChanges() {
    if (!returnTicket) return;
    cancelReferenceEdit();
    location.hash = returnTicket.returnHash;
  }

  async function download() {
    if (!doc || downloadPending.current) return;
    downloadPending.current = true;
    setDownloading(true);
    try {
      const out = blankCanvas(doc.width, doc.height);
      renderDoc(out.getContext("2d")!, doc);
      const url = URL.createObjectURL(await toPng(out));
      const link = document.createElement("a");
      link.href = url;
      link.download = `edit-${Date.now()}.png`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      downloadPending.current = false;
      setDownloading(false);
    }
  }

  function downloadSwapProvenance() {
    if (!swapCheck) return;
    const blob = new Blob([JSON.stringify(swapCheckProvenance(swapCheck, { workspaceId: workspace.id, projectId: project.id }), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = swapCheckProvenanceName(swapCheck.run);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const thumbKey = (key: string) => {
    const cached = thumbs.current.get(key);
    if (cached) return cached;
    const bitmap = getBitmap(key);
    if (!bitmap) return undefined;
    const { w, h } = sizeOf(bitmap);
    const small = blankCanvas(64, 64);
    const k = Math.min(64 / w, 64 / h);
    const sc = small.getContext("2d")!;
    sc.drawImage(bitmap, (64 - w * k) / 2, (64 - h * k) / 2, w * k, h * k);
    sc.globalCompositeOperation = "source-in";
    sc.fillStyle = "#fff";
    sc.fillRect(0, 0, 64, 64);
    const url = small.toDataURL();
    thumbs.current.set(key, url);
    return url;
  };

  const thumbOf = (l: Layer) => {
    const cached = thumbs.current.get(l.src);
    if (cached) return cached;
    const bitmap = getBitmap(l.src);
    if (!bitmap) return undefined;
    const { w, h } = sizeOf(bitmap);
    const small = blankCanvas(64, 64);
    const k = Math.min(64 / w, 64 / h);
    small.getContext("2d")!.drawImage(bitmap, (64 - w * k) / 2, (64 - h * k) / 2, w * k, h * k);
    const url = small.toDataURL();
    thumbs.current.set(l.src, url);
    return url;
  };


  /** Rows top first. Folder nesting follows the saved group hierarchy. */
  function layerRows() {
    /* stop editing a mask whose layer is gone */
    if (!doc) return null;
    const rows: ReactNode[] = [];
    const seen = new Set<string>();
    for (const l of [...doc.layers].reverse()) {
      const groups = groupAncestors(doc,l.group).reverse();
      groups.forEach((gid,index)=>{
        const g=doc.groups?.[gid];
        if(!g||seen.has(gid)||groups.slice(0,index).some(parent=>collapsedGroups.has(parent)))return;
        seen.add(gid);
        const first=doc.layers.slice().reverse().find(x=>isGroupDescendant(doc,gid,x.group));
        if(first)rows.push(<LayerRow key={`group-${gid}`} name={g.name} depth={index} thumb={collapsedGroups.has(gid)?<Folder size={18} aria-label="Expand group"/>:<FolderOpen size={18} aria-label="Collapse group"/>} visible={g.visible} selected={false} onSelect={() => setCollapsedGroups(previous=>{const next=new Set(previous);if(next.has(gid))next.delete(gid);else next.add(gid);return next;})} onOpen={()=>setGroupSettingsId(gid)} onToggle={() => apply(toggleGroup(doc, gid))} />);
      });
      if(groups.some(gid=>collapsedGroups.has(gid)))continue;
      const depth=groups.length+(l.clip?1:0);
      const picture = thumbOf(l);
      rows.push(
        <div key={l.id} className="cf-layer-slot" onContextMenu={e=>{
          e.preventDefault();
          layerAnchor.current=l.id;setMulti([]);apply(selectLayer(doc,l.id));
          setMenu({x:e.clientX,y:e.clientY,items:[
            {id:"merge-down",label:"Merge down",onSelect:()=>merge("down")},
            {id:"merge-visible",label:"Merge visible",onSelect:()=>merge("visible")},
            {id:"merge-all",label:"Merge all",onSelect:()=>merge("all")},
            {id:"duplicate",label:"Duplicate layer",onSelect:duplicate},
            {id:"group",label:"Group selected",onSelect:()=>groupSelected(true)},
            {id:"delete",label:`Delete “${l.name}”`,danger:true,onSelect:deleteSelected},
          ]});
        }}>
        <LayerRow
          name={l.name} depth={depth} mask={l.mask && thumbKey(l.mask) ? <img src={thumbKey(l.mask)} alt="" /> : undefined} thumb={picture ? <img src={picture} alt="" title="Ctrl-click to select layer pixels" onClick={e=>{if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault();e.stopPropagation();const mode:SelectMode=e.shiftKey?(e.altKey?"intersect":"add"):(e.altKey?"subtract":"replace");const selection=selectLayerPixels(doc,l,mode);if(selection)apply({...doc,selection});else toast("The layer pixels are not available.");}} /> : l.kind === "adjust" ? <Contrast size={18} /> : undefined}
          maskOff={l.maskOff} maskActive={maskEdit === l.id && !!l.mask}
          onMask={(ev) => {
            if (ev.shiftKey) return apply(updateLayer(doc, l.id, { maskOff: !l.maskOff }));
            apply(selectLayer(doc, l.id));
            setTool((t) => (t === "brush" || t === "eraser" ? t : "brush"));
            setQuickMask(false);setMaskEdit((m) => (m === l.id ? null : l.id));
          }}
          onMaskMenu={(ev) => {
            apply(selectLayer(doc, l.id));
            setMenu({ x: ev.clientX, y: ev.clientY, items: [
              { id: "edit", label: maskEdit === l.id ? "Stop editing mask" : "Edit mask (brush shows, eraser hides)", onSelect: () => { setTool((t) => (t === "brush" || t === "eraser" ? t : "brush")); setQuickMask(false);setMaskEdit((m) => (m === l.id ? null : l.id)); } },
              { id: "toggle", label: l.maskOff ? "Enable mask" : "Disable mask", onSelect: () => apply(updateLayer(doc, l.id, { maskOff: !l.maskOff })) },
              { id: "invert", label: "Invert mask", onSelect: () => apply(updateLayer(doc, l.id, { mask: invertSelection({ ...doc, selection: effectiveLayerMaskKey(doc,l)! }), maskOff: false })) },
              { id: "area", label: "Select mask area", onSelect: () => apply({ ...doc, selection: maskBitmap({ ...doc, selection: effectiveLayerMaskKey(doc,l)! }) }) },
              ...(doc.selection ? [{ id: "replace", label: "Replace mask with selection", onSelect: () => apply(updateLayer(doc, l.id, { mask: maskBitmap(doc)!, maskOff: false })) }] : []),
              { id: "apply", label: "Apply mask to the layer", onSelect: () => { const bm = getBitmap(l.src); const k = bm && applyMaskToLayer(doc, l, bm); if (k) { thumbs.current.clear(); setMaskEdit((m) => (m === l.id ? null : m)); apply(updateLayer(doc, l.id, { src: k, mask: undefined, maskOff: undefined })); } } },
              { id: "delete", label: "Delete mask", danger: true, onSelect: () => { setMaskEdit((m) => (m === l.id ? null : m)); apply(updateLayer(doc, l.id, { mask: undefined, maskOff: undefined })); } },
            ] });
          }}
          visible={l.visible} selected={l.id === doc.selectedId || multi.includes(l.id)} linked={l.linked} dragging={dragging === l.id}
          onSelect={(e) => {
            if (e.altKey) return apply(updateLayer(doc, l.id, { clip: !l.clip }));
            if (e.shiftKey && doc.selectedId && l.id !== doc.selectedId) {
              const order=doc.layers.map(item=>item.id),from=layerAnchor.current??doc.selectedId;
              const a=order.indexOf(from),b=order.indexOf(l.id);
              if(a>=0&&b>=0)setMulti(order.slice(Math.min(a,b),Math.max(a,b)+1).filter(id=>id!==l.id));
              apply(selectLayer(doc,l.id));
              return;
            }
            layerAnchor.current=l.id;setMulti([]);
            apply(selectLayer(doc, l.id));
          }}
          onOpen={() => { setMulti([]); apply(selectLayer(doc, l.id)); setFloating(l.kind === "adjust" ? "adjust" : "style"); }}
          onRename={name => { const current=liveDoc.current; if(current&&current.layers.some(item=>item.id===l.id))apply(updateLayer(current,l.id,{name})); }}
          onToggle={() => apply(updateLayer(doc, l.id, { visible: !l.visible }))}
          onDragStart={() => { dragId.current = l.id; setDragging(l.id); }}
          dropTarget={dropId === l.id && dragging !== l.id}
          onDragOver={() => { if (dragId.current && dragId.current !== l.id) setDropId(l.id); }}
          onDrop={() => { if (dragId.current && dragId.current !== l.id) apply(reorderLayer(doc, dragId.current, l.id)); dragId.current = null; setDragging(null); setDropId(null); }}
          onDragEnd={() => { dragId.current = null; setDragging(null); setDropId(null); }}
        />
        </div>,
      );
    }
    return rows;
  }

  if (!doc) {
    return (
      <div className="cf-editor">
        <Page narrow>
          <EmptyState
            stage
            title="Edit an image"
            action={
              <div className="cf-editor-start">
                <div className="cf-editor-start__inputs">
                <UploadSlot label="Open an image or PSD" hint="Drop a file or choose from this device" accept="image/*,.psd,.psb" disabled={!canEdit} onFile={addFile} />
                <Row label="Project image" display="Choose from Library" onClick={() => setPicker(true)} disabled={!authorized} />
                {authorized&&canEdit&&<Row label="Open document" display="Saved layers and recovery drafts" onClick={()=>setDocumentPicker(true)}/>}
                <Row label="New document" display="Choose canvas size" onClick={() => setCustomOpen(true)} />
                </div>
                {authorized&&canEdit&&<RecentDocuments records={documents.records} workspaceId={workspace.id} projectId={project.id} call={call} busy={documents.busy} onOpen={id=>void documents.open(id).catch(()=>{})}/>}
              </div>
            }
          />
        </Page>
        <Dialog open={customOpen} title="Blank canvas, any size" onClose={()=>setCustomOpen(false)} className="ds-dialog--choice" footer={<><Button onClick={()=>setCustomOpen(false)}>Cancel</Button><Button variant="primary" disabled={!(+customW>=16&&+customW<=8192&&+customH>=16&&+customH<=8192)} onClick={()=>{setCustomOpen(false);blank(Math.round(+customW),Math.round(+customH));}}>Create</Button></>}>
          {BLANKS.map(b=><Row key={b.id} label="Blank canvas" display={b.label} onClick={()=>{setCustomOpen(false);blank(b.w,b.h);}}/>)}
          <TextField label="Width in px" value={customW} onChange={setCustomW}/>
          <TextField label="Height in px" value={customH} onChange={setCustomH}/>
          <Meta>From 16 to 8192 px on each side: 4:5, 21:9, a banner, a print size, anything.</Meta>
        </Dialog>
        <AssetPicker open={picker} assets={assets} workspace={workspace.id} canEdit={canEdit} onFile={(f) => { setPicker(false); addFile(f); }} onClose={() => setPicker(false)} onPick={(a) => { setPicker(false); void addImage(a.name, assetUrl(workspace.id, a.id)); }} />
        {documentDialog}
        {documentNotice}{returnError&&<Notice priority={55} title="The edited picture was not sent back" actions={<Button variant="secondary" onClick={() => void useInTool()}>Try again</Button>}>{returnError}</Notice>}
      {placementDraft.error&&<Notice priority={35} title="Placement draft" actions={<><Button variant="secondary" onClick={placementDraft.retry}>Retry draft</Button><Button variant="ghost" onClick={clearCharacterPlacement}>Clear draft</Button></>}>{placementDraft.error}</Notice>}
      </div>
    );
  }

  const selectedIds = doc && layer ? [layer.id, ...multi.filter((id) => id !== layer.id && doc.layers.some((l) => l.id === id))] : [];

  const nudgeField = (id: string, label: string, value: number, make: (v: number) => Partial<Layer>) => (
    <TextField key={id} label={label} type="number" value={String(Math.round(value))} onChange={(v) => v !== "" && applyLive(`${id}${layer!.id}`, (d) => updateLayer(d, layer!.id, make(Number(v))))} />
  );
  const align = (to: AlignTo) => layer && apply(alignLayer(doc, layer.id, to));
  const ZOOMS = [{ value: "fit", label: "Fit" }, ...[25, 50, 100, 200, 400].map((z) => ({ value: String(z), label: `${z}%` }))];
  const modifyMode = resolveEditMode(editIntent, aiPrompt, !!doc.selection);
  const modifyScope = resolveEditScope(editScope, aiPrompt, !!doc.selection);
  const modifyRouteReady = !!edit || !!(doc.selection && ((modifyMode === "fill" && inpaint) || (precision && preserveOriginal && modifyScope !== "image" && !hasReference)));
  const modifyUnavailableReason = !modifyRouteReady
    ? doc.selection && (precision || inpaint)
      ? "Choose Fill selection or enable Preserve original to use the available local edit workflow."
      : precision || inpaint
        ? "Select an area to use the available local edit workflow, or connect a whole-image editor."
        : "A compatible image-edit workflow is not ready on the selected compute target."
    : undefined;
  /* The one action that makes AI Modify work here: finish the selection in this editor, or open the
     place where the missing workflow is set up. A catalogue is not the fix for a missing selection. */
  const modifyFix = modifyRouteReady ? null
    : !precision && !inpaint
      ? { label: "Open Models", run: () => { if (onOpenModels) onOpenModels(); else location.hash = "catalogue"; } }
      : doc.selection
        ? (inpaint && !precision ? { label: "Use Fill selection", run: () => setEditIntent("fill") } : { label: "Turn on Preserve original", run: () => setPreserveOriginal(true) })
        : { label: segment ? "Select the subject" : "Select an area", run: () => setTool(segment ? "subject" : "lasso") };


  return (
    <div className="cf-editor">
      <Page workspace>
        <OptionsBar
          end={transforming?undefined:(
            <>
              <InfoButton title="Shortcuts">
      <ShortcutSheet groups={SHORTCUT_GROUPS} note="Flow builds paint or erasure gradually; layer opacity stays unchanged." />
              </InfoButton>
              <IconButton label="Undo" disabled={!hist || hist.past.length === 0} onClick={() => setHist((h) => (h ? undo(h) : h))}><Undo2 size={16} /></IconButton>
              <IconButton label="Redo" disabled={!hist || hist.future.length === 0} onClick={() => setHist((h) => (h ? redo(h) : h))}><Redo2 size={16} /></IconButton>
              <Button variant="secondary" disabled={downloading} onClick={() => void download()}>{downloading ? "Exporting…" : "Download PNG"}</Button>
              {returnTicket && canEdit && authorized
                ? <><Button variant="secondary" disabled={saving} onClick={backWithoutChanges}>Back without changes</Button><Button variant="primary" disabled={saving} onClick={() => void useInTool()}>{saving ? "Saving…" : "Use and go back"}</Button></>
                : canEdit && authorized && <Button variant="primary" disabled={documents.busy} onClick={() => void documents.save().then(()=>toast("Layered document saved")).catch(()=>{})}>{documents.busy ? "Saving…" : "Save"}</Button>}
            </>)}
        >
          {transforming?<><Meta>Transforming layer: {layer?.name??"Layer"} · Alt scales from center · Shift snaps 15°</Meta><Button variant="secondary" onClick={()=>finishTransform(false)}>Cancel transform</Button><Button variant="primary" onClick={()=>finishTransform(true)}>Apply transform</Button></>:<>
          {canEdit&&authorized&&<MenuButton label="Document actions" icon={<Folder size={16}/>} align="left" items={[
              // Open document is the regular Library modal; Open image from device goes straight to the system dialog.
              {id:"open",label:"Open document",onSelect:()=>setPicker(true)},
              {id:"recent",label:"Recent documents",onSelect:()=>setDocumentPicker(true)},
              ...(!aiBusy?[{id:"import",label:"Open image from device",onSelect:()=>void chooseDeviceFiles({accept:"image/*"}).then(([file])=>{if(file)addFile(file);})}]:[]),
              ...(!documents.busy?[{id:"save-doc",label:"Save layered document",onSelect:()=>void documents.save().then(()=>toast("Layered document saved")).catch(()=>{})}]:[]),
              ...(!saving?[
                {id:"png",label:"Save PNG to Library",onSelect:()=>void save()},
                ...firstFrameTargets.map((target)=>({id:target.id,label:target.id==="animate"?"Use as first frame → Create Video":"Use as first frame → Swap a thing",onSelect:()=>void useAsFirstFrame(target.id)})),
              ]:[]),
            ]}/>}
          <Button variant="secondary" disabled={!canEdit} onClick={() => setPicker(true)}><ImagePlus size={16} />Import image</Button>
          {layer&&layer.kind!=="adjust"&&!layer.locks?.position&&!quickMask&&!maskEdit&&canEdit&&authorized&&!aiBusy&&<Button variant="secondary" title={`Free transform ${layer.name} (Ctrl+T)`} onClick={beginTransform}>Transform layer</Button>}
          {canEdit&&authorized&&<Button variant="secondary" aria-pressed={quickMask} onClick={toggleQuickMask} title="Quick mask (Q)">{quickMask?"Exit quick mask":"Quick mask"}</Button>}
          {/* Selection modes and Quick upscale live in the options bar (Photoshop), never on the picture: there they
              swallowed selection drags that started near the top of the image. */}
          {tool==="subject"&&segment&&<>
            {objectScan?.signature===imageSignature(doc)&&objectScan.status==="analysing"
              ?<Meta><span className="ds-shimmer">Analysing picture</span> · {objectScan.done} of {objectScan.total}</Meta>
              :objectScan?.signature===imageSignature(doc)&&objectScan.status==="failed"
                ?<Button variant="secondary" onClick={()=>void analyseObjects()}>Analyse again</Button>
                :null}
          </>}
          {/* Everything about the selection sits together while a selection tool is on; Ctrl+A / Ctrl+D work everywhere. */}
          {SELECT_TOOLS.includes(tool)&&<>
            <SegmentedTabs quiet label="Selection mode" value={selMode} onChange={setSelMode} items={[{ id: "replace", label: "New" }, { id: "add", label: "Add" }, { id: "subtract", label: "Subtract" }, { id: "intersect", label: "Intersect" }]} />
            <Button variant="secondary" title="Select all (Ctrl+A)" onClick={()=>selectionAction("all")}>Select all</Button>
            {doc.selection&&<Button variant="secondary" title="Deselect (Ctrl+D)" onClick={()=>selectionAction("clear")}>Deselect</Button>}
          </>}
          {tool==="magicEraser"&&<>
            <InlineSelect label="Magic eraser mode" value={magicMode} onChange={value=>{setMagicMode(value as "colour"|"semantic");magicSource.current=null;}} options={[{value:"colour",label:"Colour region"},...(segment?[{value:"semantic",label:"Describe region"}]:[])]}/>
            {magicMode==="colour"?<><SliderField label="Tolerance" min={0} max={255} value={tolerance} onChange={setTolerance}/><Checkbox checked={contiguous} onChange={setContiguous}>Connected only</Checkbox><Meta>Click a colour region to erase it immediately with a clean 1 px matte.</Meta></>:<><TextField label="Remove what" value={subject} onChange={setSubject} placeholder="hair, background, jacket…"/><Button variant="primary" disabled={selecting||!subject.trim()||!authorized} onClick={()=>void selectSubject()}>{selecting?"Finding and erasing…":"Erase described region"}</Button></>}
          </>}
          {smartDepth>0&&<><Meta>Smart object contents</Meta><Button variant="secondary" onClick={()=>finishSmartContents(false)}>Cancel contents</Button><Button variant="secondary" onClick={()=>finishSmartContents(true)}>Apply contents</Button></>}
          {tool === "wand" && (
            <>
              <SliderField label="Tolerance" min={0} max={255} value={tolerance} onChange={setTolerance} />
              <Checkbox checked={contiguous} onChange={setContiguous}>Contiguous</Checkbox>
              <Meta>Drag left or right to adjust the selected colour range. Samples the visible image.</Meta>
            </>
          )}
          {quickMask&&<Meta>Paint to select · Alt removes · Q exits</Meta>}
          {tool==="maskBrush"&&!quickMask&&<Meta>Paint mask · Alt removes from the mask</Meta>}
          {(tool === "brush" || tool === "eraser"||tool==="maskBrush") && <>
            <SliderField label="Size" unit="px" min={1} max={200} value={brush.size} onChange={(v) => setBrush((b) => ({ ...b, size: v }))} />
            <SliderField label="Hardness" unit="%" min={0} max={100} value={brush.hardness} onChange={hardness=>setBrush(b=>({...b,hardness}))}/>
            <SliderField label="Opacity" unit="%" min={1} max={100} value={brush.opacity} onChange={opacity=>setBrush(b=>({...b,opacity}))}/>
            <SliderField label="Flow" unit="%" min={1} max={100} value={brush.flow} onChange={(v) => setBrush((b) => ({ ...b, flow: v }))} />
            <SegmentedTabs quiet label="Brush style" value={brush.style} onChange={(style) => setBrush((b) => ({ ...b, style,hardness:style.endsWith("soft")?0:100 }))} items={BRUSH_STYLES.map(({ value, label }) => ({ id: value, label }))} />
          </>}
          {tool === "crop" && (
            <>
              <Checkbox checked={autoExtend} onChange={setAutoExtend}>Auto extend</Checkbox>
              {autoExtend&&<Button variant="secondary" disabled={!!aiBusy||doc.width+128>2048||doc.height+128>2048} onClick={()=>setCropBox({x:-64,y:-64,w:doc.width+128,h:doc.height+128})}>Extend 64 px around</Button>}
              <ParamButton title="Crop ratio" label="Ratio" icon={<Crop size={16} />} value={cropRatio} options={(Object.keys(CROPS) as CropId[]).map((c) => ({ value: c, label: CROPS[c] }))} onChange={(v) => setCropRatio(v)} />
              <Button variant="secondary" disabled={!!aiBusy} onClick={() => { try{apply(scaleViewport(cropViewport(doc,normalizeViewport(aiCropRect(doc,cropRatio))),Number(cropScale)||100));fit();setCropBox(null);}catch(error){toast((error as Error).message);} }}>Crop to AI size</Button>
            </>
          )}
          </>}
        </OptionsBar>
        <Split>
          <Canvas workspace>
            <Stage ref={stageRef}
              onDragOver={event=>{if(!subjectRelight&&edit&&canEdit&&authorized&&!aiBusy&&(event.dataTransfer.types.includes(CHARACTER_DRAG_TYPE)||event.dataTransfer.types.includes("text/plain")))event.preventDefault();}}
              onDrop={event=>{const id=characterDropId(event.dataTransfer.getData(CHARACTER_DRAG_TYPE),event.dataTransfer.getData("text/plain"));if(!id)return;event.preventDefault();event.stopPropagation();const canvas=canvasRef.current;if(!canvas)return;const bounds=canvas.getBoundingClientRect();if(bounds.width<=0||bounds.height<=0||event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom){toast("Drop the character inside the image.");return;}void placeCharacter(id,{x:(event.clientX-bounds.left)/bounds.width,y:(event.clientY-bounds.top)/bounds.height});}}
              /* Rectangle and lasso selections may start beside the picture (Photoshop); a click there with another tool
                 still clears the selection. While such a drag runs the work area forwards the pointer to the canvas logic. */
              onPointerDown={event=>{if(event.target!==event.currentTarget||transformSession.current||event.button!==0)return;if((tool==="rect"||tool==="lasso")&&canEdit){down(event);return;}if(doc.selection)lastSelection.current=doc.selection;if(doc.selection||doc.selectedId)apply({...doc,selection:null,selectedId:null});setMulti([]);}}
              onPointerMove={event=>{if(event.target===event.currentTarget&&gesture.current)moveEvent(event);}}
              onPointerUp={event=>{if(event.target===event.currentTarget&&gesture.current)up(event);}}
              status={quickProgress?undefined:aiBusy ? <Working label={upscaling?"Upscaling…":AI_BUSY[aiBusy]} /> : selecting ? <Working label="Selecting…" /> : undefined} rail={transforming?undefined:(
              <div className="cf-editor-rail">
                <ToolRail label="Tool" value={tool} onChange={next=>{setTool(next);if(next==="maskBrush")setMaskEdit(null);}} items={[
                  { id: "crop", label: "Crop (C)", icon: <Crop size={18} /> },
                  { id: "move", label: "Move (V)", icon: <Move size={18} /> },
                  { id: "rect", label: "Rectangle select (M)", icon: <SquareDashed size={18} /> },
                  { id: "lasso", label: "Lasso select (L)", icon: <Lasso size={18} /> },
                  { id: "wand", label: "Magic wand (W)", icon: <WandSparkles size={18} /> },
                  ...(segment ? [{ id: "subject" as Tool, label: "Quick select (S)", icon: <ScanSearch size={18} /> }] : []),
                  "separator",
                  { id: "brush", label: "Brush (B)", icon: <Brush size={18} /> },
                  {id:"maskBrush",label:"Paint mask",icon:<Paintbrush size={18}/>},
                  { id: "eraser", label: "Eraser (E)", icon: <Eraser size={18} /> },
                  {id:"magicEraser",label:"Magic eraser",icon:<WandSparkles size={18}/>},
                  { id: "eyedropper", label: "Eyedropper (I)", icon: <Pipette size={18} /> },
                  "separator",
                  { id: "hand", label: "Pan (H, or hold Space)", icon: <Hand size={18} /> },
                  { id: "zoom", label: "Zoom (Z, Alt zooms out)", icon: <ZoomIn size={18} /> },
                ]} />
                <div ref={colorRef}>
                  <ForegroundBackground fg={colors.fg} bg={colors.bg} editing={colors.editing} onEdit={(which) => { setColors((c) => ({ ...c, editing: which })); setColorOpen(true); }} onSwap={() => setColors((c) => ({ ...c, fg: c.bg, bg: c.fg }))} />
                </div>
              </div>)}>
              <div ref={ringRef} className="ds-brushring" aria-hidden />
              <canvas ref={canvasRef} tabIndex={0} aria-label="Image" data-tool={tool === "brush" && altHeld && !quickMask ? "eyedropper" : tool} className="cf-editor-canvas" onPointerDown={down} onPointerMove={moveEvent} onPointerUp={up} onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (!preview.current?.poly) cancelGesture(); }} onPointerLeave={() => { if (ringRef.current) ringRef.current.style.display = "none";if(hoveredObject.current>=0){hoveredObject.current=-1;paint(doc);} }} />
              <canvas ref={outlineCanvasRef} className="cf-editor-outline" aria-hidden="true" />
              <div className="cf-editor-quicklayer"><canvas ref={quickOverlayRef} className="cf-editor-quickoverlay" aria-hidden="true" /></div>
              {(upscale||detailUpscale)&&doc&&canEdit&&authorized&&<QuickUpscaleLaunch busy={!!aiBusy||!!quickProgress} detail={!!detailUpscale} onRun={mode=>void quickUpscaleVisible(mode)}/>}
              {quickProgress&&<div className="cf-editor-quickhud"><Progress floating label={`Quick upscale ${quickScale}×`} value={Math.round(100*quickProgress.done/quickProgress.total)} detail={`Tile ${quickProgress.done} of ${quickProgress.total}${quickSkipped.length?` · ${quickSkipped.length} flat, only enlarged`:""}`} action={<IconButton label="Cancel quick upscale" onClick={()=>void cancelQuickUpscale()}><X size={14}/></IconButton>} /></div>}
              {transforming&&layer&&cropScreen.w>0&&<TransformHandles box={{x:layer.x,y:layer.y,w:layer.w*layer.scale,h:layer.h*layer.scale,rotation:layer.rotation}} viewport={cropScreen} width={doc.width} height={doc.height}
                onStart={startTransformDrag} onMove={moveTransformDrag} onEnd={()=>{transformDrag.current=null;}} onCancel={cancelTransformDrag} onNudge={nudgeTransform} onApply={()=>finishTransform(true)} onDiscard={()=>finishTransform(false)}/>}
              {tool==="crop"&&cropScreen.w>0&&<CropHandles box={cropPreview??fullCrop(dims(doc))} viewport={cropScreen} width={doc.width} height={doc.height}
                onStart={(handle,event)=>{if(event.button!==0||aiBusy)return;const rect=cropBox.current??fullCrop(dims(doc));cropDrag.current=handle as CropHandle;cropStart.current={rect,point:point(event)};capture(event);}}
                onMove={moveEvent} onEnd={up} onCancel={cancelGesture}
                onNudge={(handle,dx,dy)=>{const rect=cropBox.current??fullCrop(dims(doc));setCropBox(dragCrop(rect,handle as CropHandle,{x:0,y:0},{x:dx,y:dy},dims(doc),autoExtend));paint(doc);}}/>}
              {tool === "crop" && cropPreview && doc && !isFullCrop(cropPreview, dims(doc)) && <div className={`cf-editor-cropbar ds-card${doc.height>doc.width?" cf-editor-cropbar--portrait":""}`} role="group" aria-label="Crop">
                <Toolbar>
                  <Button variant="secondary" onClick={cancelCropPreview}>Cancel</Button>
                  <TextField label="Scale %" type="number" min={10} max={800} step={10} value={cropScale} onChange={setCropScale}/>
                  <Meta>{Math.round((hasExposedBorder(cropPreview,doc.width,doc.height)?Math.floor(cropPreview.w/8)*8:Math.round(cropPreview.w))*Number(cropScale||100)/100)} × {Math.round((hasExposedBorder(cropPreview,doc.width,doc.height)?Math.floor(cropPreview.h/8)*8:Math.round(cropPreview.h))*Number(cropScale||100)/100)} px{hasExposedBorder(cropPreview,doc.width,doc.height)?" · generate border":""}</Meta>
                  <Button variant="primary" disabled={!!aiBusy} onClick={()=>void applyCropPreview()}>Apply</Button>
                </Toolbar>
              </div>}
            </Stage>
          </Canvas>
          <DockStack inert={transforming} className="cf-editor-side" ref={sideRef} onReorder={order => setDock(d => ({ ...d, order: reorderVisible(d.order, order) }))}>
            {dock.order.map((id) => {
              const drag = {
                id,
                label: { ai: "AI", layers: "Layers", properties: "Properties" }[id],
                collapsed: !!dock.collapsed[id],
                onToggle: () => setDock((d) => ({ ...d, collapsed: { ...d.collapsed, [id]: !d.collapsed[id] } })),
              };
              if (id === "layers") return (
                <DockPanel key={id} {...drag}
                  title={<DockTabs label="Layers panel" tabs={[{ id: "layers", label: "Layers" }, { id: "channels", label: "Channels" }]} value={panelTab} onChange={setPanelTab} />}
                  end={
                <MenuButton label="Layers menu" icon={<MenuIcon size={18} />} items={[
                  { id: "image", label: "Add image…", onSelect: () => setPicker(true) },
                  ...(upscale?[{id:"upscale-image",label:"Upscale image 2×",onSelect:()=>void upscaleEditor("image")},...(layer?[{id:"upscale-layer",label:"Upscale selected layer 2×",onSelect:()=>void upscaleEditor("layer")}]:[])]:[]),
                  ...(layer ? [{ id: "duplicate", label: "Duplicate layer", onSelect: duplicate }] : []),
                  ...(layer&&doc.layers.findIndex(l=>l.id===layer.id)>0?[{id:"merge",label:"Merge down",onSelect:()=>merge("down")}]:[]),
                  ...(selectedIds.length>1?[{id:"merge-selected",label:"Merge selected",onSelect:()=>merge("selected")},{id:"group-layers",label:"Group selected",onSelect:()=>groupSelected()},{id:"group-merge",label:"Group and merge",onSelect:()=>merge("selected")}]:[]),
                  ...(layer?.group?[{id:"merge-group",label:"Merge group",onSelect:()=>merge("group")}]:[]),
                  ...(layer?.group?[{id:"group-settings",label:"Group settings…",onSelect:()=>setGroupSettingsId(layer.group!)}]:[]),
                  ...(layer&&!layer.smartObject?[{id:"smart-object",label:"Convert to smart object",onSelect:makeSmartObject}]:[]),
                  ...(layer?.smartObject?[{id:"edit-smart",label:"Edit smart object contents",onSelect:editSmartContents},{id:"raster-smart",label:"Rasterize smart object",onSelect:()=>apply(updateLayer(doc,layer.id,{smartObject:undefined}))}]:[]),
                  ...(layer?.mask ? [{ id: "apply-mask", label: "Apply mask to layer", onSelect: () => { const bm = getBitmap(layer.src); const k = bm && applyMaskToLayer(doc, layer, bm); if (k) { thumbs.current.clear(); setMaskEdit((m) => (m === layer.id ? null : m)); apply(updateLayer(doc, layer.id, { src: k, mask: undefined, maskOff: undefined })); } } }] : []),
                  { id: "visible", label: "Merge visible", onSelect: () => merge(true) },
                  {id:"merge-all",label:"Merge all",onSelect:()=>merge("all")},
                ]} />
                  }
                  footer={panelTab === "layers" ? (
                <ActionBar label="Layer actions">
                  <IconButton label={selectedIds.length > 1 ? "Link selected layers" : layer?.linked ? "Unlink layer" : "Link layer"} aria-pressed={!!layer?.linked} disabled={!layer} onClick={linkSelected}><Link size={14} /></IconButton>
                  {layer && layer.kind !== "adjust" && (
                    <MenuButton label="Add a layer style" icon={<FxIcon size={14} />} items={[
                      { id: "shadow", label: "Drop shadow…", onSelect: () => { apply(updateLayer(doc, layer.id, { shadow: { dx: 8, dy: 8, blur: 16, color: "#000000" } })); setFloating("style"); } },
                      { id: "glow", label: "Outer glow…", onSelect: () => { apply(updateLayer(doc, layer.id, { shadow: { dx: 0, dy: 0, blur: 24, color: "#ffffff" } })); setFloating("style"); } },
                      ...(layer.shadow ? [{ id: "clear", label: "Clear layer style", onSelect: () => apply(updateLayer(doc, layer.id, { shadow: undefined })) }] : []),
                    ]} />
                  )}
                  {layer && layer.kind !== "adjust" && (
                    <IconButton label={layer.mask ? "Delete layer mask" : doc.selection ? "Add layer mask from selection (Alt: hide the selection)" : "Add layer mask"} aria-pressed={!!layer.mask} onClick={(e) => addMask(e.altKey)}><Square size={14} /></IconButton>
                  )}
                  <MenuButton label="New adjustment layer (Alt: only the layer below)" icon={<Contrast size={14} />} items={(Object.keys(ADJUSTMENTS) as AdjustKind[]).map((k) => ({ id: k, label: `${ADJUSTMENTS[k].name}…`, onSelect: (alt: boolean) => { setMulti([]); apply(addAdjustLayer(doc, k, alt || altDown.current)); setFloating("adjust"); } }))} />
                  <IconButton label={selectedIds.length > 1 ? "Group selected layers" : layer?.group ? "Ungroup" : "Group layer"} disabled={!layer} onClick={()=>groupSelected()}><Folder size={14} /></IconButton>
                  <IconButton label="New layer" onClick={addEmptyLayer}><SquarePlus size={14} /></IconButton>
                  <IconButton label={selectedIds.length > 1 ? "Delete selected layers" : "Delete layer"} disabled={!layer} onClick={deleteSelected}><Trash2 size={14} /></IconButton>
                </ActionBar>
              ) : undefined}
                >
              {panelTab === "layers" ? (
                <>
                  <div className="cf-layer-head">
                    <InlineSelect label="Blend mode" value={layer?.blend ?? "normal"} disabled={!layer} options={BLENDS.map((b) => ({ value: b, label: BLEND_LABELS[b] }))} onChange={(v) => layer && apply(updateLayer(doc, layer.id, { blend: v as Blend }))} />
                    <InlineSlider label="Opacity" value={Math.round((layer?.opacity ?? 1) * 100)} disabled={!layer} onChange={(v) => layer && applyLive(`o${layer.id}`, (d) => updateLayer(d, layer.id, { opacity: v / 100 }))} />
                  </div>
                  <LabeledRow label="Lock">
                    {([["transparent", "Lock transparent pixels", <Grid3x3 size={12} key="t" />], ["paint", "Lock image pixels", <Brush size={12} key="p" />], ["position", "Lock position", <Move size={12} key="m" />]] as const).map(([key, label, icon]) => (
                      <IconButton key={key} label={label} disabled={!layer} aria-pressed={!!layer?.locks?.[key as keyof Locks]} onClick={() => layer && apply(updateLayer(doc, layer.id, { locks: { ...layer.locks, [key]: !layer.locks?.[key as keyof Locks] } }))}>{icon}</IconButton>
                    ))}
                    <IconButton label="Lock all" disabled={!layer} aria-pressed={!!layer?.locks?.transparent && !!layer?.locks?.paint && !!layer?.locks?.position} onClick={() => { if (!layer) return; const on = !(layer.locks?.transparent && layer.locks?.paint && layer.locks?.position); apply(updateLayer(doc, layer.id, { locks: { transparent: on, paint: on, position: on } })); }}><Lock size={12} /></IconButton>
                  </LabeledRow>
                  <LayerList label="Layers" alt={altHeld}>{layerRows()}</LayerList>
                </>
              ) : (
                <LayerList label="Channels">
                  <LayerRow name="RGB" thumb={channelThumbs.rgb ? <img src={channelThumbs.rgb} alt="" /> : undefined} visible={channels.r && channels.g && channels.b} selected={false} onSelect={() => {}} onToggle={() => setChannels((c) => { const on = !(c.r && c.g && c.b); return { ...c, r: on, g: on, b: on }; })} />
                  <LayerRow name="Red" thumb={channelThumbs.r ? <img src={channelThumbs.r} alt="" /> : undefined} visible={channels.r} selected={false} onSelect={() => {}} onToggle={() => setChannels((c) => ({ ...c, r: !c.r }))} />
                  <LayerRow name="Green" thumb={channelThumbs.g ? <img src={channelThumbs.g} alt="" /> : undefined} visible={channels.g} selected={false} onSelect={() => {}} onToggle={() => setChannels((c) => ({ ...c, g: !c.g }))} />
                  <LayerRow name="Blue" thumb={channelThumbs.b ? <img src={channelThumbs.b} alt="" /> : undefined} visible={channels.b} selected={false} onSelect={() => {}} onToggle={() => setChannels((c) => ({ ...c, b: !c.b }))} />
                  <LayerRow name="Alpha" thumb={channelThumbs.a ? <img src={channelThumbs.a} alt="" /> : undefined} visible={channels.a} selected={false} onSelect={() => {}} onToggle={() => setChannels((c) => ({ ...c, a: !c.a }))} />
                </LayerList>
              )}
                </DockPanel>
              );
              if (id === "ai") return (
                <DockPanel key={id} {...drag} title={<span className="cf-modify-title">{subjectRelight?"Relight":"Modify"}</span>} end={!subjectRelight&&edit?<span className="cf-modify-model-select"><InlineSelect label="Edit model" value={editModelId} disabled={!!aiBusy} options={editOptions.map(option=>({value:option.manifest.id,label:shortEditModelName(option.manifest.title)}))} onChange={id=>{editModelChosen.current=true;setEditModelId(id);}} /></span>:undefined}>
                <Block>
                  {aiStop&&<Notice priority={35} title={aiStop.cancelled?`${AI_LABELS[aiStop.mode]} was cancelled`:`${AI_LABELS[aiStop.mode]} did not finish`} details={aiStop.error||undefined}
                    actions={<Button variant="secondary" disabled={!!aiBusy} onClick={()=>{const mode=aiStop.mode;setAiStop(null);void requestAi(mode);}}>Try again</Button>}>Nothing was added to the picture.</Notice>}
                  {!modifyRouteReady && modifyFix && <Notice priority={40} title="AI Modify is not ready" actions={<Button variant="secondary" disabled={!canEdit||!authorized} onClick={modifyFix.run}>{modifyFix.label}</Button>}>{modifyUnavailableReason} The editor stays available while setup is incomplete.</Notice>}
                  <AnnotationEditor open={!!annotationSrc} src={annotationSrc} initial={annotations} onClose={()=>setAnnotationSrc("")} onApply={boxes=>{setAnnotations(boxes);setEditScope("image");setEditIntent("modify");setAnnotationSrc("");if(openAssetId)sessionStorage.setItem(annotationStorageKey(workspace.id,openAssetId),JSON.stringify(boxes));}}/>
                  <DropTarget wrap boxed className="cf-modify-card" label="Drop images here" disabled={subjectRelight||!!aiBusy||referenceBusy} onFiles={dropReferenceFiles} onAsset={dropReferenceAsset}>
                    {!subjectRelight&&(edit?.manifest.inputs.some(input=>input.id==="reference_image")||[aiReference,...extraReferences].some(Boolean))&&<div className="cf-modify-refs">
                      {[aiReference,...extraReferences].map((asset,index)=>asset&&<Thumb key={`${index}:${asset.id}`} src={assetUrl(workspace.id,asset.id)} label={`Reference ${index+1} · insert @Image ${index+1}`} badge={<Badge>{index+1}</Badge>} numbered onActivate={()=>mentionReference(index)} onRemove={()=>{if(index===0)setAiReference(null);else setExtraReferences(old=>old.map((value,i)=>i===index-1?null:value));}}/>)}
                    </div>}
                    {/* Marked regions are visible here and on the picture; Edit reopens them, Remove clears them. */}
                    {!subjectRelight&&annotations.length>0&&<div className="cf-modify-marks">
                      <Meta>{annotations.length===1?"1 region marked":`${annotations.length} regions marked`}</Meta>
                      <IconButton label="Edit marked regions" disabled={!!aiBusy} onClick={openAnnotations}><Pencil size={14} /></IconButton>
                      <IconButton label="Remove marked regions" disabled={!!aiBusy} onClick={()=>{setAnnotations([]);if(openAssetId)sessionStorage.removeItem(annotationStorageKey(workspace.id,openAssetId));}}><X size={14} /></IconButton>
                    </div>}
                    <PromptField textareaRef={aiPromptArea} tokens={["@Image 1","@Image 2","@Image 3"]} compact label="Describe your changes" placeholder="Describe your changes (use @ to reference images or assets)" value={aiPrompt} disabled={!!aiBusy} onChange={setAiPrompt} />
                    {subjectRelight&&<><Meta>Select and review the subject mask before relighting. Pixels outside the effective mask use the precision workflow.</Meta><Button variant="secondary" disabled={!!aiBusy} onClick={()=>{if(openAssetId)sessionStorage.removeItem(subjectRelightKey(workspace.id,project.id,openAssetId));onExitSubjectRelight?.();}}>Use normal editing</Button>{(precisionRun||precisionResult||precisionError)&&<Button variant="secondary" onClick={()=>setPrecisionOpen(true)}>Review edit</Button>}</>}
                    {/* A quick upscale has its own progress pill on the canvas: Modify keeps its tools in view, only disabled. */}
                    {aiBusy&&!upscaling ? (
                      <Working label={AI_BUSY[aiBusy]} hint="ComfyUI is generating" />
                    ) : (
                      <Toolbar className="cf-modify-actions">
                        {!subjectRelight&&<IconButton label="Add reference" disabled={referenceBusy||!!aiBusy} onClick={()=>{const slot=[aiReference,...extraReferences].findIndex(asset=>!asset);if(slot>=0){setReferenceSlot(slot);setReferencePicker(true);}else toast("Three references are already in use.");}}><Plus size={18} /></IconButton>}
                        {!subjectRelight&&<IconButton label="Annotations" aria-pressed={annotations.length>0} disabled={!!aiBusy} onClick={openAnnotations}><Pencil size={18} /></IconButton>}
                        <span className="cf-modify-actions__spacer" />
                        {subjectRelight&&precision&&<Button variant="primary" disabled={selecting||!canEdit||!authorized||!aiPrompt.trim()} onClick={()=>{if(doc.selection)void requestAi("modify");else if(segment)void selectSubject();else{setTool("lasso");toast("Draw around the subject, then choose Relight subject.");}}}>{selecting?"Selecting subject…":doc.selection?"Relight subject":segment?"Select subject":"Select subject with lasso"}</Button>}
                        {!subjectRelight&&<Button variant="accent" className="cf-modify-send" aria-label="Modify" disabled={!!aiBusy||!modifyRouteReady||!canEdit||!authorized||(!aiPrompt.trim()&&!annotations.length)} onClick={() => void requestAi("modify")}><ArrowUpRight size={18} /></Button>}
                      </Toolbar>
                    )}
                  </DropTarget>
                </Block>
                </DockPanel>
              );
              return layer ? (
                <DockPanel key={id} {...drag} title={layer.kind === "adjust" ? "Adjustment" : "Properties"}
                  end={
                    <IconButton label="Adjustments" aria-pressed={floating === "adjust"} onClick={() => setFloating((f) => (f === "adjust" ? null : "adjust"))}><SlidersHorizontal size={16} /></IconButton>
                  }
                >
                  {layer.kind !== "adjust" && (
                    <PanelSection label="Transform">
                      <div className="cf-editor-fields">
                        {nudgeField("x", "X", layer.x - (layer.w * layer.scale) / 2, (v) => ({ x: v + (layer.w * layer.scale) / 2 }))}
                        {nudgeField("y", "Y", layer.y - (layer.h * layer.scale) / 2, (v) => ({ y: v + (layer.h * layer.scale) / 2 }))}
                        {nudgeField("w", "W", layer.w * layer.scale, (v) => ({ scale: Math.max(0.01, v / layer.w) }))}
                        {nudgeField("h", "H", layer.h * layer.scale, (v) => ({ scale: Math.max(0.01, v / layer.h) }))}
                      </div>
                      <SliderField label="Rotate" unit="°" min={-180} max={180} value={Math.round(layer.rotation)} onChange={(v) => applyLive(`r${layer.id}`, (d) => updateLayer(d, layer.id, { rotation: v }))} />
                      <Toolbar>
                        <IconButton label="Flip horizontally" onClick={() => apply(flipLayer(doc, layer.id))}><FlipHorizontal2 size={16} /></IconButton>
                      </Toolbar>
                    </PanelSection>
                  )}
                  {layer.kind !== "adjust" && (
                    <PanelSection label="Align">
                      <Toolbar>
                        <IconButton label="Align left" onClick={() => align("left")}><AlignStartVertical size={16} /></IconButton>
                        <IconButton label="Center horizontally" onClick={() => align("hcenter")}><AlignCenterVertical size={16} /></IconButton>
                        <IconButton label="Align right" onClick={() => align("right")}><AlignEndVertical size={16} /></IconButton>
                        <IconButton label="Align top" onClick={() => align("top")}><AlignStartHorizontal size={16} /></IconButton>
                        <IconButton label="Center vertically" onClick={() => align("vcenter")}><AlignCenterHorizontal size={16} /></IconButton>
                        <IconButton label="Align bottom" onClick={() => align("bottom")}><AlignEndHorizontal size={16} /></IconButton>
                      </Toolbar>
                    </PanelSection>
                  )}
                  {(doc.selection || !!doc.saved?.length) && (
                    <PanelSection label="Selection">
                      {!!doc.saved?.length && (
                        <Toolbar>
                          {doc.saved.map((sv) => (
                            <Button key={sv.id} variant="secondary" title="Click: load · Shift: add · Alt: subtract · Right-click: delete"
                              onClick={(ev) => apply({ ...doc, selection: combine(doc, (() => { const c = blankCanvas(doc.width, doc.height); const bm = getBitmap(sv.key); if (bm) c.getContext("2d")!.drawImage(bm, 0, 0); return c; })(), ev.altKey ? "subtract" : ev.shiftKey ? "add" : "replace") })}
                              onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, items: [{ id: "del", label: `Delete “${sv.name}”`, danger: true, onSelect: () => apply({ ...doc, saved: doc.saved!.filter((x) => x.id !== sv.id) }) }] }); }}>
                              {sv.name}
                            </Button>
                          ))}
                        </Toolbar>
                      )}
                      <Toolbar>
                        {doc.selection && <Button variant="secondary" onClick={saveSelection}>Save</Button>}
                        {doc.selection && <Button variant="secondary" onClick={() => selectionAction("invert")}>Invert</Button>}
                        {doc.selection && <Button variant="secondary" onClick={() => selectionAction("delete")}>Delete</Button>}
                        {doc.selection && <Button variant="secondary" onClick={() => selectionAction("fill")}>Fill</Button>}
                      </Toolbar>
                    </PanelSection>
                  )}
                </DockPanel>
              ) : null;
            })}
          </DockStack>
        </Split>
        <StatusBar>
          <ParamButton title="Zoom" label={`${zoomLabel}%`} icon={<Maximize2 size={14} />} value="fit" options={ZOOMS} onChange={(v) => (v === "fit" ? fit() : zoomActual(Number(v)))} />
          <span>{doc.width} × {doc.height} px</span>
        </StatusBar>
      </Page>
      <FloatingPanel open={colorOpen} title={colors.editing === "fg" ? "Foreground color" : "Background color"} anchor={colorRef} placement="right" onClose={() => setColorOpen(false)}>
        <ColorPicker label="Color" value={colors[colors.editing]} onChange={(hex) => setColors((c) => ({ ...c, [c.editing]: hex }))} />
        <Swatches label="Quick colors" colors={COLORS} value={colors[colors.editing]} onChange={(hex) => setColors((c) => ({ ...c, [c.editing]: hex }))} />
      </FloatingPanel>
      {doc && layer && (
        <FloatingPanel open={floating === "adjust"} title={layer.kind === "adjust" ? layer.name : "Adjustments"} anchor={sideRef} onClose={() => setFloating(null)}>
                    {(layer.kind!=="adjust"||(layer.hue===undefined&&layer.grayscale===undefined&&layer.invert===undefined&&layer.sepia===undefined))&&<>
                      <SliderField label="Brightness" unit="%" min={0} max={200} value={layer.brightness} onChange={(v) => applyLive(`b${layer.id}`, (d) => updateLayer(d, layer.id, { brightness: v }))} />
                      <SliderField label="Contrast" unit="%" min={0} max={200} value={layer.contrast} onChange={(v) => applyLive(`c${layer.id}`, (d) => updateLayer(d, layer.id, { contrast: v }))} />
                    </>}
                    {layer.hue !== undefined && <SliderField label="Hue" unit="°" min={-180} max={180} value={layer.hue} onChange={(v) => applyLive(`hu${layer.id}`, (d) => updateLayer(d, layer.id, { hue: v }))} />}
                    {(layer.kind!=="adjust"||layer.hue!==undefined)&&<SliderField label="Saturation" unit="%" min={0} max={200} value={layer.saturation} onChange={(v) => applyLive(`t${layer.id}`, (d) => updateLayer(d, layer.id, { saturation: v }))} />}
                    {layer.grayscale !== undefined && <SliderField label="Black & White" unit="%" min={0} max={100} value={layer.grayscale} onChange={(v) => applyLive(`gr${layer.id}`, (d) => updateLayer(d, layer.id, { grayscale: v }))} />}
                    {layer.invert !== undefined && <SliderField label="Invert" unit="%" min={0} max={100} value={layer.invert} onChange={(v) => applyLive(`in${layer.id}`, (d) => updateLayer(d, layer.id, { invert: v }))} />}
                    {layer.sepia !== undefined && <SliderField label="Density" unit="%" min={0} max={100} value={layer.sepia} onChange={(v) => applyLive(`se${layer.id}`, (d) => updateLayer(d, layer.id, { sepia: v }))} />}
                    {layer.kind === "adjust" && <Checkbox checked={!!layer.clip} onChange={(v) => apply(updateLayer(doc, layer.id, { clip: v }))}>Only the layer below</Checkbox>}
                    {layer.kind === "adjust" && <Button variant="secondary" onClick={()=>apply(updateLayer(doc,layer.id,resetAdjustment(layer)))}>Reset adjustment</Button>}
                                              </FloatingPanel>
      )}
      {doc && layer && layer.kind !== "adjust" && (
        <FloatingPanel open={floating === "style"} title="Layer style" anchor={sideRef} onClose={() => setFloating(null)}>
          <SegmentedTabs quiet block label="Layer style" value={!layer.shadow ? "none" : layer.shadow.dx === 0 && layer.shadow.dy === 0 ? "glow" : "shadow"}
            onChange={(v) => apply(updateLayer(doc, layer.id, { shadow: v === "none" ? undefined : v === "glow" ? { dx: 0, dy: 0, blur: 24, color: "#ffffff" } : { dx: 8, dy: 8, blur: 16, color: "#000000" } }))}
            items={[{ id: "none", label: "None" }, { id: "shadow", label: "Shadow" }, { id: "glow", label: "Glow" }]} />
          {layer.shadow && (
            <>
              <SliderField label="Size" unit="px" min={0} max={80} value={layer.shadow.blur} onChange={(v) => applyLive(`sb${layer.id}`, (d) => updateLayer(d, layer.id, { shadow: { ...layer.shadow!, blur: v } }))} />
              {!(layer.shadow.dx === 0 && layer.shadow.dy === 0) && <SliderField label="Distance" unit="px" min={1} max={80} value={layer.shadow.dx} onChange={(v) => applyLive(`so${layer.id}`, (d) => updateLayer(d, layer.id, { shadow: { ...layer.shadow!, dx: v, dy: v } }))} />}
              <Swatches label="Style color" colors={["#000000", "#ffffff", "#2fa8ff", "#f5c451"]} value={layer.shadow.color} onChange={(c) => apply(updateLayer(doc, layer.id, { shadow: { ...layer.shadow!, color: c } }))} />
            </>
          )}
        </FloatingPanel>
      )}
      {documentDialog}
      {groupSettingsDialog}
      {documentNotice}{returnError&&<Notice priority={55} title="The edited picture was not sent back" actions={<Button variant="secondary" onClick={() => void useInTool()}>Try again</Button>}>{returnError}</Notice>}
      {selectionUnavailable&&<Notice priority={40} title="Object selection is unavailable" actions={<Button variant="secondary" onClick={()=>setSelectionUnavailable(false)}>Dismiss</Button>}>Check the segmentation model, or use another selection tool.</Notice>}
      {placementDraft.error&&<Notice priority={35} title="Placement draft" actions={<><Button variant="secondary" onClick={placementDraft.retry}>Retry draft</Button><Button variant="ghost" onClick={clearCharacterPlacement}>Clear draft</Button></>}>{placementDraft.error}</Notice>}
      {freeInput && (edit || (doc.selection && (inpaint||precision))) && <CommandBar
        label="What should change"
        placeholder="Describe what to change in this image"
        value={aiPrompt} onChange={setAiPrompt} busy={!!aiBusy}
        submitLabel={subjectRelight?"Relight subject":characterPlacement?"Place character":characterSwap?"Swap person":"Modify"}
        submitDisabled={!!aiBusy || referenceBusy||placingCharacter||!canEdit || !authorized || !aiPrompt.trim()||(subjectRelight&&(!doc.selection||!precision))||!!(characterPlacement&&!doc.selection)||!!(characterSwap&&!doc.selection)}
        onSubmit={() => void requestAi(resolveEditMode(editIntent,aiPrompt,!!doc.selection))}
        drop={referenceDrop}
        above={[aiReference,...extraReferences].some(Boolean)&&<div className="cf-command-references">{[aiReference,...extraReferences].map((asset,index)=>asset&&<Thumb key={`${index}:${asset.id}`} src={assetUrl(workspace.id,asset.id)} label={`Reference ${index+1} · insert @Image ${index+1}`} badge={<Badge>{index+1}</Badge>} numbered mini onActivate={()=>mentionReference(index)}/>)}</div>}
      />}
      <Dialog open={precisionSettings} title="Precision settings" onClose={()=>setPrecisionSettings(false)} footer={<Button variant="secondary" onClick={()=>setPrecisionSettings(false)}>Done</Button>}>
        <SliderField label="Context" unit="px" min={0} max={512} step={16} value={precisionContext} onChange={setPrecisionContext}/>
        <SliderField label="Feather" unit="% diagonal" min={0} max={3} step={.1} value={precisionFeather} onChange={setPrecisionFeather}/>
      </Dialog>
      <PrecisionReview open={precisionOpen} onClose={closePrecision} workspaceId={workspace.id} run={precisionRun} result={precisionResult} onCancel={cancelPrecision} onKeep={canEdit&&authorized?keepPrecision:undefined} onRetake={precision&&canEdit&&authorized?retakePrecision:undefined} working={!!aiBusy} errorMessage={precisionError}/>
      {swapCheck&&<Dialog wide open={swapOpen} title="Swap check" onClose={()=>setSwapOpen(false)} footer={<><Button variant="secondary" onClick={downloadSwapProvenance}>Download provenance</Button><Button variant="secondary" onClick={()=>setSwapOpen(false)}>Close</Button></>}><ContactSheet title="Swap check" fileName="swap-check.png" caption={`Source, reference and result for ${swapCheck.label}. Review identity, pose, scale and lighting; this is not an identity score. Run ${swapCheck.run}.`} items={[{src:assetUrl(workspace.id,swapCheck.source),label:"Source"},{src:assetUrl(workspace.id,swapCheck.reference),label:"Reference"},{src:assetUrl(workspace.id,swapCheck.result),label:"Result"}]}/></Dialog>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <AssetPicker open={picker} assets={assets} workspace={workspace.id} canEdit={canEdit} onFile={(f) => { setPicker(false); addFile(f); }} onClose={() => setPicker(false)} onPick={(a) => { setPicker(false); void addImage(a.name, assetUrl(workspace.id, a.id)); }} />
      <AssetPicker title="Reference image" open={referencePicker} assets={assets} workspace={workspace.id} canEdit={canEdit} onFile={file=>void addReference(file)} onClose={()=>setReferencePicker(false)} onPick={chooseReference}/>
      <FloatingPanel open={referenceTray} title="References" anchor={referenceAnchor} onClose={()=>setReferenceTray(false)}>
        <ThumbGrid label="References">{[aiReference,...extraReferences].map((asset,index)=>asset&&<Thumb key={`${index}:${asset.id}`} src={assetUrl(workspace.id,asset.id)} label={`Reference ${index+1} · insert @Image ${index+1}`} onActivate={()=>mentionReference(index)} onRemove={()=>{if(index===0)setAiReference(null);else setExtraReferences(old=>old.map((value,i)=>i===index-1?null:value));}}/>)}</ThumbGrid>
        <Button variant="secondary" disabled={referenceBusy||!edit?.manifest.inputs.some(input=>input.id==="reference_image")||[aiReference,...extraReferences].every(Boolean)} onClick={()=>{setReferenceSlot([aiReference,...extraReferences].findIndex(asset=>!asset));setReferencePicker(true);}}>Add another</Button>
      </FloatingPanel>
    </div>
  );
}

function AssetPicker({title="Add image", open, assets, workspace, canEdit, onFile, onClose, onPick }: {title?:string; open: boolean; assets: Asset[]; workspace: string; canEdit: boolean; onFile: (file: File | null) => void; onClose: () => void; onPick: (asset: Asset) => void }) {
  /* The shared picker (MediaPickerDialog): this device is the first tile, the project's pictures follow. */
  return <MediaPickerDialog open={open} title={title} onClose={onClose} disabled={!canEdit}
    items={assets.map((asset) => ({ id: asset.id, src: assetUrl(workspace, asset.id), label: asset.name }))}
    onPick={(id) => { const asset = assets.find((item) => item.id === id); if (asset) onPick(asset); }}
    upload={canEdit ? { accept: title === "Reference image" ? "image/*" : "image/*,.psd,.psb", kinds: ["image"], onFile } : undefined} />;
}
