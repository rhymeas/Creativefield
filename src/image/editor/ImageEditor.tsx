import {dragLayerTransform,applyLayerTransform,transformCorner,type TransformHandle,type TransformPoint} from "./free-transform";
import {cloneLayerMask,effectiveLayerMaskKey} from "./layer-mask";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, Brush, Paintbrush, Crop, Eraser, FlipHorizontal2, Hand, ImagePlus, Lasso, Maximize2, Move, Pipette, Redo2, Square, Folder, Contrast, Grid3x3, Lock, SlidersHorizontal, ScanSearch, Link, SquarePlus, Menu as MenuIcon, SquareDashed, Trash2, Undo2, WandSparkles, ZoomIn } from "lucide-react";
import {
  CastCard, AnnotationEditor, ActionBar, CommandBar, ContextMenu, Working, clipboardFile, DockStack, DockPanel, DockTabs, FloatingPanel, FxIcon, InlineSelect, InlineSlider, LabeledRow, MenuButton, Block, Button, ColorPicker, ForegroundBackground, Canvas, Checkbox, InfoButton, ShortcutSheet, type ShortcutGroup, OptionsBar, StatusBar, TextField, Dialog, EmptyState, IconButton, LayerList, LayerRow, Meta, Page, PanelSection, PromptField,
  ContactSheet,
  Notice, CropHandles, TransformHandles, ParamButton, Row, SegmentedTabs, SliderField, Split, Stage, Swatches, Thumb, ThumbGrid, ToolRail, Toolbar, UploadSlot, useToast,
} from "../../ds";
import { assetUrl, workspacePath, type Asset, type AssetPage, type Call, type Project, type Run, type Workspace, type CharacterRecord } from "../../team/api";
import {CharacterReferencePicker} from "./CharacterReferencePicker";
import {characterEditBindings,identityReferenceInstruction,identityReferenceSheetInstruction,type CharacterEditBindings} from "./character-references";
import {referenceSheetCanvas} from "./reference-sheet";
import {characterPath,characterUsageCaption} from "../../team/characters/state";
import {CHARACTER_DRAG_TYPE,characterDropId,characterPlacementRect,characterPlacementInstruction,characterSwapInstruction} from "./character-placement";
import {swapCheckProvenance,swapCheckProvenanceName} from "./swap-check-provenance";
import {usePlacementDraft} from "./use-placement-draft";
import type { CapabilityManifestV2 } from "../../capabilities/types";
import {
  BLENDS, BLEND_LABELS, CROPS, addImageLayer, addPaintLayer, commit, commitContinuous, duplicateLayer, emptyDoc, flipLayer, moveLayer, redo, removeLayer,
  replace, alignLayer, mergeInto, moveLayerToEdge, selectLayer, selectedLayer, startHistory, toLayerPoint, undo, updateLayer, updateGroup, type AlignTo, type Blend, type GroupBlend, type CropId, type Doc, type History, type Layer,
} from "./doc";
import { blankCanvas, cloneBitmap, getBitmap, loadBitmap, setBitmap, sizeOf } from "./bitmaps";
import { filterChannels, renderDoc, type Channels } from "./render";
import { AI_BUSY, AI_LABELS, aiInstruction, coverSource, padRect, resolveEditMode, resolveEditScope, type EditScope, type EditIntent, type AiMode, type Rect } from "./ai";
import {annotationGuide,annotationInstruction,annotationStorageKey,imageAnnotationsSchema,type ImageAnnotation} from "../annotations";
import {plainProblem} from "../../team/problems";
import {readSubjectRelight,subjectRelightKey} from "../subject-relight";
import {annotationMatte} from "./annotation-matte";
import {addAiResultLayer,cutoutModifiedResult,freezeModifyMatte,harmonizePatch,type ModifyMatte} from "./ai-layer";
import {createBrushStroke,compositeBrushStroke,brushEdgeBlur,type BrushStroke} from "./brush-stroke";
import {useDocuments} from "./use-documents";
import {mergeLayerIds,smartObjectIds,createSmartObject,applySmartContents,type MergeMode} from "./layer-actions";
import {drawMaskOutline} from "./mask-outline";
import {cropViewport,exposedBorder,hasExposedBorder,normalizeViewport,scaleViewport} from "./crop-extend";
import {hitObject,imageSignature,type ObjectRegion} from "./region-tools";
import { cropHandleAt, dragCrop, fullCrop, isFullCrop, type CropHandle, type CropRect } from "./crop";
import { ADJUSTMENTS, addAdjustLayer, aiCropRect, type AdjustKind, groupLayers, groupSelectionState, groupAncestors, isGroupDescendant, moveWithLinks, reorderLayer, isVisible, ratioOf, toggleGroup, ungroupGroup, ungroupLayer, type Locks } from "./doc";
import { groupMergeSource } from "./layer-actions";
import { allShape, selectionInLayerSpace, applyMaskToLayer, combine, eraseRegionMask, featheredMask, ratioPoint, selectionBounds, editSelected, invertSelection, lassoShape, marqueeRect, maskBitmap, rectShape, tinted, wandShape, type SelectMode } from "./selection";
import "./editor.css";
import { channelPixels, type PreviewChannel } from "./channel-preview";
import { reorderVisible } from "../../ds/dock-layout";
import {ToggleRow} from "../../ds";
import type {PreservationRecord} from "../../capabilities/edit-preservation";
import {PrecisionReview,type PrecisionResult} from "./PrecisionReview";
import {EnvironmentScout} from "./EnvironmentScout";
import {backgroundPixels,type ScoutInputs} from "./environment-scout";

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
type BrushStyle = "round-hard" | "round-soft" | "square-hard" | "square-soft" | "grain";
/* Stamp approach inspired by common open-source raster brush engines (Easy-Brush, MIT; libmypaint, ISC).
   The compact presets below are implemented locally, so no extra runtime dependency or preset asset ships here. */
