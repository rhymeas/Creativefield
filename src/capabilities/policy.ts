import type { ApiGraph } from "../workflow/build";
import type { RouteDefinition } from "./types";

// This is a reviewed-template policy, not a network sandbox. Audit custom node code
// and use OS/network isolation before claiming a route has no network access.
export const APPROVED_PROVIDERS = new Set(["comfy-local", "comfy-cloud", "comfy-partner", "comfy-router", "bfl", "byteplus", "wan", "kling", "minimax", "ltx", "google-veo", "beeble"]);
export const APPROVED_LOCAL_CLASSES = new Set([
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
  "VAEEncode", "ConditioningZeroOut", "ReferenceLatent", "ImageScaleToTotalPixels",
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
export function assertLocalGraphPolicy(graph: ApiGraph): void {
  if (!Object.keys(graph).length) throw new Error("Workflow is empty");
  for (const [id, node] of Object.entries(graph)) {
    if (!node || forbiddenProvider(node.class_type) || !APPROVED_LOCAL_CLASSES.has(node.class_type)) {
      throw new Error(`Unreviewed or forbidden node at ${id}`);
    }
    // Local reviewed templates never need URLs. Prompt text containing a brand name
    // is permitted; execution addresses are not. Metadata is not inspected here.
    for (const [field, value] of Object.entries(node.inputs)) {
      if (typeof value === "string" && /^https?:\/\//i.test(value)) throw new Error(`Remote input in local graph: ${id}.${field}`);
    }
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
