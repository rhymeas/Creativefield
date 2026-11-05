import type { ApiGraph } from "../workflow/build";
import type { RouteDefinition } from "./types";

// This is a reviewed-template policy, not a network sandbox. Audit custom node code
// and use OS/network isolation before claiming a route has no network access.
export const APPROVED_PROVIDERS = new Set(["comfy-local", "comfy-cloud", "comfy-partner", "comfy-router", "bfl", "byteplus", "wan", "kling", "minimax", "ltx", "google-veo", "beeble"]);
export const APPROVED_LOCAL_CLASSES = new Set([
  // ComfyUI core comfy_extras/nodes_audio.py: allocates a silent audio tensor only.
  "EmptyAudio",
  // ComfyUI core nodes_compositing.py: splits a tensor into RGB and alpha only.
  "SplitImageWithAlpha",
  // Official Wan/VACE/SCAIL2/Animate2/Dancer/InfiniteTalk/Fun/S2V/HuMo/ATI/WanMove templates (comfyui_workflow_templates_json): ComfyUI core only
  // (nodes.py, comfy_extras nodes_wan, nodes_wandancer, nodes_wanmove, nodes_loop, nodes_toolkit, nodes_string, ...). Source reviewed 2026-10-29: no network,
  // process or eval access. Painter and RecordAudio only read the input folder. StartLoop/EndLoop run the iteration count the template sets.
  "AudioConcat", "ColorTransfer", "CreateList", "CustomCombo", "EmptyHunyuanLatentVideo", "EndLoop", "GenerateTracks", "GetItemFromList",
  "ImagePadForOutpaint", "ImageStitch", "LatentConcat", "LatentCut", "LatentCutToBatch", "LoraLoader", "Painter", "RebatchImages", "RecordAudio",
  "RegexExtract", "RepeatImageBatch", "SaveAnimatedWEBP", "SkipLayerGuidanceDiTSimple", "SolidMask", "StartLoop", "StringConcatenate",
  "StringReplace", "Wan22FunControlToVideo", "WanDancerEncodeAudio", "WanDancerPadKeyframesList", "WanDancerVideo", "WanFunInpaintToVideo",
  "WanHuMoImageToVideo", "WanMoveConcatTrack", "WanMoveTrackToVideo", "WanMoveTracksFromCoords", "WanMoveVisualizeTracks", "WanSoundImageToVideo",
  "WanSoundImageToVideoExtend", "WanTrackToVideo",
  // Core SD3 latent used by the pinned official Z-Image Turbo graph (reviewed 2026-10-28).
  "EmptySD3LatentImage",
  // Hunyuan3D 2.1 image-to-mesh, all ComfyUI core nodes (reviewed 2026-10-23).
  // Local speech: SaveAudio is core; FL_ChatterboxTTS is the ComfyUI_Fill-ChatterBox pack (MIT, reviewed 2026-10-24, commit f7d7a16).
  "FL_ChatterboxTTS", "SaveAudio",
  // SCAIL-2 character replacement: core comfy_extras nodes from the official template (reviewed 2026-10-24).
  "SCAIL2ColoredMask", "WanSCAILToVideo",
  // Two people in one SCAIL-2 pass: core EmptyImage paints the second identity's mask in the next
  // palette colour and core ImageBatch stacks the two reference views (reviewed 2026-10-26).
  "EmptyImage", "ImageBatch",
  // TRELLIS.2 image-to-3D with PBR textures, all ComfyUI core (comfy_extras) nodes (reviewed 2026-10-24).
  "ApplyTextureToMesh", "BakeAmbientOcclusion", "BakeNormalMapFromMesh", "BakeTextureFromVoxel", "CFGOverride", "DecimateMesh", "EmptyTrellis2LatentStructure", "GetMeshInfo", "ImageCropToMask", "LoadBackgroundRemovalModel", "MaskPreview", "MeshSmoothNormals", "MeshToFile3D", "PreviewImage", "RemeshMesh", "RemoveBackground", "RescaleCFG", "Trellis2Conditioning", "Trellis2ShapeStage", "Trellis2TextureStage", "Trellis2UpsampleStage", "UnwrapMesh", "VaeDecodeShapeTrellis", "VaeDecodeStructureTrellis2", "VaeDecodeTextureTrellis",
  "EmptyLatentHunyuan3Dv2", "Hunyuan3Dv2Conditioning", "ImageOnlyCheckpointLoader", "ModelSamplingAuraFlow", "SaveGLB", "VAEDecodeHunyuan3D", "VoxelToMesh",
  "BasicScheduler", "BatchImagesNode", "CLIPLoader", "CLIPTextEncode", "CLIPVisionEncode", "CLIPVisionLoader",
  "ComfyMathExpression", "ComfySwitchNode", "ContextWindowsManual", "CreateVideo", "GetImageSize", "GetVideoComponents",
  "ImageFromBatch", "ImageScale", "ImageScaleBy", "ImageUpscaleWithModel", "KSampler", "KSamplerAdvanced", "KSamplerSelect",
  "LoadImage", "LoadVideo", "LoraLoaderModelOnly", "ModelSamplingSD3", "PrimitiveBoolean", "PrimitiveFloat", "PrimitiveInt",
  "PrimitiveStringMultiline", "ResizeImageMaskNode", "SamplerCustom", "SaveVideo", "TrimVideoLatent", "UNETLoader",
  "UpscaleModelLoader", "VAEDecode", "VAELoader", "Wan22ImageToVideoLatent", "WanAnimate2Cache", "WanAnimate2ToVideo",
  "WanFirstLastFrameToVideo", "WanImageToVideo",
  "WanCameraEmbedding", "WanCameraImageToVideo",
  "WanVaceToVideo", "ImageToMask", "GrowMask", "InvertMask", "MaskToImage", "ImageCompositeMasked",
  // Core tensor-only threshold, pinned to1 in the reviewed VACE context graph.
  "ThresholdMask",
  // FIN-03 VACE structural restyle (Canny graph-execution MVP plus experimental preprocessed-depth).
  "Canny",
  // Qwen Image 2.1 local packs only (exact curated graphs; see native-workflows/qwen-image-21-t2i).
  "EmptyLatentImage", "QwenImage21Cache", "ResolutionSelector", "SaveImage", "SaveImageAdvanced", "TextEncodeQwenImage21",
  // FIN-01/02 experimental SD 2.1 inpaint pack.
  "CheckpointLoaderSimple", "VAEEncodeForInpaint",
  "DownloadAndLoadSAM2Model", "Sam2Segmentation",
  // Flux 2 Klein 4B local pack only (native-workflows/flux2-klein-t2i).
  "CFGGuider", "EmptyFlux2LatentImage", "Flux2Scheduler", "RandomNoise", "SamplerCustomAdvanced",
  // Flux 2 Klein image edit local pack only (native-workflows/flux2-klein-edit).
  "VAEEncode", "ConditioningZeroOut", "ReferenceLatent", "ImageScaleToTotalPixels", "ResizeAndPadImage",
  // Reviewed local-only preservation graph. Upstream source stays external;
  // these nodes process tensors/text and do not expose arbitrary API execution.
  "InpaintCrop", "InpaintStitch", "KleinEditComposite", "PreviewAny",
  // Reviewed ComfyUI core tensor-only SDPose extraction/drawing; local checkpoint required.
  "SDPoseKeypointExtractor", "SDPoseDrawKeypoints",
  // FILM frame interpolation local pack only (native-workflows/film-frame-interpolation).
  "FrameInterpolationModelLoader", "FrameInterpolate",
  // NVIDIA VFX RTX upscale local pack only (native-workflows/nvidia-vfx-upscale); the pack's
  // other two nodes are not used by the reviewed template.
  "RTXVideoSuperResolution",
  // SAM 3.1 text-prompted segmentation packs only (native-workflows/sam3-image-segment,
  // native-workflows/sam31-video-mask).
  "SAM3_Detect", "SAM3_VideoTrack", "SAM3_TrackToMask",
  // Imported community utility graphs (workingprototype/Fuobe, MIT): ComfyUI core comfy_extras nodes, tensor-only.
  // Source of nodes_compositing, nodes_moge and ResizeImagesByLongerEdge (nodes_dataset) read for network, process and
  // eval access on ComfyUI 0.37.0 (73c9bad) on 2026-10-30: none. ResizeImagesByLongerEdge is deprecated upstream.
  // Same review for nodes_video (ConcatenateVideo, Video Slice, SaveWEBM: PyAV and the output folder only) and ImageCrop.
  "ConcatenateVideo", "ImageCrop", "SaveWEBM", "Video Slice", "JoinImageWithAlpha", "LoadMoGeModel", "MoGeInference", "MoGePointMapToMesh", "MoGeRender", "ResizeImagesByLongerEdge",
  // OpenJutsu character swap (Comfy-Org/comfy-openjutsu graph): MiniMax H3 core nodes of ComfyUI 0.43 (nodes_minimax_h3,
  // nodes_model_advanced, nodes_multigpu) and Akatz Labs h3_character_swap at 0670e4f with Comfy's patch. Source read
  // 2026-10-31: no network access; subprocess only fixed ffmpeg/ffprobe argument lists into ComfyUI folders; numpy loads
  // with allow_pickle=False. Runs on the separate ComfyUI 0.43 worker, never the 0.37 one.
  "MiniMaxH3SigmaShift", "ModelAttentionBackend", "SelectCLIPDevice", "SAM3_VideoTrack", "H3CharacterSwapPrepareVideo", "H3CharacterSwapSelectSubject",
  "H3CharacterSwapRecoverMasks", "H3CharacterSwapExpandMask", "H3CharacterSwapModels", "H3CharacterSwapSettings", "H3CharacterSwapShot",
  "H3CharacterSwapWindowPlan", "H3CharacterSwapController", "H3CharacterSwapAssemble",
  // MiniMax H3 video (Kablex/ComfyUI-Ref2VA-VSA, Apache-2.0): core H3 reference-to-video, BasicGuider and VAEDecodeAudio, plus the
  // Ref2VAVSAGatePatch node (read 2026-10-31: torch and comfy-kitchen only, gate file via ComfyUI's safe loader).
  "MiniMaxH3ReferenceToVideo", "BasicGuider", "VAEDecodeAudio", "Ref2VAVSAGatePatch",
  // ComfyUI core 0.43 nodes of the official FLUX 3 Klein workflows (comfy_extras: bounding boxes, flux, string, edit_model; nodes.py).
  "CreateBoundingBoxes", "Flux3LayoutPrompt", "StringTrim", "StringContains", "ModelSamplingFlux", "StringFormat", "ReferenceMultiLatent", "RepeatLatentBatch",
  // ComfyUI core 0.43 Fibo 2.0 text encoder (comfy_extras/nodes_fibo2.py) of the official Fibo 2.0 edit template.
  "TextEncodeFibo2",
  // ComfyUI core nodes of the MiniMax H3 latent upscaler (PR 17412, comfy_extras/nodes_minimax_h3.py, nodes_hunyuan.py) and manual sigmas.
  "LatentUpscaleModelLoader", "MiniMaxH3LatentUpscaleWithModel", "ManualSigmas",
  // ComfyUI core 0.43 nodes of the official MiniMax H3 t2v/i2v and SeedVR2 video templates (comfy_extras/nodes_minimax_h3.py, nodes_seedvr.py; nodes.py).
  "MiniMaxH3ImageToVideo", "VAEEncodeTiled", "VAEDecodeTiled", "SeedVR2Preprocess", "SeedVR2PostProcessing", "SeedVR2Conditioning", "SeedVR2TemporalChunk", "SeedVR2TemporalMerge",
  // Native ComfyUI P-H3 image conditioning and the model-only LoRA loader.
  "PH3ImageConditioning", "LoraLoaderBypassModelOnly",
  // D3voz/openjutsu object swap (h3-object-swap). Partial review 2026-10-31: comfyui-h3-oneclick-swap, PromptBuilder, KJNodes, VHS read;
  // ComfyUI-MiniMaxH3-Context-Loop (108k lines, exec patches, optional cloud LLM code unused by this graph) not fully read; the user accepted that on 2026-10-31.
  "ImageScaleToMaxDimension", "TextGenerate", "VHS_LoadVideo", "H3ObjectSwapPlan", "MiniMaxH3GenerationProfile", "MiniMaxH3ChainPlanModern",
  "MiniMaxH3SourceTimeline", "MiniMaxH3ChainLoopStart", "MiniMaxH3ChainCurrent", "H3SourceSlice", "H3PeopleMask", "H3GreyMannequins", "GrowMaskWithBlur",
  "H3ClipShots", "H3FillShots", "MiniMaxH3ContexMaskGridPreview", "MiniMaxH3FantasticVideoEditLatent", "MiniMaxH3ContexMaskedTarget", "MiniMaxH3ChainContext",
  "MiniMaxH3LoopTrim", "MiniMaxH3ChainSegmentSave", "MiniMaxH3ChainReview", "MiniMaxH3ChainLoopEnd", "MiniMaxH3ChainAssemble",
  // Core audio/mask operations and the VideoHelperSuite frame selector.
  "AudioAdjustVolume", "MaskComposite", "VHS_SelectEveryNthImage",
  // Local single-speaker audio-driven animation; canonical bounded WAV inputs.
  "LoadAudio", "TrimAudioDuration", "AudioEncoderLoader", "AudioEncoderEncode", "ModelPatchLoader", "WanInfiniteTalkToVideo",
]);
const banned = /higgs[\W_]*field|genjutsu|pryx/i;
export function forbiddenProvider(value: string): boolean { return banned.test(value); }
export function assertIndependentProvider(provider: string, upstream: string[] = []): void {
  for (const id of [provider, ...upstream]) {
    if (forbiddenProvider(id) || !APPROVED_PROVIDERS.has(id)) throw new Error(`Execution provider is not approved: ${id}`);
  }
}
export function assertWorkerUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || forbiddenProvider(url.hostname)) {
    throw new Error("Worker must use an approved HTTP(S) origin without credentials, query or fragment");
  }
  if (url.pathname !== "/") throw new Error("Worker URL must be an origin");
  return url;
}
export function assertRoutePolicy(route: RouteDefinition): void {
  assertIndependentProvider(route.provider, route.upstreamProviders);
  if (route.execution === "local_comfy" && (route.provider !== "comfy-local" || route.upstreamProviders.length || route.endpointOrigin)) {
    throw new Error("Local routes cannot declare hosted execution");
  }
  /* A cloud route runs the same pack graph on Comfy Cloud: one provider, no upstream resale. */
  if (route.execution === "comfy_cloud" && (route.provider !== "comfy-cloud" || route.upstreamProviders.length)) {
    throw new Error("Cloud routes belong to Comfy Cloud only");
  }
  if (route.endpointOrigin) {
    const url = assertWorkerUrl(route.endpointOrigin);
    if (forbiddenProvider(url.hostname)) throw new Error("Forbidden execution endpoint");
  }
}
export const OPENJUTSU_ADVANCED_CLASSES = new Set(["H3AdvancedSwapPlan", "H3TrackCrops", "H3TrackRoles", "H3RoleMask"]);

