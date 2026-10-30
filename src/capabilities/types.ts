import type { ApiGraph } from "../workflow/build";
import type { ImageArtifactsContractV1 } from "./image-artifacts";
import type { ImageInputContractV1 } from "./image-input-contract";
import type {EditPreservationContract} from "./edit-preservation";
import type {WorkerHardware} from "./hardware";
import type {PosePreviewSnapshot} from "./pose-preview";

export type MediaType = "image" | "video" | "audio" | "mask" | "layer" | "reference" | "timeline" | "model3d";
export type ExecutionRoute = "local_comfy" | "comfy_cloud" | "comfy_partner" | "direct_provider";
export type ReadinessState = "ready" | "install_required" | "download_required" | "credentials_required" | "incompatible" | "offline" | "unsupported";
export type Implementation = "implemented" | "experimental" | "planned";
export type Binding = { node: string; field: string; transform?: "seconds_to_wan_frames" | "divide_native_scale" };
export type Port = { id: string; label: string; type: MediaType; required: boolean; binding?: Binding; representation?: "image" | "video"; omitWhenMissing?: boolean };
export type MaskSequenceSnapshot = {
  validationVersion: 1; sourceAssetId: string; sourceSha256: string; maskSha256: string;
  width: number; height: number; fps: 16; frames: number; timingDigest: string;
  semantics: "white_edits_black_preserves";
};
export type MaskNormalizationSnapshot = {
  validationVersion:1; contract:"mask_normalization_v1";
  originalSourceAssetId:string; originalSourceSha256:string; originalMaskSha256:string;
  normalizedSourceAssetId:string; normalizedSourceSha256:string; normalizedMaskAssetId:string; normalizedMaskSha256:string;
  width:number; height:number; fps:16; frames:number; timingDigest:string; transform:string;
};
/** Server-derived 16 fps copy of an uploaded clip, made before the graph compiles. */
export type FpsPrepareSnapshot = {
  validationVersion:1; contract:"source_16fps_v1";
  sourceAssetId:string; sourceSha256:string;
  preparedAssetId:string; preparedSha256:string;
  width:number; height:number; fps:16; frames:number; timingDigest:string;
  /** One short sentence when the clip was longer than the pass. */
  notice?:string;
};
/** Server-derived clean copy of a reference clip: the picture inside a screen recording, with the
 *  app chrome around it cropped away. Only present when an overlay region was found. */
export type CleanSourceSnapshot = {
  validationVersion:1; contract:"clean_source_v1";
  sourceAssetId:string; sourceSha256:string;
  cleanedAssetId:string; cleanedSha256:string;
  width:number; height:number;
  region:{x:number;y:number;width:number;height:number;aspect:string};
};
/** A chained follow-up the server queued for this run, once its own output was published. */
export type UpscaleChainSnapshot = {
  validationVersion:1; contract:"upscale_chain_v1";
  parentRunId:string; sourceAssetId:string; scale:2|4;
};
export type SourceLinkedMaskSnapshot = {
  validationVersion: 1; contract: "source_linked_mask_v1";
  sourceAssetId: string; sourceSha256: string; maskAssetId: string; maskSha256: string; projectId: string; producerRunId: string;
  width: number; height: number; fps: 16; frames: number; timingDigest: string;
  semantics: "white_edits_black_preserves";
  workflowId: string; workflowVersion: string; routeId:string; workflowRevisionId: string; workflowSha256: string;
  requiredCheckpoint: string; requiredCheckpointSha256: string;
};
export type TrackingRunSnapshot = {
  validationVersion:1; sourceAssetId:string; sourceSha256:string; projectId:string;
  width:number;height:number;fps:16;frames:number;timingDigest:string;
  trackingMode?:"points"|"prompt";
  frameIndex?:0;objectIndex?:1;points?:Array<{x:number;y:number;kind:"include"|"exclude"}>;
  prompt?:string;
  workflowId:string;workflowVersion:string;routeId:string;workflowRevisionId:string;workflowSha256:string;
  requiredCheckpoint:string;requiredCheckpointSha256:string;
};
export type MaskReviewDecisionReceipt = {
  validationVersion:1;contract:"source_linked_mask_review_v1";decision:"approved"|"rejected";
  maskAssetId:string;maskSha256:string;sourceAssetId:string;sourceSha256:string;projectId:string;producerRunId:string;
  reviewedBy:string;reviewedAt:string;
};
/** Server-derived receipt proving two upload validation receipts describe one
 * aligned still-image/mask pair. Geometry and semantic roles only; it does not
 * prove grayscale mask pixel content. */