const BRUSH_STYLES: Array<{ value: BrushStyle; label: string }> = [
  { value: "round-hard", label: "Hard round" },
  { value: "round-soft", label: "Soft round" },
  { value: "square-hard", label: "Hard square" },
  { value: "square-soft", label: "Soft square" },
  { value: "grain", label: "Grain" },
];
const SELECT_TOOLS: Tool[] = ["rect", "lasso", "wand", "subject"];
/** Native controls and overlays own their keyboard input, including range arrows and Space. */
function ownsKeyboard(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  return !!(element?.isContentEditable || element?.closest('input,textarea,select,button,a[href],[role="slider"],[role="dialog"],[role="menu"],[data-comfy-menu]') || document.querySelector('[role="dialog"][aria-modal="true"],[data-comfy-menu]'));
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
    { keys: ["Ctrl+T"], label: "Free transform" }, { keys: ["R"], label: "Rotate 90°" }, { keys: ["Shift+R"], label: "Rotate −90°" }, { keys: ["Alt+click"], label: "Pick color" }, { keys: ["Shift+click"], label: "Straight line" },
  ] },
  { title: "Selection", items: [
    { keys: ["Shift"], label: "Add" }, { keys: ["Alt"], label: "Subtract" }, { keys: ["Shift+Alt"], label: "Intersect" },
    { keys: ["Shift"], label: "Square" }, { keys: ["Alt"], label: "From center" }, { keys: ["Ctrl+A"], label: "All" },
    { keys: ["Ctrl+D"], label: "Deselect" }, { keys: ["Ctrl+Shift+D"], label: "Reselect" }, { keys: ["Ctrl+Shift+I"], label: "Invert" },
  ] },
  { title: "Layers", items: [
    { keys: ["Ctrl+J"], label: "Layer via copy" }, { keys: ["Ctrl+Shift+J"], label: "Layer via cut" }, { keys: ["Ctrl+E"], label: "Merge down" },
    { keys: ["Ctrl+Shift+E"], label: "Merge visible" }, { keys: ["Ctrl+["], label: "Move down" }, { keys: ["Ctrl+]"], label: "Move up" },
    { keys: ["Ctrl+click"], label: "Pick layer" },
  ] },
  { title: "Edit", items: [
    { keys: ["Delete"], label: "Erase selection" }, { keys: ["Alt+Backspace"], label: "Fill" }, { keys: ["Ctrl+Backspace"], label: "Fill background" },
    { keys: ["Arrows"], label: "Nudge (Shift ×10)" }, { keys: ["Ctrl+C"], label: "Copy" }, { keys: ["Ctrl+V"], label: "Paste as layer" },
    { keys: ["Ctrl+Z"], label: "Undo" }, { keys: ["Ctrl+Shift+Z"], label: "Redo" },
  ] },
  { title: "View & file", items: [
    { keys: ["Ctrl+0"], label: "Fit" }, { keys: ["Ctrl+1"], label: "100%" }, { keys: ["Ctrl++", "Ctrl+−"], label: "Zoom" }, { keys: ["Wheel"], label: "Zoom" },
    { keys: ["Ctrl+S"], label: "Save" }, { keys: ["Ctrl+Shift+S"], label: "Download PNG" },
  ] },
  { title: "Mouse & gestures", items: [
    { keys: ["Shift+drag"], label: "Move on one axis" }, { keys: ["Esc"], label: "Cancel the current gesture" },
    { keys: ["Alt+↑", "Alt+↓"], label: "Reorder panels" }, { keys: ["Drag"], label: "Panel grip" },
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
const toPng = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be exported."))), "image/png"));

export function ImageEditor({ workspace, project, userId, call, canEdit, authorized, inpaint, edit, segment, precision, openAssetId, freeInput = false, onOpenModels }: { workspace: Workspace; project: Project; userId:string; call: Call; canEdit: boolean; authorized: boolean; inpaint?: InpaintRoute; /** Qwen Image Edit: Modify, Harmonize and Generative fill. */ edit?: InpaintRoute; /** SAM 3.1: select parts by name. */ segment?: InpaintRoute; precision?: InpaintRoute; /** An image from the Library to open right away (from Create Image). */ openAssetId?: string; freeInput?: boolean; onOpenModels?:()=>void }) {
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
  const [quickMaskTarget,setQuickMaskTarget]=useState<"foreground"|"background"|"elements">("foreground");
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
  const [allLayers, setAllLayers] = useState(false);
  const lastSelection = useRef<string | null>(null);
  const lastStroke = useRef<null | { layerId: string; p: { x: number; y: number } }>(null);
  const digits = useRef({ text: "", at: 0 });
  const [aiPrompt, setAiPrompt] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [annotations,setAnnotations]=useState<ImageAnnotation[]>([]),[annotationSrc,setAnnotationSrc]=useState("");
  const annotationHandoff=useRef("");
  const [aiBusy, setAiBusy] = useState<AiMode | null>(null);
  const [editIntent,setEditIntent]=useState<EditIntent>("auto");
  const [preserveOriginal,setPreserveOriginal]=useState(false);
  const [editScope,setEditScope]=useState<EditScope>("auto");
  const [subjectRelight,setSubjectRelight]=useState(()=>typeof location!=="undefined"&&location.hash.endsWith("/relight"));
  const relightHandoff=useRef<string|null>(null);
  const [aiReference,setAiReference]=useState<Asset|null>(null),[referencePicker,setReferencePicker]=useState(false),[referenceBusy,setReferenceBusy]=useState(false);
  const [extraReferences,setExtraReferences]=useState<Array<Asset|null>>([null,null]),[referenceSlot,setReferenceSlot]=useState(0);
  const [aiCharacter,setAiCharacter]=useState<CharacterRecord|null>(null),[characterPicker,setCharacterPicker]=useState(false);
  const [swapCheck,setSwapCheck]=useState<{source:string;reference:string;result:string;label:string;run:string}|null>(null);
  const [swapOpen,setSwapOpen]=useState(false);
  const [characterPlacement,setCharacterPlacement]=useState<string|null>(null),[placingCharacter,setPlacingCharacter]=useState(false);
  const [characterSwap,setCharacterSwap]=useState(false);
  const placementSequence=useRef(0),placementAbort=useRef<AbortController|null>(null);
  useEffect(()=>()=>{placementSequence.current++;placementAbort.current?.abort();},[workspace.id,project.id,openAssetId]);
  useEffect(()=>{setSwapCheck(null);setSwapOpen(false);},[workspace.id,project.id,openAssetId]);
  const [characterManifest,setCharacterManifest]=useState<CapabilityManifestV2|null>(null);
  const hasReference=!!aiReference||!!aiCharacter;
  function chooseReference(asset:Asset){clearCharacterPlacement();setCharacterSwap(false);setAiCharacter(null);if(referenceSlot===0)setAiReference(asset);else setExtraReferences(previous=>previous.map((value,index)=>index===referenceSlot-1?asset:value));setPreserveOriginal(false);setReferencePicker(false);}
  const [preserveMode,setPreserveMode]=useState("replace");
  const [precisionContext,setPrecisionContext]=useState(32),[precisionFeather,setPrecisionFeather]=useState(.5);
  const [precisionSettings,setPrecisionSettings]=useState(false);
  const [precisionRun,setPrecisionRun]=useState<Run|null>(null);
  const [precisionResult,setPrecisionResult]=useState<PrecisionResult|null>(null);
  const precisionMatte=useRef<{runId:string;matte:ModifyMatte}|null>(null);
  const [precisionOpen,setPrecisionOpen]=useState(false),[precisionError,setPrecisionError]=useState("");
  const [environmentOpen,setEnvironmentOpen]=useState(false);
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
  const strokeMask = useRef(false);
  const strokeErase=useRef(false),outlineRevision=useRef(0),outlinePhase=useRef(0);
  const [hoverObjects,setHoverObjects]=useState(false),[objectsReady,setObjectsReady]=useState(0);
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
  const [colors, setColors] = useState<{ fg: string; bg: string; editing: "fg" | "bg" }>({ fg: "#ffffff", bg: "#000000", editing: "fg" });
  const [bitmapsReady, setBitmapsReady] = useState(0);
  const [picker, setPicker] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const savePending = useRef(false);
  const downloadPending = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
  const gesture = useRef<null | { kind: "move"; start: Doc; px: number; py: number; lx: number; ly: number } | { kind: "select"; start: Doc; mode: SelectMode; crop?: boolean } | { kind: "paint"; start: Doc; canvas: HTMLCanvasElement; surface:BrushStroke; layer: Layer; last: { x: number; y: number }; lastDoc: { x: number; y: number } }>(null);
  const brushTrail = useRef({ x: 0, y: 0, started: false, stamp: 0 });
  const pickCanvas = useRef<HTMLCanvasElement | null>(null);

  const doc = hist?.present ?? null;
  useEffect(()=>{
    if(!doc||(!location.hash.endsWith("/modify")&&!location.hash.endsWith("/annotate")&&!location.hash.endsWith("/relight")))return;
    const frame=requestAnimationFrame(()=>{const panel=document.querySelector<HTMLElement>('.ds-dock[aria-label="AI"]');if(panel?.hasAttribute("data-collapsed"))panel.querySelector<HTMLButtonElement>(".ds-dock__toggle")?.click();panel?.querySelector<HTMLTextAreaElement>("textarea")?.focus();});
    return()=>cancelAnimationFrame(frame);
  },[!!doc,openAssetId]);
  useEffect(()=>{
    if(!doc||!openAssetId||!location.hash.endsWith("/annotate"))return;
    const key=annotationStorageKey(workspace.id,openAssetId),raw=sessionStorage.getItem(key);
    if(!raw||annotationHandoff.current===raw)return;
    try{setAnnotations(imageAnnotationsSchema.parse(JSON.parse(raw)));setEditScope("image");setEditIntent("modify");annotationHandoff.current=raw;}catch{toast("The annotations could not be restored. Draw them again.");}
  },[!!doc,openAssetId,location.hash]);
  useEffect(()=>{
    if(!doc||!openAssetId||!location.hash.endsWith("/relight"))return;
    let raw:string|null=null;
    try{raw=sessionStorage.getItem(subjectRelightKey(workspace.id,project.id,openAssetId));}catch{toast("The relight instructions could not be read from browser storage.");return;}
    if(raw&&relightHandoff.current===raw)return;
    const handoff=readSubjectRelight(raw,{workspaceId:workspace.id,projectId:project.id,assetId:openAssetId});
    setSubjectRelight(true);
    if(!handoff){toast("The relight instructions are unavailable. Return to Relight and choose Relight subject again.");return;}
    relightHandoff.current=raw;setAiPrompt(handoff.prompt);setEditIntent("modify");setEditScope("layer");setPreserveOriginal(true);setPreserveMode("replace");setPrecisionFeather(0);setAnnotations([]);setAiReference(null);setAiCharacter(null);clearCharacterPlacement();setExtraReferences([null,null]);setSubject("person");setTool(segment?"subject":"lasso");
  },[!!doc,openAssetId,workspace.id,project.id]);
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
  const documentDialog=<Dialog open={documentPicker} title="Open document" onClose={()=>setDocumentPicker(false)} footer={<Button variant="secondary" onClick={()=>setDocumentPicker(false)}>Close</Button>}>
    {documents.records.length?documents.records.map(record=><Row key={record.id} label={`${record.kind==="recovery"?"Draft · ":""}${record.name}`} display={new Date(record.updated_at).toLocaleString()} disabled={documents.busy} onClick={()=>void documents.open(record.id).catch(()=>{})}/>):<Meta>No saved documents or recovery drafts in this project.</Meta>}
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
    const ch = channelsRef.current;
    if (!(ch.r && ch.g && ch.b && ch.a)) filterChannels(ctx, d.width, d.height, ch);
    if (d.selection) {
      const mask=getBitmap(d.selection),style=getComputedStyle(canvas);
      if(quickMask){
        const color=style.getPropertyValue("--accent").trim();let cached=quickMaskPreview.current;
        if(!cached||cached.key!==d.selection||cached.revision!==outlineRevision.current||cached.color!==color){const overlay=tinted(d.selection,color);cached=overlay?{key:d.selection,revision:outlineRevision.current,color,canvas:overlay}:null;quickMaskPreview.current=cached;}
        if(cached){ctx.save();ctx.globalAlpha=.24;ctx.drawImage(cached.canvas,0,0,d.width,d.height);ctx.restore();}
      }
      if(mask)drawMaskOutline(ctx,mask,outlineRevision.current,d.width/Math.max(1,canvas.getBoundingClientRect().width),style.getPropertyValue("--text-primary").trim(),style.getPropertyValue("--surface-page").trim(),outlinePhase.current);
    }
    if(tool==="subject"&&hoverObjects&&objectRegions.current?.signature===imageSignature(d)&&hoveredObject.current>=0){
      const region=objectRegions.current.regions[hoveredObject.current],style=getComputedStyle(canvas);
      if(region)drawMaskOutline(ctx,region.canvas,0,d.width/Math.max(1,canvas.getBoundingClientRect().width),style.getPropertyValue("--text-primary").trim(),style.getPropertyValue("--surface-page").trim());
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
  }, [tool,hoverObjects,quickMask]);
  useEffect(() => {
    if (doc) paint(doc);
  });
  useEffect(()=>{
    if(!doc?.selection||quickMask||(typeof matchMedia==="function"&&matchMedia("(prefers-reduced-motion: reduce)").matches))return;
    let frame=0,last=0;
    const animate=(time:number)=>{
      if(time-last>=80){outlinePhase.current=(outlinePhase.current+1)%6;const current=liveDoc.current;if(current)paint(current);last=time;}
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
    const down = (e: KeyboardEvent) => { if (e.defaultPrevented || e.isComposing || ownsKeyboard(e.target)) return; if (e.key === "Alt") { altDown.current = true; setAltHeld(true); } if (e.code === "Space") { spaceDown.current = true; e.preventDefault(); } };
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
    if (file) void addImage(file.name, URL.createObjectURL(file));
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

  async function uploadPng(canvas: HTMLCanvasElement, kind: "image" | "mask", name: string, parentId?:string) {
    const form = new FormData();
    form.append("file", new File([await toPng(canvas)], name, { type: "image/png" }));
    return call<Asset>(workspacePath(workspace.id, `assets?projectId=${project.id}&kind=${kind}${parentId?`&parentId=${encodeURIComponent(parentId)}`:""}`), "POST", form);
  }
  async function addReference(file:File|null){
    if(!file||!canEdit||!authorized||referenceBusy)return;setReferencePicker(false);setReferenceBusy(true);
    const url=URL.createObjectURL(file);
    try{const {bitmap,w,h}=await loadBitmap(url);if(w*h>67108864)throw new Error("The reference image is too large.");const c=blankCanvas(w,h);c.getContext("2d")!.drawImage(bitmap,0,0);const asset=await uploadPng(c,"image",`${file.name.replace(/\.[^.]+$/,"")}.png`);if(alive.current){chooseReference(asset);}}
    catch(error){if(alive.current)toast((error as Error).message);}
    finally{URL.revokeObjectURL(url);if(alive.current)setReferenceBusy(false);}
  }

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

  function environmentCanvases(snapshot:Doc){
    if(!snapshot.selection)throw Error("Select the foreground subject to keep first.");
    if(snapshot.width%8||snapshot.height%8||snapshot.width>2048||snapshot.height>2048)throw Error("Use a canvas up to 2048 pixels per side with dimensions divisible by 8.");
    const source=blankCanvas(snapshot.width,snapshot.height);renderDoc(source.getContext("2d")!,{...snapshot,selection:null},{background:true});
    const subjectMask=tinted(snapshot.selection,"#000");if(!subjectMask)throw Error("The selected subject mask is unavailable.");
    const mask=blankCanvas(snapshot.width,snapshot.height),ctx=mask.getContext("2d")!;ctx.drawImage(subjectMask,0,0);
    const pixels=ctx.getImageData(0,0,mask.width,mask.height);pixels.data.set(backgroundPixels(pixels.data));ctx.putImageData(pixels,0,0);
    return {source,mask};
  }
  async function scoutHash(canvas:HTMLCanvasElement){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await (await toPng(canvas)).arrayBuffer())),b=>b.toString(16).padStart(2,"0")).join("");}
  async function prepareEnvironment():Promise<ScoutInputs>{
    if(!doc||!canEdit||!authorized||aiBusy||selecting)throw Error("Finish the current edit before scouting locations.");
    const snapshot=doc,{source,mask}=environmentCanvases(snapshot);
    const original=await uploadPng(source,"image",`scout-source-${Date.now()}.png`),painted=await uploadPng(mask,"mask",`scout-background-${Date.now()}.png`);
    if(liveDoc.current!==snapshot)throw Error("The image changed while preparing previews. Start again with the current image.");
    if(!original.sha256||!painted.sha256)throw Error("The source and mask checksums could not be verified.");
    return {source:{id:original.id,sha256:original.sha256},mask:{id:painted.id,sha256:painted.sha256},width:snapshot.width,height:snapshot.height};
  }
  async function keepEnvironment(record:PreservationRecord,inputs:ScoutInputs){
    if(!canEdit||!authorized||!liveDoc.current)throw Error("The editor is read-only.");
    const {bitmap}=await loadBitmap(assetUrl(workspace.id,record.finalAssetId)),snapshot=liveDoc.current,{source,mask}=environmentCanvases(snapshot);
    const [sourceHash,maskHash]=await Promise.all([scoutHash(source),scoutHash(mask)]);
    if(liveDoc.current!==snapshot||sourceHash!==inputs.source.sha256||maskHash!==inputs.mask.sha256)throw Error("The canvas or subject mask changed. The preview stays in Library; create a new scout for this image.");
    const key=`bmp:environment${crypto.randomUUID()}`,out=blankCanvas(snapshot.width,snapshot.height);out.getContext("2d")!.drawImage(bitmap,0,0);setBitmap(key,out);
    setHist(h=>h&&h.present===snapshot?commit(h,addAiResultLayer(h.present,key,"Environment")):h);refreshBitmaps();toast("Environment applied as a new layer");
  }

  async function runPrecision(mode:AiMode){
    if(!doc||!doc.selection||!precision||aiBusy||!canEdit||!authorized)return;
    const snapshot=doc;
    setAiBusy(mode);setPrecisionRun(null);setPrecisionResult(null);setPrecisionError("");setPrecisionOpen(true);
    try{
      if(snapshot.width%8||snapshot.height%8||snapshot.width>2048||snapshot.height>2048)
        throw new Error("Use a canvas up to 2048 pixels per side with width and height divisible by 8 for this precision workflow.");
      const matte=mode==="fill"?null:freezeModifyMatte(snapshot,mode==="harmonize"?"composite":"layer");
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

  async function requestAi(mode:AiMode){
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
    if(annotations.length)return runAi("modify");
    const scope=resolveEditScope(editScope,aiPrompt,!!doc?.selection);
    if(mode!=="harmonize"&&scope!=="image"&&!hasReference&&precision&&preserveOriginal&&doc?.selection)return runPrecision(mode);
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
  async function runAi(mode: AiMode) {
    if (!doc || !edit || aiBusy || !canEdit || !authorized || (mode !== "harmonize" && !aiPrompt.trim()&&!annotations.length)) return;
    const annotated=annotations.length>0;
    const wholeImage=!characterPlacement&&(annotated||(mode!=="harmonize"&&resolveEditScope(editScope,aiPrompt,!!doc.selection)==="image"));
    const sel = wholeImage?null:doc.selection;
    if (mode === "fill" && !sel) return;
    const snapshot = wholeImage?{...doc,selection:null}:doc;
    setAiBusy(mode);
    try {
      if(annotated&&!edit.manifest.inputs.some(input=>input.id==="reference_image"))throw new Error("Choose a guided image edit workflow to apply annotations.");
      if(annotated&&hasReference)throw new Error("Clear character and appearance references before applying region annotations.");
      const integration=mode==="harmonize"?harmonizePatch(snapshot):null;
      const matte=annotated?annotationMatte(snapshot,annotations):mode==="fill"?null:integration?.matte??freezeModifyMatte(snapshot,wholeImage||!!characterPlacement?"composite":"layer");
      const bounds=matte?.bounds??(sel?selectionBounds(sel):null);
      if(sel&&!bounds)return;
      const region:Rect=annotated?{x:0,y:0,w:snapshot.width,h:snapshot.height}:integration?.region??(bounds?padRect(bounds,snapshot.width,snapshot.height,mode==="fill"?0.35:0.15):{x:0,y:0,w:snapshot.width,h:snapshot.height});
      const flat = blankCanvas(snapshot.width, snapshot.height);
      renderDoc(flat.getContext("2d")!, { ...snapshot, selection: null }, { background: true });
      const crop = blankCanvas(region.w, region.h);
      crop.getContext("2d")!.drawImage(flat, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
      const source = await uploadPng(crop, "image", `${mode}-source-${Date.now()}.png`);
      let reference=source;
      if(annotated)reference=await uploadPng(annotationGuide(flat,annotations),"image",`annotation-guide-${Date.now()}.png`);
      else if(aiReference)reference=aiReference;
      else if(integration){const target=blankCanvas(region.w,region.h);target.getContext("2d")!.drawImage(integration.target,region.x,region.y,region.w,region.h,0,0,region.w,region.h);reference=await uploadPng(target,"image",`harmonize-element-${Date.now()}.png`);}
      const inputs:Record<string,string>={source_image:source.id};if(edit.manifest.inputs.some(i=>i.id==="reference_image"))inputs.reference_image=reference.id;
      for(const [index,asset] of extraReferences.entries()){if(!asset||!aiReference)continue;const port=`reference_image_${index+2}`;if(!edit.manifest.inputs.some(input=>input.id===port))throw new Error("This workflow cannot use the additional references. Clear them or choose the updated guided edit workflow.");inputs[port]=asset.id;}
      const elementInputs=aiCharacter?characterEditBindings(aiCharacter,edit.manifest,project.id):{};
      for(const port of Object.keys(elementInputs))delete inputs[port];
      const referenceCount=aiCharacter?aiCharacter.referencePack.references.length:hasReference?(aiReference?1:0)+extraReferences.filter(Boolean).length:0;
      const characterIds=aiCharacter?.referencePack.references.map(reference=>reference.assetId)??[];
      let referenceSheet:Asset|null=null;
      if(aiCharacter&&characterIds.length>1){
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
      const referenceInstruction=referenceSheet?identityReferenceSheetInstruction(characterIds.length):identityReferenceInstruction(referenceCount);
      const instruction=annotated?annotationInstruction(annotations,aiPrompt):[aiInstruction(mode,characterPlacement&&aiCharacter?characterPlacementInstruction(aiCharacter.name,aiPrompt):aiPrompt),referenceInstruction].filter(Boolean).join(" ");
      const done = await runAndWait(edit, inputs, { prompt: instruction },undefined,elementInputs);
      if (!done || !alive.current) return;
      const out = done.output_ids[0];
      if (done.state !== "succeeded" || !out) throw new Error(done.error || `${AI_LABELS[mode]} did not finish.`);
      if(hasReference||aiCharacter){const referenceId=aiCharacter?.referencePack.references[0]?.assetId??reference.id;setSwapCheck({source:source.id,reference:referenceId,result:out,label:aiCharacter?.name??"Edited result",run:done.id});}
      const { bitmap, w: iw, h: ih } = await loadBitmap(assetUrl(workspace.id, out));
      const result = matte?cutoutModifiedResult(bitmap,region,matte):blankCanvas(snapshot.width, snapshot.height);
      const rc = result.getContext("2d")!;
      const src = coverSource(iw, ih, region);
      if(!matte)rc.drawImage(bitmap, src.x, src.y, src.w, src.h, region.x, region.y, region.w, region.h);
      if (sel&&!matte) {
        const soft = featheredMask(snapshot, sel, Math.max(2, Math.round(Math.min(region.w, region.h) * 0.01)),true);
        if (soft) {
          rc.globalCompositeOperation = "destination-in";
          rc.drawImage(soft, 0, 0);
        }
      }
      const key = `bmp:ai${Date.now().toString(36)}`;
      setBitmap(key, result);
      if(!liveDoc.current||imageSignature(liveDoc.current)!==imageSignature(snapshot))throw new Error("The image changed. The generated result remains in Library; this canvas was kept unchanged.");
      setHist((h0) => {
        if (!h0||imageSignature(h0.present)!==imageSignature(snapshot)) return h0;
        return commit(h0,addAiResultLayer(h0.present,key,AI_LABELS[mode],matte?.bounds));
      });
      thumbs.current.clear();
      refreshBitmaps();
      toast(`${AI_LABELS[mode]} added as a new layer`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      if (alive.current) setAiBusy(null);
    }
  }

  async function analyseObjects(prompt=subject.trim()||"object"){
    if(!doc||!segment||selecting||!canEdit||!authorized)return;
    const snapshot=doc,signature=imageSignature(doc);setSelecting(true);hoveredObject.current=-1;
    try{
      const flat=blankCanvas(doc.width,doc.height);renderDoc(flat.getContext("2d")!,{...doc,selection:null},{background:true});
      const source=await uploadPng(flat,"image",`objects-source-${Date.now()}.png`);
      const done=await runAndWait(segment,{source_image:source.id},{prompt:prompt.trim()||"object",individual_masks:true});
      if(!done||!alive.current)return;
      if(done.state!=="succeeded"||!done.output_ids.length)throw new Error(done.error||"No object masks returned.");
      const regions:ObjectRegion[]=[];
      for(const id of done.output_ids.slice(0,24)){
        const {bitmap}=await loadBitmap(assetUrl(workspace.id,id)),canvas=blankCanvas(snapshot.width,snapshot.height),c=canvas.getContext("2d",{willReadFrequently:true})!;
        c.drawImage(bitmap,0,0,snapshot.width,snapshot.height);const pixels=c.getImageData(0,0,snapshot.width,snapshot.height);let area=0;
        for(let i=0;i<pixels.data.length;i+=4){const v=pixels.data[i];pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=255;pixels.data[i+3]=v;if(v>127)area++;}
        if(area){c.putImageData(pixels,0,0);regions.push({canvas,alpha:pixels.data,area});}
      }
      if(!liveDoc.current||imageSignature(liveDoc.current)!==signature)throw new Error("The image changed. Analyse objects again.");
      objectRegions.current={signature,regions};setObjectsReady(regions.length);toast(regions.length?`${regions.length} object masks ready. Hover and click to select.`:"No matching objects. Try a different subject.");
    }catch(error){toast((error as Error).message);}
    finally{if(alive.current)setSelecting(false);}
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

  function groupSelected() {
    if (!doc || !layer) return;
    const ids = multiIds();
    if (ids.length === 1 && layer.group) return apply(ungroupLayer(doc, layer.id));
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
    if(!hist||!layer||!canEdit||!authorized||layer.kind==="adjust"||layer.locks?.position||quickMask||maskEdit||aiBusy||documents.busy||gesture.current||cropDrag.current||transformSession.current)return;
    transformSession.current={history:hist,tool};setTransforming(true);setTool("move");
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
    setMaskEdit(null);setQuickMask(value=>!value);
  }

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
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="t"&&!target?.closest('input,textarea,select,[contenteditable="true"]')&&!document.querySelector('[role="dialog"][aria-modal="true"],[data-comfy-menu],[role="menu"]')){e.preventDefault();beginTransform();return;}
    if(ownsKeyboard(e.target))return;
    if (!hist || !doc) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
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
      else if (key === "c" && !e.shiftKey && !window.getSelection()?.toString()) { done(); void copyImage(); }
      else if (key === "y") { done(); setHist((h) => (h ? redo(h) : h)); }
      else if (key === "d") { done(); selectionAction(e.shiftKey ? "reselect" : "clear"); }
      else if (key === "i" && e.shiftKey) { done(); selectionAction("invert"); }
      else if (key === "a") { done(); selectionAction("all"); }
      else if (key === "j") { done(); viaCopy(e.shiftKey); }
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
    if (key === "delete" || key === "backspace") { done(); if (doc.selection) selectionAction("delete"); else deleteSelected(); return; }
    if(key==="q"&&!e.shiftKey){done();toggleQuickMask();return;}
    const letters: Record<string, Tool> = { ...(segment ? { s: "subject" as Tool } : {}), v: "move", h: "hand", b: "brush", e: "eraser", m: "rect", l: "lasso", w: "wand", c: "crop", i: "eyedropper", z: "zoom" };
    if (key === "x" && !e.shiftKey) { done(); setColors((c) => ({ ...c, fg: c.bg, bg: c.fg })); return; }
    if (key === "d" && !e.shiftKey) { done(); setColors((c) => ({ ...c, fg: "#ffffff", bg: "#000000" })); return; }
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
  pasteHandler.current = (e: ClipboardEvent) => {
    if (e.defaultPrevented || !canEdit || ownsKeyboard(e.target)) return;
    const file = clipboardFile(e.clipboardData);
    if (!file || !file.type.startsWith("image/")) return;
    e.preventDefault();
    void addImage(file.name, URL.createObjectURL(file));
  };
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => pasteHandler.current(e);
    addEventListener("paste", onPaste);
    return () => removeEventListener("paste", onPaste);
  }, []);

  async function copyImage() {
    if (!doc) return;
    try {
      const flat = blankCanvas(doc.width, doc.height);
      renderDoc(flat.getContext("2d")!, { ...doc, selection: null });
      const bounds = doc.selection ? selectionBounds(doc.selection) : null;
      let out = flat;
      if (doc.selection && bounds) {
        const mask = getBitmap(doc.selection);
        const c = flat.getContext("2d")!;
        if (mask) {
          c.globalCompositeOperation = "destination-in";
          c.drawImage(mask, 0, 0);
        }
        out = blankCanvas(bounds.w, bounds.h);
        out.getContext("2d")!.drawImage(flat, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
      }
      const blob = await toPng(out);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast(doc.selection ? "Selection copied" : "Image copied");
    } catch {
      toast("The browser did not allow copying the image.");
    }
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
    if(tool==="subject"&&hoverObjects&&doc){
      const cached=objectRegions.current,p=point(event);
      if(cached?.signature===imageSignature(doc)){
        const index=hitObject(cached.regions,p.x,p.y,doc.width,doc.height);
        if(index>=0)apply({...doc,selection:combine(doc,cached.regions[index].canvas,event.altKey?"subtract":event.shiftKey?"add":selMode)});
      }else toast("Analyse objects to refresh the hover masks.");
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
    if (SELECT_TOOLS.includes(tool)) {
      /* Photoshop: Shift adds, Alt subtracts, Shift+Alt intersects. */
      const mode: SelectMode = event.shiftKey && event.altKey ? "intersect" : event.shiftKey ? "add" : event.altKey ? "subtract" : selMode;
      if (tool === "wand") {
        apply({ ...doc, selection: combine(doc, wandShape(doc, p, tolerance, { contiguous, onlyLayer: allLayers ? null : layer.id }), mode) });
        return;
      }
      gesture.current = { kind: "select", start: doc, mode };
      preview.current = { kind: tool as "rect" | "lasso", pts: [p] };
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
    const blur=brushEdgeBlur(size,brush.hardness);if(blur>0)ctx.filter=`blur(${blur}px)`;
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
      if (brush.style.startsWith("square")) {
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
    if(tool==="subject"&&hoverObjects&&doc&&!pointerDown.current){
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
    if ((tool === "eyedropper" || (tool === "brush" && event.altKey && !quickMask)) && doc) {
      const p = point(event);
      const hex = sampleHex(p);
      setColors((c) => (c[c.editing] === hex ? c : { ...c, [c.editing]: hex }));
      return;
    }
    const g = gesture.current;
    if (!g || !doc) return;
    const p = point(event);
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

  async function save() {
    const canvas = canvasRef.current;
    if (!canvas || !doc || savePending.current || !canEdit || !authorized) return;
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
      await call(workspacePath(workspace.id, `assets?projectId=${project.id}${parent}`), "POST", form);
      toast("Saved to Library");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      savePending.current = false;
      setSaving(false);
    }
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
        if(!g||seen.has(gid))return;
        seen.add(gid);
        const first=doc.layers.slice().reverse().find(x=>isGroupDescendant(doc,gid,x.group));
        if(first)rows.push(<LayerRow key={`group-${gid}`} name={g.name} depth={index} thumb={<Folder size={18} />} visible={g.visible} selected={false} onSelect={() => apply(selectLayer(doc, first.id))} onOpen={()=>setGroupSettingsId(gid)} onToggle={() => apply(toggleGroup(doc, gid))} />);
      });
      const depth=groups.length+(l.clip?1:0);
      const picture = thumbOf(l);
      rows.push(
        <LayerRow
          key={l.id} name={l.name} depth={depth} mask={l.mask && thumbKey(l.mask) ? <img src={thumbKey(l.mask)} alt="" /> : undefined} thumb={picture ? <img src={picture} alt="" /> : l.kind === "adjust" ? <Contrast size={18} /> : undefined}
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
            if (e.shiftKey && doc.selectedId && l.id !== doc.selectedId) return setMulti((m) => (m.includes(l.id) ? m.filter((x) => x !== l.id) : [...m, l.id]));
            setMulti([]);
            apply(selectLayer(doc, l.id));
          }}
          onOpen={() => { setMulti([]); apply(selectLayer(doc, l.id)); setFloating(l.kind === "adjust" ? "adjust" : "style"); }}
          onToggle={() => apply(updateLayer(doc, l.id, { visible: !l.visible }))}
          onDragStart={() => { dragId.current = l.id; setDragging(l.id); }}
          dropTarget={dropId === l.id && dragging !== l.id}
          onDragOver={() => { if (dragId.current && dragId.current !== l.id) setDropId(l.id); }}
          onDrop={() => { if (dragId.current && dragId.current !== l.id) apply(reorderLayer(doc, dragId.current, l.id)); dragId.current = null; setDragging(null); setDropId(null); }}
          onDragEnd={() => { dragId.current = null; setDragging(null); setDropId(null); }}
        />,
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
                <UploadSlot label="Open an image" hint="Drop a file or choose from this device" accept="image/*" disabled={!canEdit} onFile={addFile} />
                <Row label="Project image" display="Choose from Library" onClick={() => setPicker(true)} disabled={!authorized} />
                {authorized&&canEdit&&<Row label="Open document" display="Saved layers and recovery drafts" onClick={()=>setDocumentPicker(true)}/>}
                {BLANKS.map((b) => (
                  <Row key={b.id} label="Blank canvas" display={b.label} onClick={() => blank(b.w, b.h)} />
                ))}
              </div>
            }
          />
        </Page>
        <AssetPicker open={picker} assets={assets} workspace={workspace.id} canEdit={canEdit} onFile={(f) => { setPicker(false); addFile(f); }} onClose={() => setPicker(false)} onPick={(a) => { setPicker(false); void addImage(a.name, assetUrl(workspace.id, a.id)); }} />
        {documentDialog}
        {documentNotice}
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
              {canEdit&&authorized&&<MenuButton label="Document actions" icon={<Folder size={16}/>} items={[{id:"open",label:"Open document",onSelect:()=>setDocumentPicker(true)},{id:"png",label:"Save PNG to Library",onSelect:()=>void save(),disabled:saving}]}/>}
              {canEdit && authorized && <Button variant="primary" disabled={documents.busy} onClick={() => void documents.save().then(()=>toast("Layered document saved")).catch(()=>{})}>{documents.busy ? "Saving…" : "Save"}</Button>}
            </>)}
        >
          {transforming?<><Meta>Transforming layer: {layer?.name??"Layer"} · Alt scales from center · Shift snaps 15°</Meta><Button variant="secondary" onClick={()=>finishTransform(false)}>Cancel transform</Button><Button variant="primary" onClick={()=>finishTransform(true)}>Apply transform</Button></>:<>
          <Button variant="secondary" disabled={!canEdit} onClick={() => setPicker(true)}><ImagePlus size={16} />Import image</Button>
          <Button variant="secondary" onClick={()=>selectionAction("all")}>Select all</Button>
          {doc.selection&&<Button variant="secondary" onClick={()=>selectionAction("clear")}>Deselect</Button>}
          {layer&&layer.kind!=="adjust"&&!layer.locks?.position&&!quickMask&&!maskEdit&&canEdit&&authorized&&!aiBusy&&<Button variant="secondary" title={`Free transform ${layer.name} (Ctrl+T)`} onClick={beginTransform}>Transform layer</Button>}
          {canEdit&&authorized&&<Button variant="secondary" aria-pressed={quickMask} onClick={toggleQuickMask} title="Quick mask (Q)">{quickMask?"Exit quick mask":"Quick mask"}</Button>}
          {quickMask&&<>
            <SegmentedTabs quiet label="Quick mask target" value={quickMaskTarget} onChange={setQuickMaskTarget} items={[{id:"foreground",label:"Foreground"},{id:"background",label:"Background"},{id:"elements",label:"Elements"}]}/>
            <Button variant="primary" disabled={!segment||selecting||!canEdit||!authorized} disabledReason={!segment?"A ready automatic selection workflow is required.":undefined} onClick={()=>{
              if(quickMaskTarget==="elements"){setSubject("object");setHoverObjects(true);setTool("subject");void analyseObjects("object");return;}
              const query=quickMaskTarget==="background"?"background":"foreground subject";setSubject(query);setTool("subject");void selectSubject(query,{erase:false});
            }}>{selecting?"Finding mask…":quickMaskTarget==="elements"?"Find elements":"Find mask"}</Button>
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
              <Checkbox checked={allLayers} onChange={setAllLayers}>Sample all layers</Checkbox>
            </>
          )}
          {quickMask&&<Meta>Quick mask · automatic foreground, background, or element selection · Q returns to outlines</Meta>}
          {tool==="maskBrush"&&<Meta>Paint mask · Alt removes from the mask</Meta>}
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
          <Canvas>
            <Stage ref={stageRef}
              onDragOver={event=>{if(!subjectRelight&&edit&&canEdit&&authorized&&!aiBusy&&(event.dataTransfer.types.includes(CHARACTER_DRAG_TYPE)||event.dataTransfer.types.includes("text/plain")))event.preventDefault();}}
              onDrop={event=>{const id=characterDropId(event.dataTransfer.getData(CHARACTER_DRAG_TYPE),event.dataTransfer.getData("text/plain"));if(!id)return;event.preventDefault();event.stopPropagation();const canvas=canvasRef.current;if(!canvas)return;const bounds=canvas.getBoundingClientRect();if(bounds.width<=0||bounds.height<=0||event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom){toast("Drop the character inside the image.");return;}void placeCharacter(id,{x:(event.clientX-bounds.left)/bounds.width,y:(event.clientY-bounds.top)/bounds.height});}}
              onPointerDown={event=>{if(event.button===0&&event.target===event.currentTarget&&!transformSession.current){if(doc.selection)lastSelection.current=doc.selection;if(doc.selection||doc.selectedId)apply({...doc,selection:null,selectedId:null});setMulti([]);}}}
              status={aiBusy ? <Working label={AI_BUSY[aiBusy]} /> : selecting ? <Working label="Selecting…" /> : undefined} rail={transforming?undefined:(
              <div className="cf-editor-rail">
                <ToolRail label="Tool" value={tool} onChange={next=>{setTool(next);if(next==="maskBrush")setMaskEdit(null);}} items={[
                  { id: "crop", label: "Crop (C)", icon: <Crop size={18} /> },
                  { id: "move", label: "Move (V)", icon: <Move size={18} /> },
                  { id: "rect", label: "Rectangle select (M)", icon: <SquareDashed size={18} /> },
                  { id: "lasso", label: "Lasso select (L)", icon: <Lasso size={18} /> },
                  { id: "wand", label: "Magic wand (W)", icon: <WandSparkles size={18} /> },
                  ...(segment ? [{ id: "subject" as Tool, label: "Select subject (S)", icon: <ScanSearch size={18} /> }] : []),
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
              <canvas ref={canvasRef} tabIndex={0} aria-label="Image" data-tool={tool} className="cf-editor-canvas" onPointerDown={down} onPointerMove={moveEvent} onPointerUp={up} onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (!preview.current?.poly) cancelGesture(); }} onPointerLeave={() => { if (ringRef.current) ringRef.current.style.display = "none";if(hoveredObject.current>=0){hoveredObject.current=-1;paint(doc);} }} />
              {transforming&&layer&&cropScreen.w>0&&<TransformHandles box={{x:layer.x,y:layer.y,w:layer.w*layer.scale,h:layer.h*layer.scale,rotation:layer.rotation}} viewport={cropScreen} width={doc.width} height={doc.height}
                onStart={startTransformDrag} onMove={moveTransformDrag} onEnd={()=>{transformDrag.current=null;}} onCancel={cancelTransformDrag} onNudge={nudgeTransform} onApply={()=>finishTransform(true)} onDiscard={()=>finishTransform(false)}/>}
              {tool==="crop"&&cropScreen.w>0&&<CropHandles box={cropPreview??fullCrop(dims(doc))} viewport={cropScreen} width={doc.width} height={doc.height}
                onStart={(handle,event)=>{if(event.button!==0||aiBusy)return;const rect=cropBox.current??fullCrop(dims(doc));cropDrag.current=handle as CropHandle;cropStart.current={rect,point:point(event)};capture(event);}}
                onMove={moveEvent} onEnd={up} onCancel={cancelGesture}
                onNudge={(handle,dx,dy)=>{const rect=cropBox.current??fullCrop(dims(doc));setCropBox(dragCrop(rect,handle as CropHandle,{x:0,y:0},{x:dx,y:dy},dims(doc),autoExtend));paint(doc);}}/>}
              {SELECT_TOOLS.includes(tool) && <div className="cf-editor-selectionmodes ds-card">
                <SegmentedTabs quiet label="Selection mode" value={selMode} onChange={setSelMode} items={[{ id: "replace", label: "New" }, { id: "add", label: "Add" }, { id: "subtract", label: "Subtract" }, { id: "intersect", label: "Intersect" }]} />
              </div>}
              {tool === "subject" && segment && !selecting && !aiBusy && <div className="cf-editor-subject">
                <TextField label="Select subject" placeholder="face, hair, jacket, sleeve…" value={subject} onChange={setSubject} onKeyDown={(e) => { if (e.key === "Enter") void selectSubject(); }} />
                <Checkbox checked={hoverObjects} onChange={value=>{setHoverObjects(value);hoveredObject.current=-1;if(value)void analyseObjects();}}>Hover objects</Checkbox>
                {hoverObjects?<><Button variant="primary" disabled={!canEdit||!authorized} onClick={()=>void analyseObjects()}>Analyse objects</Button><Meta>{objectRegions.current?.signature===imageSignature(doc)?`${objectsReady} masks` : "Analyse to refresh"}</Meta></>:<Button variant="primary" disabled={!subject.trim() || !canEdit || !authorized} onClick={() => void selectSubject()}>Select</Button>}
              </div>}
              {tool === "crop" && cropPreview && doc && !isFullCrop(cropPreview, dims(doc)) && <div className="cf-editor-cropbar ds-card" role="group" aria-label="Crop">
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
                  ...(layer ? [{ id: "duplicate", label: "Duplicate layer", onSelect: duplicate }] : []),
                  ...(layer&&doc.layers.findIndex(l=>l.id===layer.id)>0?[{id:"merge",label:"Merge down",onSelect:()=>merge("down")}]:[]),
                  ...(selectedIds.length>1?[{id:"merge-selected",label:"Merge selected",onSelect:()=>merge("selected")},{id:"group-layers",label:"Group selected",onSelect:groupSelected},{id:"group-merge",label:"Group and merge",onSelect:()=>merge("selected")}]:[]),
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
                  <IconButton label={selectedIds.length > 1 ? "Group selected layers" : layer?.group ? "Ungroup" : "Group layer"} disabled={!layer} onClick={groupSelected}><Folder size={14} /></IconButton>
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
                <DockPanel key={id} {...drag} title="AI" end={!subjectRelight?<Button className="cf-editor-advanced-toggle" variant="ghost" aria-expanded={advancedOpen} aria-controls="cf-editor-ai-advanced" title={hasReference?"Advanced settings · reference set":"Advanced settings"} onClick={()=>setAdvancedOpen(open=>!open)}>Advanced</Button>:undefined}>
                <Block label="AI edits">
                  {!modifyRouteReady && modifyFix && <Notice priority={40} title="AI Modify is not ready" actions={<Button variant="secondary" disabled={!canEdit||!authorized} onClick={modifyFix.run}>{modifyFix.label}</Button>}>{modifyUnavailableReason} The editor stays available while setup is incomplete.</Notice>}
                  {precision&&!subjectRelight&&!characterPlacement&&<Button variant="secondary" disabled={!!aiBusy||selecting||!canEdit||!authorized} onClick={()=>setEnvironmentOpen(true)}>Environment</Button>}
                  {environmentOpen&&precision&&<EnvironmentScout scope={{userId,workspaceId:workspace.id,projectId:project.id}} manifest={precision.manifest} workerId={precision.workerId} routeId={precision.routeId} call={call} canEdit={canEdit&&authorized&&!aiBusy&&!selecting} hasSelection={!!doc.selection} onPrepare={prepareEnvironment} onKeep={keepEnvironment} onRefine={()=>{setEnvironmentOpen(false);setTool(doc.selection?"maskBrush":segment?"subject":"lasso");toast("Refine the foreground subject mask, then reopen Environment and choose New scout.");}} onClose={()=>setEnvironmentOpen(false)}/>}
                  {!subjectRelight&&!characterPlacement&&edit?.manifest.inputs.some(input=>input.id==="reference_image")&&<Toolbar><Button disabled={!!aiBusy} onClick={openAnnotations}>{annotations.length?"Edit annotations":"Annotate"}</Button>{annotations.length>0&&<Button disabled={!!aiBusy} onClick={()=>{setAnnotations([]);if(openAssetId)sessionStorage.removeItem(annotationStorageKey(workspace.id,openAssetId));}}>Clear annotations</Button>}</Toolbar>}
                  <AnnotationEditor open={!!annotationSrc} src={annotationSrc} initial={annotations} onClose={()=>setAnnotationSrc("")} onApply={boxes=>{setAnnotations(boxes);setEditScope("image");setEditIntent("modify");setAnnotationSrc("");if(openAssetId)sessionStorage.setItem(annotationStorageKey(workspace.id,openAssetId),JSON.stringify(boxes));}}/>
                  {!subjectRelight&&edit?.manifest.inputs.some(input=>input.id==="reference_image")&&!aiCharacter&&<Row label="Character" display="Choose a saved character" disabled={!!aiBusy||referenceBusy||placingCharacter} onClick={()=>{setCharacterManifest(edit.manifest);setCharacterPicker(true);}}/>}
                  {!subjectRelight&&edit&&aiCharacter&&<><CastCard name={aiCharacter.name} portrait={aiCharacter.referencePack.references[0]?assetUrl(workspace.id,aiCharacter.referencePack.references[0].assetId):undefined} stats={[`${aiCharacter.referencePack.references.length} ${aiCharacter.referencePack.references.length===1?"reference":"references"}`,characterUsageCaption(aiCharacter.usage)].filter(Boolean).join(" · ")} draggable={!aiBusy&&!placingCharacter&&canEdit&&authorized} onDragStart={event=>{event.dataTransfer.setData(CHARACTER_DRAG_TYPE,aiCharacter.id);event.dataTransfer.setData("text/plain",`character:${aiCharacter.id}`);event.dataTransfer.effectAllowed="copy";}} onActivate={aiBusy||placingCharacter||!authorized||!canEdit?undefined:()=>{setCharacterManifest(edit.manifest);setCharacterPicker(true);}}/><Toolbar><Button disabled={!!aiBusy||placingCharacter||!canEdit||!authorized} onClick={()=>void placeCharacter(aiCharacter,{x:.5,y:.5})}>Place in center</Button><Button disabled={!!aiBusy||placingCharacter||!canEdit||!authorized} onClick={()=>{clearCharacterPlacement();setCharacterSwap(true);setAiPrompt(characterSwapInstruction(aiCharacter.name,aiPrompt));setEditScope("layer");setEditIntent("modify");setPreserveOriginal(false);if(!doc?.selection){setTool(segment?"subject":"lasso");toast("Select the person to replace. Swap person stays disabled until a selection exists.");return;}toast("Swap instructions ready. Choose Swap person to replace the selected person.");}}>{characterSwap?"Swap person":doc?.selection?"Swap masked person":"Select person to swap"}</Button><Button disabled={!!aiBusy||placingCharacter} onClick={()=>{clearCharacterPlacement();setAiCharacter(null);}}>Clear character</Button><InfoButton title="Character placement"><Meta>Drag the card onto the image, or place it in the center. Review and refine the selection before generation. Position, pose and identity remain approximate.</Meta></InfoButton></Toolbar></>}
                  {characterPlacement&&<Button disabled={!!aiBusy||placingCharacter} onClick={clearCharacterPlacement}>Use normal editing</Button>}
                  <PromptField compact labelOutside label="What should change" placeholder="e.g. change the winter scene to summer" value={aiPrompt} disabled={!!aiBusy} onChange={setAiPrompt} />
                  {subjectRelight&&<><Meta>Select and review the subject mask before relighting. Pixels outside the effective mask use the precision workflow.</Meta><Button variant="secondary" disabled={!!aiBusy} onClick={()=>{setSubjectRelight(false);if(openAssetId)sessionStorage.removeItem(subjectRelightKey(workspace.id,project.id,openAssetId));location.hash=`imageedit/${openAssetId??""}/modify`;}}>Use normal editing</Button>{(precisionRun||precisionResult||precisionError)&&<Button variant="secondary" onClick={()=>setPrecisionOpen(true)}>Review edit</Button>}</>}
                  {!subjectRelight&&advancedOpen&&<div className="cf-editor-ai-advanced" id="cf-editor-ai-advanced">
                  <InlineSelect label="Edit intent" value={editIntent} onChange={value=>setEditIntent(value as EditIntent)} options={[{value:"auto",label:"Auto"},{value:"modify",label:"Change existing content"},...(doc.selection?[{value:"fill",label:"Fill selection"}]:[]),{value:"harmonize",label:"Integrate selected layer"}]}/>
                  <InlineSelect label="Edit scope" value={editScope} onChange={value=>setEditScope(value as EditScope)} options={[{value:"auto",label:"Auto"},{value:"layer",label:"Selected layer / selection"},{value:"image",label:"Whole image"}]}/>
                  {!aiCharacter&&edit?.manifest.inputs.some(input=>input.id==="reference_image")&&<><Row label="Reference image" display={referenceBusy&&referenceSlot===0?"Uploading…":aiReference?.name??"Choose from project or device"} disabled={!!aiBusy||referenceBusy} onClick={()=>{setReferenceSlot(0);setReferencePicker(true);}}/>{aiReference&&<>{extraReferences.map((asset,index)=>edit.manifest.inputs.some(input=>input.id===`reference_image_${index+2}`)?<Row key={index} label={`${index===0?"Second":"Third"} reference`} display={referenceBusy&&referenceSlot===index+1?"Uploading…":asset?.name??"Optional · another view of the same subject"} disabled={!!aiBusy||referenceBusy} onClick={()=>{setReferenceSlot(index+1);setReferencePicker(true);}}/>:null)}<Button variant="secondary" disabled={!!aiBusy||referenceBusy} onClick={()=>{setAiReference(null);setExtraReferences([null,null]);}}>Clear references</Button></>}</>}
                  {precision && doc.selection && !hasReference&&editIntent!=="harmonize" && <>
                    <ToggleRow label="Preserve original" hint="Localized still edit using the installed upstream preservation nodes" checked={preserveOriginal} onChange={setPreserveOriginal} disabled={!!aiBusy}/>
                    {preserveOriginal && <>
                      <SegmentedTabs quiet label="Preservation mask mode" value={preserveMode} items={[{id:"replace",label:"Replace"},{id:"add",label:"Add"},{id:"subtract",label:"Subtract"}]} onChange={setPreserveMode}/>
                      <Row label="Precision settings" display={`${precisionContext} px context · ${precisionFeather} % feather`} onClick={()=>setPrecisionSettings(true)}/>
                    </>}
                  </>}
                  {(precisionRun || precisionResult || precisionError || (precision&&aiBusy&&preserveOriginal&&doc.selection)) && <Button buttonRef={precisionOpener} variant="secondary" onClick={()=>setPrecisionOpen(true)}>Review edit</Button>}
                  {swapCheck&&<Button variant="secondary" onClick={()=>setSwapOpen(true)}>Swap check</Button>}
                  </div>}
                  {aiBusy ? (
                    <Working label={AI_BUSY[aiBusy]} hint="ComfyUI is generating" />
                  ) : (
                    <Toolbar className="cf-editor-ai-actions">
                      {subjectRelight&&precision&&<Button variant="primary" disabled={selecting||!canEdit||!authorized||!aiPrompt.trim()} onClick={()=>{if(doc.selection)void requestAi("modify");else if(segment)void selectSubject();else{setTool("lasso");toast("Draw around the subject, then choose Relight subject.");}}}>{selecting?"Selecting subject…":doc.selection?"Relight subject":segment?"Select subject":"Select subject with lasso"}</Button>}
                      {!subjectRelight&&<Button variant="primary"
                        disabled={!modifyRouteReady || referenceBusy||placingCharacter||!canEdit || !authorized || (characterPlacement&&!doc.selection) || (characterSwap&&!doc.selection) || (!aiPrompt.trim()&&!annotations.length&&editIntent!=="harmonize")}
                        disabledReason={characterPlacement&&!doc.selection ? "Select the target area before placing the character." : characterSwap&&!doc.selection ? "Select the person to replace." : undefined}
                        onClick={() => void requestAi(modifyMode)}>{characterPlacement?"Place character":characterSwap?"Swap person":"Modify"}</Button>}
                    </Toolbar>
                  )}
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
                                      <SliderField label="Brightness" unit="%" min={0} max={200} value={layer.brightness} onChange={(v) => applyLive(`b${layer.id}`, (d) => updateLayer(d, layer.id, { brightness: v }))} />
                    <SliderField label="Contrast" unit="%" min={0} max={200} value={layer.contrast} onChange={(v) => applyLive(`c${layer.id}`, (d) => updateLayer(d, layer.id, { contrast: v }))} />
                    <SliderField label="Saturation" unit="%" min={0} max={200} value={layer.saturation} onChange={(v) => applyLive(`t${layer.id}`, (d) => updateLayer(d, layer.id, { saturation: v }))} />
                    {layer.hue !== undefined && <SliderField label="Hue" unit="°" min={-180} max={180} value={layer.hue} onChange={(v) => applyLive(`hu${layer.id}`, (d) => updateLayer(d, layer.id, { hue: v }))} />}
                    {layer.grayscale !== undefined && <SliderField label="Black & White" unit="%" min={0} max={100} value={layer.grayscale} onChange={(v) => applyLive(`gr${layer.id}`, (d) => updateLayer(d, layer.id, { grayscale: v }))} />}
                    {layer.invert !== undefined && <SliderField label="Invert" unit="%" min={0} max={100} value={layer.invert} onChange={(v) => applyLive(`in${layer.id}`, (d) => updateLayer(d, layer.id, { invert: v }))} />}
                    {layer.sepia !== undefined && <SliderField label="Photo filter" unit="%" min={0} max={100} value={layer.sepia} onChange={(v) => applyLive(`se${layer.id}`, (d) => updateLayer(d, layer.id, { sepia: v }))} />}
                    {layer.kind === "adjust" && <Checkbox checked={!!layer.clip} onChange={(v) => apply(updateLayer(doc, layer.id, { clip: v }))}>Only the layer below</Checkbox>}
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
      {documentNotice}
      {placementDraft.error&&<Notice priority={35} title="Placement draft" actions={<><Button variant="secondary" onClick={placementDraft.retry}>Retry draft</Button><Button variant="ghost" onClick={clearCharacterPlacement}>Clear draft</Button></>}>{placementDraft.error}</Notice>}
      {freeInput && (edit || (doc.selection && (inpaint||precision))) && <CommandBar
        label="What should change"
        placeholder="Describe what to change in this image"
        value={aiPrompt} onChange={setAiPrompt} busy={!!aiBusy}
        submitLabel={subjectRelight?"Relight subject":characterPlacement?"Place character":characterSwap?"Swap person":"Modify"}
        submitDisabled={!!aiBusy || referenceBusy||placingCharacter||!canEdit || !authorized || !aiPrompt.trim()||(subjectRelight&&(!doc.selection||!precision))||!!(characterPlacement&&!doc.selection)||!!(characterSwap&&!doc.selection)}
        onSubmit={() => void requestAi(resolveEditMode(editIntent,aiPrompt,!!doc.selection))}
      />}
      <Dialog open={precisionSettings} title="Precision settings" onClose={()=>setPrecisionSettings(false)} footer={<Button variant="secondary" onClick={()=>setPrecisionSettings(false)}>Done</Button>}>
        <SliderField label="Context" unit="px" min={0} max={512} step={16} value={precisionContext} onChange={setPrecisionContext}/>
        <SliderField label="Feather" unit="% diagonal" min={0} max={3} step={.1} value={precisionFeather} onChange={setPrecisionFeather}/>
      </Dialog>
      <PrecisionReview open={precisionOpen} onClose={closePrecision} workspaceId={workspace.id} run={precisionRun} result={precisionResult} onCancel={cancelPrecision} onKeep={canEdit&&authorized?keepPrecision:undefined} onRetake={precision&&canEdit&&authorized?retakePrecision:undefined} working={!!aiBusy} errorMessage={precisionError}/>
      {swapCheck&&<Dialog wide open={swapOpen} title="Swap check" onClose={()=>setSwapOpen(false)} footer={<><Button variant="secondary" onClick={downloadSwapProvenance}>Download provenance</Button><Button variant="secondary" onClick={()=>setSwapOpen(false)}>Close</Button></>}><ContactSheet title="Swap check" fileName="swap-check.png" caption={`Source, reference and result for ${swapCheck.label}. Review identity, pose, scale and lighting; this is not an identity score. Run ${swapCheck.run}.`} items={[{src:assetUrl(workspace.id,swapCheck.source),label:"Source"},{src:assetUrl(workspace.id,swapCheck.reference),label:"Reference"},{src:assetUrl(workspace.id,swapCheck.result),label:"Result"}]}/></Dialog>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <AssetPicker open={picker} assets={assets} workspace={workspace.id} canEdit={canEdit} onFile={(f) => { setPicker(false); addFile(f); }} onClose={() => setPicker(false)} onPick={(a) => { setPicker(false); void addImage(a.name, assetUrl(workspace.id, a.id)); }} />
      {characterManifest&&<CharacterReferencePicker open={characterPicker} onClose={()=>setCharacterPicker(false)} onPick={record=>{clearCharacterPlacement();setAiCharacter(record);setAiReference(null);setExtraReferences([null,null]);setPreserveOriginal(false);}} workspaceId={workspace.id} projectId={project.id} manifest={characterManifest} call={call} authorized={authorized}/>}
      <AssetPicker title="Reference image" open={referencePicker} assets={assets} workspace={workspace.id} canEdit={canEdit} onFile={file=>void addReference(file)} onClose={()=>setReferencePicker(false)} onPick={chooseReference}/>
    </div>
  );
}

function AssetPicker({title="Add image", open, assets, workspace, canEdit, onFile, onClose, onPick }: {title?:string; open: boolean; assets: Asset[]; workspace: string; canEdit: boolean; onFile: (file: File | null) => void; onClose: () => void; onPick: (asset: Asset) => void }) {
  return (
    <Dialog open={open} title={title} onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <UploadSlot compact label="From this device" hint="Drop a file or choose one" accept="image/*" disabled={!canEdit} onFile={onFile} />
      {assets.length > 0 && (
        <ThumbGrid label="Project images">
          {assets.map((a) => (
            <Thumb key={a.id} src={assetUrl(workspace, a.id)} label={a.name} onSelect={() => onPick(a)} />
          ))}
        </ThumbGrid>
      )}
    </Dialog>
  );
}
