import {admitAlignedMask} from "./aligned-mask-admission";
import {admitVideoContinuation} from "./video-continuation-input";
import type {VideoExtensionPlan} from "./video-extension-plan";
import type {PoolClient} from "pg";
import {z} from "zod";
import type {CapabilityBundle,Invocation,WorkerInventory} from "../src/capabilities/types";
import {compileLocal} from "../src/capabilities/compile";
import {capabilityReadiness} from "../src/capabilities/readiness";
import {HttpError} from "./auth";
import {hashToken,newId} from "./crypto";
import {fileSha256,inspectMaskVideo,withMaskInspection} from "./masked-media";
import type {DiskStore} from "./storage";
import sharp from "sharp";
import {estimateCropCanvasPixels,MAX_UPSCALED_CROP_PIXELS} from "./edit-preservation";
import {canonicalTrackingControls,trackingRequestSchema,validateTrackingSelection} from "./mask-tracking";
import {elementInputsSchema,resolveRunInputs} from "./element-inputs";
import {admitAlignedImageInputs} from "./image-input-admission";
import {validateVoiceInput} from "./voice-input";
import {admitPosePreview} from "./pose-preview-admission";
import {secondsToWanFrames} from "../src/workflow/build";
import {exactImageArtifactSlotSpecs,persistArtifactPlanWithClient,type ArtifactSlotSpec} from "./image-artifacts";
import {admitAlignedDepthVideo} from "./depth-video-admission";
import {admitPreparedFpsSource} from "./fps-prepare";
import {admitCleanVideoSource} from "./video-extension-prepare";
import {cleanSourceRule,maskNamesSource} from "../src/capabilities/clean";
import {CLOUD_UNAVAILABLE_REASON,cloudRoute} from "../src/capabilities/readiness";
import {prepareCloudInvocation} from "./cloud-readiness";
import {isVideoProbe,SCENE_VIDEO_PROBE_ID,VIDEO_PROBE_FRAMES} from "../src/capabilities/replace-video-probe";
import {admitSceneReference} from "./scene-probe-admission";
import {inspectNormalizedVideo} from "./video-extension-media";

export const scalarControls=z.record(z.string(),z.union([z.string().max(20000),z.number().finite(),z.boolean()]));
export const consentSchema=z.object({webcam:z.boolean().optional(),voice:z.boolean().optional(),cloudCredits:z.boolean().optional()}).strict();
export const requestSchema=z.object({projectId:z.uuid(),workerId:z.uuid(),idempotencyKey:z.string().min(8).max(128).refine(key=>!key.startsWith("storyboard:")&&!key.startsWith("storyboard-still:")&&!key.startsWith("video-extension:")&&!key.startsWith("pose-preview:"),"Internal execution prefixes are reserved"),capabilityId:z.string().max(120),version:z.string().max(40),routeId:z.string().max(80),inputs:z.record(z.string(),z.uuid()),elementInputs:elementInputsSchema.optional(),controls:scalarControls,presetId:z.string().min(1).max(80).optional(),consent:consentSchema.optional(),audioPolicy:z.enum(["preserve","replace","mix","mute"]),tracking:trackingRequestSchema.optional()}).strict();
export type RunRequest=z.infer<typeof requestSchema>;
export type PreparedRun={projectId:string;workerId:string;revisionId:string;invocation:Invocation;imageArtifactSpecs?:ArtifactSlotSpec[]};
export type RunSlate={scene:number;shot:number};
export const publicColumns="id,project_id,worker_id,created_by,capability_id,capability_version,route_id,state,remote_id,transport,error,output_ids,scene,shot,take,created_at,updated_at";
export function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function extension(contentType:string){return ({"image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/gif":"gif","video/webm":"webm","video/quicktime":"mov","audio/wav":"wav","audio/mpeg":"mp3"} as Record<string,string>)[contentType]??"mp4";}

export {approvedGeneratedMaskReview} from "./aligned-mask-admission";