export type AlignedImageInputSnapshot = {
  validationVersion: 1; contract: "aligned_still_image_mask_v1";
  sourceAssetId: string; sourceSha256: string; maskAssetId: string; maskSha256: string;
  width: number; height: number; dimensionMultiple: number;
  semantics: "white_edits_black_preserves";
};
export type ElementAssetSnapshotV1 = {
  validationVersion: 1;
  inputPort: string;
  elementId: string;
  elementKind: "character" | "product" | "environment" | "voice" | "style";
  assetId: string;
  assetSha256: string;
  assetMediaType: MediaType;
  assetProjectId: string | null;
};
export type Control = {
  id: string; label: string; type: "string" | "number" | "integer" | "boolean" | "select";
  default?: unknown; min?: number; max?: number; step?: number; options?: Array<string | number>;
  binding?: Binding; apiField?: string; disabledReason?: string; meaning?: "parameter" | "prompt_hint";
};
export type Requirement = { id: string; kind: "node" | "model" | "credential" | "software"; name: string; location?: string; version?: string; source?: string; sourceRevision?: string; bytes?: number; instructions: string };
export type RouteDefinition = {
  id: string; execution: ExecutionRoute; provider: string; upstreamProviders: string[];
  implementation: Implementation; workflowId?: string; endpointOrigin?: string;
  requirements: Requirement[]; evidence: string[];
};
export type CapabilityManifestV2 = {
  schemaVersion: 2; id: string; version: string; title: string; category: string; description: string;
  inputs: Port[]; outputs: Port[]; controls: Control[];
  presets: Array<{ id: string; title: string; values: Record<string, unknown> }>;
  routes: RouteDefinition[];
  coverage: { local: Implementation; hosted: Implementation };
  licenses: { software: string; weights: Array<{ name: string; license: string; source?: string }> };
  sources: Array<{ url: string; observedAt: string; kind: "research" | "implementation" }>;
  tickets: string[];
  timing?: { fps: number; minSeconds: number; maxSeconds: number; sourceTimed: boolean; frameMapping?: "wan_frames_round_4n1" | "wan_seconds_floor_4n1" };
  resolutions?: Record<string, { width: number; height: number }>;
  audioPolicies: Array<"preserve" | "replace" | "mix" | "mute">;
  nativeScale?: number;
  mediaContract?: { kind: "aligned_video_mask_v1"; sourceInput: string; maskInput: string; additionalMaskInputs?:string[] };
  outputContract?: { kind: "source_linked_mask_v1"; sourceInput: string; maskOutput: string; artifactNode: string; checkpointRequirementId: string; semantics: "white_edits_black_preserves"; trackingMode?: "points" | "prompt" };
  /** Wan Animate motion transfer: the named video input is normalized to silent
   * 24-CFR media server-side before compilation, and only the pinned artifact
   * node may publish output. Output is always audio-free (mute only). */
  motionContract?: { kind: "wan_animate_motion_v1"; motionInput: string; artifactNode: string; fps: 24 };
  /** Restyle and mask tracking: the named video input is resampled to 16 fps
   * with 4n+1 frames from its duration (17 to 81) before the graph compiles. */
  fpsPrepare?: { kind: "source_16fps_v1"; sourceInput: string };
  posePreviewContract?:{kind:"sdpose_preview_v1";frameInputs:string[];keypointNode:string;artifactNode:string};
  /** Character replace: the named video input is rendered in relay windows that carry the previous
   *  window's own frames, so only the native compiler may build this graph. SCAIL-2 chains its
   *  condition node; local jutsu compiles the reviewed anchor and Wan Animate 2 graph.
   *  `maxWindows` is how many windows the pack has actually been run with. */
  replaceContract?:{kind:"scail_replace_chunks_v1"|"jutsu_relay_v1";sourceInput:string;artifactNode:string;maxWindows?:number};
  voiceContract?:{kind:"wan_infinitetalk_v1";audioInput:string;trimNode:string;artifactNode:string};
  imageArtifacts?: ImageArtifactsContractV1;
  imageInputContract?: ImageInputContractV1;
  editPreservation?: EditPreservationContract;
  /** Edge-guided restyle: the prompt names the new place and this clause keeps the person from the clip. */
  subjectContract?:{kind:"keep_source_subject_v1"};
};
export type CapabilityBundle = { manifest: CapabilityManifestV2; template?: ApiGraph };
export type Readiness = { state: ReadinessState; reasons: string[]; missing: Requirement[] };
export type InventoryIssue = {
  scope: "object_info" | "models";
  code: "request_failed" | "invalid_response";
  folder?: string;
};
export type WorkerInventory = {
  online: boolean; nodes: string[]; models: string[]; credentials: string[];
  /** Optional for records written before probe evidence was introduced. */
  objectInfoChecked?: boolean;
  /** A missing model is confirmed only when its folder appears here. */
  checkedModelFolders?: string[];
  /** Comfy Cloud has no folder endpoint: the model files its own node list offers are the
   *  inventory, without a folder prefix. Absent until a probe has read such a list. */
  modelFiles?: string[];
  /** Sanitized probe diagnostics; never raw URLs, bodies, paths, or exception text. */
  inventoryIssues?: InventoryIssue[];
  hardware?:WorkerHardware;
  /** Consecutive failed probes; one failure keeps the previous inventory so a blip cannot reject work. */
  probeFailures?:number;
};
/** Read-only view of one ComfyUI server for the Models page. */
export type ComfyModelFolder = { name: string; files: string[]; error?: "request_failed" | "invalid_response" };
export type ComfyNodeInfo = { name: string; displayName: string; category: string; outputs: string[] };
export type ComfyLibrary = {
  workerId: string; workerName: string;
  online: boolean; version: string | null;
  nodes: ComfyNodeInfo[]; folders: ComfyModelFolder[];
  issues: string[]; fetchedAt: string;
  hardware?:WorkerHardware;
  storage?:{app:{volume:string;freeBytes:number}|null;models:{volume:string;freeBytes:number}|null};
};
export type Invocation = {
  /** Server-derived normalized frame lineage; never accepted from public requests. */
  posePreviewSnapshot?:PosePreviewSnapshot;
  capabilityId: string; version: string; routeId: string;
  inputs: Record<string, string>; controls: Record<string, unknown>;
  audioPolicy: "preserve" | "replace" | "mix" | "mute";
  /** Optional manifest preset. Compile merges its values and keeps the user's prompt as an extra note. */
  presetId?: string;
  /** Consent receipts for locally captured performance media. Stored with the run; never leaves this machine. */
  consent?: { webcam?: boolean; voice?: boolean; cloudCredits?:boolean };
  /** Server-derived validation receipt; never accepted from the public request. */
  mediaSnapshot?: MaskSequenceSnapshot;
  /** Server-derived independent admissions for additional masks; never accepted from public requests. */
  additionalMaskSnapshots?:Record<string,{media:MaskSequenceSnapshot;review?:MaskReviewDecisionReceipt;normalization?:MaskNormalizationSnapshot}>;
  /** Server-derived aligned-image admission receipt; never accepted from public requests. */
  imageInputSnapshot?: AlignedImageInputSnapshot;
  /** Frozen existing scene image for a bounded SCAIL handoff experiment. */
  sceneReference?:{version:1;assetId:string;sha256:string;bytes:number;width:number;height:number};
  /** Server-derived source/depth video alignment receipt; never accepted from public requests. */
  depthAlignmentSnapshot?: DepthAlignmentSnapshotV1;
  trackingSnapshot?: TrackingRunSnapshot;
  maskReviewSnapshot?: MaskReviewDecisionReceipt;
  /** Server-derived envelope normalization for ordinary camera footage; never accepted from public requests. */
  maskNormalization?: MaskNormalizationSnapshot;
  /** Server-derived 16 fps source copy and the one line that says a long clip was cut. */
  fpsPrepare?: FpsPrepareSnapshot;
  /** Server-derived clean copy of the reference clip; never accepted from public requests. */
  cleanSource?: CleanSourceSnapshot;
  /** Set on a chained upscale the server queued for another run; never accepted from public requests. */
  upscaleChain?: UpscaleChainSnapshot;
  /** Server-derived reusable Element bindings; never accepted from public requests. */
  elementInputSnapshots?: Record<string, ElementAssetSnapshotV1>;
  outputAssetId?: string;
};

export type DepthAlignmentSnapshotV1 = {
  validationVersion: 1;
  sourceAssetId: string;
  sourceSha256: string;
  depthAssetId: string;
  depthSha256: string;
  width: number;
  height: number;
  fps: 16;
  frames: number;
  timingDigest: string;
  depthEncoding: "grayscale_rgb8";
};