export function assertLocalGraphPolicy(graph: ApiGraph, additionalClasses: ReadonlySet<string> = new Set()): void {
  if (!Object.keys(graph).length) throw new Error("Workflow is empty");
  for (const [id, node] of Object.entries(graph)) {
    if (!node || forbiddenProvider(node.class_type) || (!APPROVED_LOCAL_CLASSES.has(node.class_type) && !additionalClasses.has(node.class_type))) {
      const name = typeof node?.class_type === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(node.class_type) ? ` (${node.class_type})` : "";
      throw new Error(`Unreviewed or forbidden node at ${id}${name}`);
    }
    // Local reviewed templates never need URLs. Prompt text containing a brand name
    // is permitted; execution addresses are not. Metadata is not inspected here.
    for (const [field, value] of Object.entries(node.inputs)) {
      if (typeof value === "string" && /^https?:\/\//i.test(value)) throw new Error(`Remote input in local graph: ${id}.${field}`);
    }
    if (node.class_type === "StringFormat") assertPlainFormat(id, node.inputs.f_string);
  }
}

/** StringFormat is Python's str.format: a format text may only name values ({a}, {b!r}, {b:>8}), never reach
 *  into them ({a.__class__}, {a[0]}) or nest fields ({a:{b}}), and must be a literal so no link can feed one in.
 *  Scanned the way Python reads it: {{ and }} are escapes only outside a field. */
export function assertPlainFormat(id: string, f_string: unknown): void {
  if (typeof f_string !== "string") throw new Error(`StringFormat needs a literal format at ${id}`);
  const refuse = () => { throw new Error(`StringFormat may only name values at ${id}`); };
  for (let i = 0; i < f_string.length; i++) {
    const c = f_string[i];
    if (c === "}") { if (f_string[i + 1] === "}") { i++; continue; } refuse(); }
    if (c !== "{") continue;
    if (f_string[i + 1] === "{") { i++; continue; }
    const end = f_string.indexOf("}", i + 1);
    if (end < 0) refuse();
    if (!/^[A-Za-z_][A-Za-z0-9_]*(![rsa])?(:[^{}]*)?$/.test(f_string.slice(i + 1, end))) refuse();
    i = end;
  }
}

/** A cloud route runs on Comfy Cloud, which owns the node list and the model files, so the
 *  local allowlist does not apply: readiness checks the nodes the probed cloud reports. The
 *  graph itself must still be plain: named nodes, and files the server uploaded rather than
 *  addresses the browser chose. */
export function assertCloudGraphPolicy(graph: ApiGraph): void {
  if (!Object.keys(graph).length) throw new Error("Workflow is empty");
  for (const [id, node] of Object.entries(graph)) {
    if (!node || typeof node.class_type !== "string" || !/^[A-Za-z0-9_.-]+$/.test(node.class_type) || forbiddenProvider(node.class_type)) {
      throw new Error(`Unusable node at ${id}`);
    }
    for (const [field, value] of Object.entries(node.inputs)) {
      if (typeof value === "string" && /^https?:\/\//i.test(value)) throw new Error(`Remote input in cloud graph: ${id}.${field}`);
    }
  }
}