/** Validate and freeze server-owned defaults and workflow before queueing any work. */
export async function prepareInvocation(client:PoolClient,catalogue:CapabilityBundle[],workspaceId:string,body:RunRequest,store?:DiskStore,context?:{videoContinuationPlan?:VideoExtensionPlan}):Promise<PreparedRun>{
  if(!(await client.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,body.projectId])).rowCount)throw new HttpError(404,"Project not found");
  const bundle=catalogue.find(b=>b.manifest.id===body.capabilityId);
  if(!bundle)throw new HttpError(404,"Capability not found");
  const worker=(await client.query("SELECT * FROM workers WHERE workspace_id=$1 AND id=$2 AND enabled=true",[workspaceId,body.workerId])).rows[0];
  if(!worker)throw new HttpError(404,"Worker not found");
  /* The worker a person picked decides where the run goes. A Comfy Cloud worker runs the pack's cloud
     route, whatever route id the caller knew (every chain and storyboard step keeps the same worker
     this way); a pack with no cloud route cannot run there at all, so say so in plain words: no
     tracking prompt, no run row, no submission. */
  if(worker.kind==="cloud"){
    if(!cloudRoute(bundle.manifest))throw new HttpError(422,CLOUD_UNAVAILABLE_REASON);
    return prepareCloudInvocation(client,catalogue,workspaceId,body);
  }
  if(!bundle.template||!bundle.manifest.routes.some(r=>r.id===body.routeId&&r.execution==="local_comfy"&&r.implementation==="implemented"))throw new HttpError(422,"Selected execution route is not implemented");
  const trackingMode=bundle.manifest.outputContract?.trackingMode??"points";
  if(bundle.manifest.outputContract){
    if(!body.tracking)throw new HttpError(400,trackingMode==="prompt"?"A mask prompt is required for this workflow":"Tracking points are required for this workflow");
    if(trackingMode==="prompt"){
      if(!("prompt" in body.tracking))throw new HttpError(400,"Use a short object phrase for this workflow");
      if("prompt" in body.controls)throw new HttpError(400,"The mask prompt is server-owned");
    }else{
      if(!("points" in body.tracking))throw new HttpError(400,"Tracking points are required for this workflow");
      if("include_points" in body.controls||"exclude_points" in body.controls)throw new HttpError(400,"Tracking coordinate controls are server-owned");
    }
  }else if(body.tracking)throw new HttpError(400,"Tracking input is not supported by this workflow");
  const inventory:WorkerInventory=structuredClone(worker.inventory??{online:false,nodes:[],models:[],credentials:[]});
  if(!worker.checked_at||Date.now()-new Date(worker.checked_at).getTime()>5*60*1000)inventory.online=false;
  const readiness=capabilityReadiness(bundle.manifest,body.routeId,inventory);
  if(readiness.state!=="ready")throw new HttpError(422,readiness.reasons.join(" "));
  const resolved=await resolveRunInputs(client,bundle.manifest,workspaceId,body.projectId,body.inputs,body.elementInputs);
  const assets=resolved.assets;
  const sceneReference=await (async()=>{
    if(bundle.manifest.id!==SCENE_VIDEO_PROBE_ID)return undefined;
    if(!store||!assets.scene_image?.storage_key)throw new HttpError(422,"Choose a stored scene image");
    try{return await admitSceneReference(assets.scene_image,await store.file(workspaceId,assets.scene_image.storage_key));}
    catch(e){throw new HttpError(422,(e as Error).message);}
  })();
  const videoProbe=isVideoProbe(bundle.manifest.id);
  if(videoProbe){
    if(!store||!assets.source_video?.storage_key)throw new HttpError(422,"The video-frame test needs a verified short source clip");
    const facts=await inspectNormalizedVideo(await store.file(workspaceId,assets.source_video.storage_key));
    if(facts.frameCount!==VIDEO_PROBE_FRAMES||facts.frameRate.numerator!==24*facts.frameRate.denominator)throw new HttpError(422,"The video-frame test requires exactly five frames at 24 fps; trim the source first");
  }
  /* Clip tools prepare cleanup here before submission. Existing aligned masks and
     continuation plans keep the source they were measured against. Replace
     character still requires its clean-source check even on a temporary failure. */
  const cleanRule=cleanSourceRule(bundle.manifest);
  let cleanSource:Awaited<ReturnType<typeof admitCleanVideoSource>>;
  if(cleanRule&&store&&!context?.videoContinuationPlan){
    const original=assets[cleanRule.sourceInput];
    const masks=(cleanRule.maskInputs??[]).map(role=>assets[role]);
    // A mask bound to this input cannot follow a newly cropped/inpainted copy.
    // Skip work that would be discarded, while preserving resolution of masks
    // that already name a previously cleaned copy through the existing path.
    if(original?.storage_key&&!masks.some(mask=>maskNamesSource(mask?.metadata,original))){
      const cleaned=await admitCleanVideoSource(client,store,workspaceId,original,cleanRule.fps,!!bundle.manifest.replaceContract||videoProbe);
      if(cleaned&&masks.every(mask=>maskNamesSource(mask?.metadata,{id:cleaned.asset.id,sha256:cleaned.asset.sha256}))){
        assets[cleanRule.sourceInput]=cleaned.asset;
        resolved.inputIds[cleanRule.sourceInput]=cleaned.asset.id;
        cleanSource=cleaned;
      }
    }
  }
  // Restyle and mask tracking open ordinary 24/30 fps footage at 16 fps, so one pass
  // keeps the whole 5 s clip. The prepared copy compiles in place of the upload.
  const fpsPrepare=await (async()=>{
    const contract=bundle.manifest.fpsPrepare;
    if(!contract)return undefined;
    if(!store)throw new HttpError(422,"The source video needs disk verification before it is prepared");
    const source=assets[contract.sourceInput];
    if(!source?.storage_key)throw new HttpError(422,"The source video is unavailable");
    return admitPreparedFpsSource(client,store,workspaceId,source);
  })();
  if(fpsPrepare&&bundle.manifest.fpsPrepare){const sourceInput=bundle.manifest.fpsPrepare.sourceInput;assets[sourceInput]=fpsPrepare.asset;resolved.inputIds[sourceInput]=fpsPrepare.asset.id;}
  const depthAlignmentSnapshot=bundle.manifest.id==="vace-depth-restyle"?await (async()=>{
    if(!store)throw new HttpError(503,"Depth alignment validation is unavailable");
    const source=assets.source_video,depth=assets.depth_video;
    if(!source?.storage_key||!depth?.storage_key)throw new HttpError(422,"Depth restyle requires stored source and preprocessed depth videos");
    return admitAlignedDepthVideo(source,depth,await store.file(workspaceId,source.storage_key),await store.file(workspaceId,depth.storage_key),body.projectId);
  })():undefined;
  if(bundle.manifest.id==="video-edit"){
    if(!context?.videoContinuationPlan)throw new HttpError(400,"Create forward continuation through the video-extension planner.");
    if(!store)throw new HttpError(503,"Continuation source validation is unavailable.");
    await admitVideoContinuation(assets.source_video,workspaceId,store,body.controls,context.videoContinuationPlan);
  }
  if(bundle.manifest.voiceContract){
    if(body.consent?.voice!==true)throw new HttpError(422,"Confirm permission to animate this portrait with the selected voice.");
    if(!store)throw new HttpError(503,"Voice input validation is unavailable.");
    const audio=assets[bundle.manifest.voiceContract.audioInput],controls=Object.fromEntries(bundle.manifest.controls.map(c=>[c.id,body.controls[c.id]??c.default]));
    const duration=secondsToWanFrames(Number(controls.length),bundle.manifest.timing!.fps)/bundle.manifest.timing!.fps;
    await validateVoiceInput(await store.file(workspaceId,audio.storage_key),audio.sha256,Number(controls.audio_start??0),duration);
  }
  // Receipt-only admission runs before any workflow revision or run is persisted.
  const imageInputSnapshot=bundle.manifest.imageInputContract?admitAlignedImageInputs(bundle.manifest.imageInputContract,assets):undefined;
  if(bundle.manifest.editPreservation&&imageInputSnapshot&&(imageInputSnapshot.width>2048||imageInputSnapshot.height>2048||imageInputSnapshot.width*imageInputSnapshot.height>4194304))
    throw new HttpError(422,"Precision edits currently support aligned still images up to 2048 pixels per side");
  if(bundle.manifest.editPreservation){
    const mask=assets[bundle.manifest.editPreservation.maskInput];
    if(!store||!mask?.storage_key)throw new HttpError(422,"Precision edits require a stored manual mask");
    const filename=await store.file(workspaceId,mask.storage_key);
    const source=assets[bundle.manifest.editPreservation.sourceInput];
    if(!source?.storage_key||await fileSha256(await store.file(workspaceId,source.storage_key))!==source.sha256)
      throw new HttpError(422,"The source image changed since upload; upload it again");
    if(await fileSha256(filename)!==mask.sha256)throw new HttpError(422,"The mask changed since upload; upload it again");
    const decoded=await sharp(filename,{limitInputPixels:4194304,failOn:"warning"}).removeAlpha().extractChannel(0).raw().toBuffer({resolveWithObject:true});
    const {width,height}=decoded.info;
    if(width!==imageInputSnapshot!.width||height!==imageInputSnapshot!.height)throw new HttpError(422,"The mask dimensions changed since upload");
    let selected=0,left=width,top=height,right=0,bottom=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(decoded.data[y*width+x]>127){selected++;left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
    if(!selected||selected===width*height)throw new HttpError(422,"Paint a local edit mask with both selected and protected pixels");
    const crop=bundle.template![bundle.manifest.editPreservation.cropNode].inputs;
    const context=typeof body.controls.context_pixels==="number"?body.controls.context_pixels:Number(crop.context_expand_pixels);
    if(estimateCropCanvasPixels(width,height,{left,top,right,bottom},context,Number(crop.force_width),Number(crop.force_height))>MAX_UPSCALED_CROP_PIXELS)
      throw new HttpError(422,"This mask would require an oversized crop. Enlarge the selection or increase Context in Advanced.");
  }
  const inputs=Object.fromEntries(Object.entries(assets).map(([role,asset])=>[role,`comfyfield-${asset.id}.${extension(asset.content_type)}`]));
  const workflowSha256=hashToken(canonical(bundle));
  const revision=(await client.query("INSERT INTO workflow_revisions(id,workspace_id,capability_id,version,sha256,manifest,graph) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,capability_id,sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING id",[newId(),workspaceId,body.capabilityId,body.version,workflowSha256,JSON.stringify(bundle.manifest),JSON.stringify(bundle.template)])).rows[0].id;
  const controls={...Object.fromEntries(bundle.manifest.controls.filter(c=>!c.disabledReason&&c.default!==undefined).map(c=>[c.id,c.default])),...body.controls};
  const preset=body.presetId?bundle.manifest.presets.find(candidate=>candidate.id===body.presetId):undefined;
  if(body.presetId&&!preset)throw new HttpError(400,"Selected preset is not part of this workflow");
  const invocation:Invocation={capabilityId:body.capabilityId,version:body.version,routeId:body.routeId,inputs:resolved.inputIds,controls,audioPolicy:body.audioPolicy,...(preset?{presetId:preset.id}:{}),...(body.consent?{consent:body.consent}:{})};
  if(depthAlignmentSnapshot)invocation.depthAlignmentSnapshot=depthAlignmentSnapshot;
  if(fpsPrepare)invocation.fpsPrepare=fpsPrepare.snapshot;
  if(cleanSource)invocation.cleanSource=cleanSource.snapshot;
  if(bundle.manifest.posePreviewContract){if(!store)throw new HttpError(422,"Pose preview requires stored driving frames");invocation.posePreviewSnapshot=await admitPosePreview(client,bundle.manifest,assets,workspaceId,body.projectId,store);}
  if(Object.keys(resolved.elementInputSnapshots).length)invocation.elementInputSnapshots=resolved.elementInputSnapshots;
  if(imageInputSnapshot)invocation.imageInputSnapshot=imageInputSnapshot;
  if(sceneReference)invocation.sceneReference=sceneReference;
  if(bundle.manifest.outputContract){
    const contract=bundle.manifest.outputContract,tracking=body.tracking!,source=assets[contract.sourceInput];
    if(!source||source.project_id!==body.projectId||!source.storage_key||!store)throw new HttpError(422,"Tracking admission requires a stored source video");
    let sourceFile:string,envelope:Awaited<ReturnType<typeof inspectMaskVideo>>;
    try{
      sourceFile=await store.file(workspaceId,source.storage_key);
      if(await fileSha256(sourceFile)!==source.sha256)throw new Error("hash mismatch");
      envelope=await withMaskInspection(()=>inspectMaskVideo(sourceFile));
    }catch(e){
      if(e instanceof HttpError)throw e;
      throw new HttpError(422,"Tracking source is missing or changed; upload it again");
    }
    const route=bundle.manifest.routes.find(candidate=>candidate.id===body.routeId)!;
    const checkpoint=route.requirements.find(requirement=>requirement.id===contract.checkpointRequirementId);
    const checkpointSha256=checkpoint?.version?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
    if(!checkpoint||checkpoint.kind!=="model"||!checkpointSha256)throw new HttpError(422,"Tracking workflow checkpoint evidence is invalid");
    const snapshot={validationVersion:1 as const,sourceAssetId:source.id,sourceSha256:source.sha256,projectId:source.project_id,width:envelope.width,height:envelope.height,fps:16 as const,frames:envelope.frames,timingDigest:envelope.timingDigest,workflowId:bundle.manifest.id,workflowVersion:bundle.manifest.version,routeId:body.routeId,workflowRevisionId:revision,workflowSha256,requiredCheckpoint:checkpoint.name,requiredCheckpointSha256:checkpointSha256};
    if(trackingMode==="prompt"){
      if(!("prompt" in tracking))throw new HttpError(400,"Use a short object phrase for this workflow");
      controls.prompt=tracking.prompt;
      invocation.controls=controls;
      invocation.outputAssetId=newId();
      invocation.trackingSnapshot={...snapshot,trackingMode:"prompt",prompt:tracking.prompt};
    }else{
      if(!("points" in tracking))throw new HttpError(400,"Tracking points are required for this workflow");
      const selection={sourceAssetId:source.id,sourceSha256:source.sha256,projectId:source.project_id,frameIndex:tracking.frameIndex,objectIndex:tracking.objectIndex,points:tracking.points};
      const errors=validateTrackingSelection(selection,{assetId:source.id,projectId:source.project_id,sha256:source.sha256,width:envelope.width,height:envelope.height,fps:16,frames:envelope.frames,timingDigest:envelope.timingDigest});
      if(errors.length)throw new HttpError(400,errors.join(" "));
      Object.assign(controls,canonicalTrackingControls(tracking.points));
      invocation.controls=controls;
      invocation.outputAssetId=newId();
      invocation.trackingSnapshot={...snapshot,trackingMode:"points",frameIndex:0,objectIndex:1,points:tracking.points};
    }
  }
  if(bundle.manifest.mediaContract){
    if(!store)throw new HttpError(422,"Aligned-mask admission requires disk verification");
    const c=bundle.manifest.mediaContract,originalSource=assets[c.sourceInput],additional=c.additionalMaskInputs??[];
    if(additional.length)for(const name of ["prompt",...additional.map((_,index)=>`prompt_${index+2}`)])if(typeof controls[name]!=="string"||!(controls[name] as string).trim())throw new HttpError(422,"Describe the change for each selected area.");
    const primary=await admitAlignedMask(client,store,workspaceId,body.projectId,originalSource,assets[c.maskInput]);
    assets[c.sourceInput]=primary.source;
    resolved.inputIds[c.sourceInput]=primary.source.id;
    inputs[c.sourceInput]=`comfyfield-${primary.source.id}.${extension(primary.source.content_type!)}`;
    invocation.mediaSnapshot=primary.media;
    if(primary.review)invocation.maskReviewSnapshot=primary.review;
    if(primary.normalization)invocation.maskNormalization=primary.normalization;
    if(additional.length)invocation.additionalMaskSnapshots={};
    for(const role of additional){
      const region=await admitAlignedMask(client,store,workspaceId,body.projectId,originalSource,assets[role]);
      // Independently normalized copies may share one execution source only when their
      // verified bytes and decoded envelopes match exactly. Keep both original receipts.
      if(region.source.sha256!==primary.source.sha256||["width","height","frames","fps","timingDigest"].some(key=>region.media[key as keyof typeof region.media]!==primary.media[key as keyof typeof primary.media]))throw new HttpError(422,"Every edit mask must match the same decoded source and timeline.");
      invocation.additionalMaskSnapshots![role]={media:{...region.media,sourceAssetId:primary.source.id},...(region.review?{review:region.review}:{}),...(region.normalization?{normalization:region.normalization}:{})};
    }
  }
  try{compileLocal(bundle,{...invocation,inputs});}catch(e){throw new HttpError(400,(e as Error).message);}
  const imageArtifactSpecs=bundle.manifest.imageArtifacts?exactImageArtifactSlotSpecs(bundle.manifest.imageArtifacts):undefined;
  return {projectId:body.projectId,workerId:body.workerId,revisionId:revision,invocation,...(imageArtifactSpecs?{imageArtifactSpecs}:{})};
}

/** Internal only: caller owns the parent/idempotency lock and transaction. */
export async function enqueuePreparedRun(client:PoolClient,workspaceId:string,userId:string,prepared:PreparedRun,key:string,requestHash:string,slate:RunSlate={scene:1,shot:1}){
  if(!Number.isInteger(slate.scene)||slate.scene<1||slate.scene>32767||!Number.isInteger(slate.shot)||slate.shot<1||slate.shot>32767)throw new Error("A slate needs a positive scene and shot");
  const id=newId(),i=prepared.invocation;
  // Serialized per project/scene/shot/workflow: a deliberate resubmit gets a new take,
  // while the route's idempotency lookup keeps repeated transport requests on one run.
  const take=(await client.query(`INSERT INTO run_take_counters(workspace_id,project_id,scene,shot,capability_id,next_take) VALUES($1,$2,$3,$4,$5,2) ON CONFLICT(workspace_id,project_id,scene,shot,capability_id) DO UPDATE SET next_take=run_take_counters.next_take+1 RETURNING next_take-1 AS take`,[workspaceId,prepared.projectId,slate.scene,slate.shot,i.capabilityId])).rows[0].take;
  const run=(await client.query(`INSERT INTO runs(id,workspace_id,project_id,worker_id,workflow_revision_id,created_by,capability_id,capability_version,route_id,state,invocation,request_hash,idempotency_key,scene,shot,take) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13,$14,$15) RETURNING ${publicColumns}`,[id,workspaceId,prepared.projectId,prepared.workerId,prepared.revisionId,userId,i.capabilityId,i.version,i.routeId,JSON.stringify(i),requestHash,key,slate.scene,slate.shot,take])).rows[0];
  for(const [role,assetId] of Object.entries(i.inputs))await client.query("INSERT INTO run_inputs(workspace_id,run_id,asset_id,role) VALUES($1,$2,$3,$4)",[workspaceId,id,assetId,role]);
  if(prepared.imageArtifactSpecs)await persistArtifactPlanWithClient(client,{workspaceId,projectId:prepared.projectId,runId:id,specs:prepared.imageArtifactSpecs});
  await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,'pending')",[workspaceId,id]);return run;
}
export async function cancelRun(client:PoolClient,workspaceId:string,id:string){
  const result=await client.query("UPDATE runs SET state=CASE WHEN state='pending' THEN 'canceled' ELSE 'cancel_requested' END,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state IN ('pending','submitting','submission_unknown','queued','running') RETURNING state",[workspaceId,id]);
  if(result.rowCount){
    if(result.rows[0].state==="canceled")await client.query("UPDATE run_artifact_slots SET state='discarded',updated_at=now() WHERE workspace_id=$1 AND run_id=$2 AND state IN ('planned','staged')",[workspaceId,id]);
    await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,$3)",[workspaceId,id,result.rows[0].state]);
  }
  return result.rows[0]?.state as string|undefined;
}

