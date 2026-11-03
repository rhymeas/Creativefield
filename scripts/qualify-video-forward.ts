/** One bounded native first-clip trial. Does not promote the route or restart any service. */
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import path from "node:path";
import {loadServerCatalogue} from "../server/catalogue";
import {compileLocal} from "../src/capabilities/compile";
import {assertWorkerUrl} from "../src/capabilities/policy";
import {inspectVideoSource} from "../server/video-extension-media";

const origin=process.env.COMFY_URL??"http://127.0.0.1:8188";assertWorkerUrl(origin);
const source=process.env.QUALIFY_SOURCE_VIDEO;if(!source)throw new Error("Set QUALIFY_SOURCE_VIDEO to a local cleared clip.");
if(!process.env.QUALIFY_EVIDENCE_DIR)throw new Error("Set QUALIFY_EVIDENCE_DIR to a dedicated evidence directory.");
const out=path.resolve(process.env.QUALIFY_EVIDENCE_DIR);
await mkdir(out,{recursive:true});
const facts=await inspectVideoSource(source,{sourceAssetId:randomUUID(),projectId:randomUUID()});
if(facts.frameRate.numerator/facts.frameRate.denominator!==16||facts.width%16||facts.height%16||facts.width*facts.height>399360||facts.frameCount>161||facts.frameCount<5)throw new Error("Qualification needs a short 16-FPS VACE-sized source.");
const bundle=(await loadServerCatalogue()).find(b=>b.manifest.id==="video-edit")!;
if(!bundle?.template||!Object.keys(bundle.template).length)throw new Error("Reviewed continuation graph missing.");
if(process.env.QUALIFY_UNET){if(!/^[a-zA-Z0-9_.-]+\.safetensors$/.test(process.env.QUALIFY_UNET))throw new Error("Use a model filename, not a path.");bundle.template["1"].inputs.unet_name=process.env.QUALIFY_UNET;}
if(process.env.QUALIFY_UPSTREAM_SAMPLING==="1"){
  // Wan-Video/Wan2.1 generate.py VACE defaults: 50 steps, shift 16.
  bundle.template["13"].inputs.shift=16;bundle.template["14"].inputs.steps=50;
}
async function json(url:string,init?:RequestInit){const r=await fetch(origin+url,{...init,signal:AbortSignal.timeout(30000)});const body=await r.json();if(!r.ok)throw new Error(`${url}: ${JSON.stringify(body).slice(0,400)}`);return body;}
const queue=await json("/queue");if(queue.queue_running.length||queue.queue_pending.length)throw new Error("Worker is occupied; no trial was submitted.");
const stats=await json("/system_stats");
if(!Number.isFinite(stats.system?.ram_free)||!Number.isFinite(stats.system?.ram_total)||stats.system.ram_free/stats.system.ram_total<.15)throw new Error("Host RAM is unknown or under pressure; no qualification was submitted.");
const info=await json("/object_info");for(const node of Object.values(bundle.template))if(!info[node.class_type])throw new Error(`Missing native node ${node.class_type}`);
const resume=process.env.QUALIFY_RESUME_PROMPT_ID;
if(resume){
  const receipt=JSON.parse(await readFile(path.join(out,"receipt.json"),"utf8"));
  const graph=await readFile(path.join(out,"graph.json"),"utf8");
  if(receipt.promptId!==resume||receipt.source.sha256!==facts.sha256||createHash("sha256").update(JSON.stringify(JSON.parse(graph))).digest("hex")!==receipt.graphSha256)throw new Error("Resume receipt does not match the exact prior source and graph.");
  const entry=(await json(`/history/${resume}`))[resume];if(!entry?.status?.completed||entry.status.status_str==="error")throw new Error("Prior native run has no successful completion.");
  const media=Object.values(entry.outputs?.["17"]??{}).flatMap(v=>Array.isArray(v)?v:[]).find((m:any)=>m?.type==="output"&&typeof m.filename==="string"&&m.filename.endsWith(".mp4")) as any;
  if(!media)throw new Error("The declared SaveVideo node has no MP4 artifact.");
  const r=await fetch(`${origin}/view?${new URLSearchParams({filename:media.filename,subfolder:media.subfolder??"",type:"output"})}`,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw new Error("Prior artifact unavailable.");
  const file=path.join(out,"continuation.mp4");await writeFile(file,Buffer.from(await r.arrayBuffer()));const output=await inspectVideoSource(file,{sourceAssetId:randomUUID(),projectId:facts.projectId});
  receipt.output=output;receipt.nativeArtifact=media;receipt.completedAt=new Date().toISOString();receipt.status=output.frameCount===13&&output.width===facts.width&&output.height===facts.height&&output.frameRate.numerator/output.frameRate.denominator===16&&!output.hasAudio?"succeeded":"failed";
  await writeFile(path.join(out,"receipt.json"),JSON.stringify(receipt,null,2));if(receipt.status!=="succeeded")throw new Error("Prior terminal artifact envelope mismatch.");
  console.log(JSON.stringify({status:receipt.status,promptId:resume,output,reusedNativeCompletion:true}));process.exit(0);
}
const name=`comfyfield-qualification-${randomUUID()}.mp4`,form=new FormData();form.append("image",new File([await readFile(source)],name,{type:"video/mp4"}));form.append("overwrite","false");
const upload=await json("/upload/image",{method:"POST",body:form});if(upload.name!==name||upload.subfolder)throw new Error("Unexpected upload receipt.");
const controls={prompt:process.env.QUALIFY_PROMPT??"A continuous cinematic shot of the same person and setting, gentle natural movement, consistent camera motion and lighting.",negative:"blurry, distorted, unstable, jump cut",seed:543,generation_frames:13,overlap_frames:5,context_start_frame:Math.max(0,Math.min(facts.frameCount,16)-5)};
const graph=compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:name},controls,audioPolicy:"mute"},{allowExperimental:true});
await writeFile(path.join(out,"graph.json"),JSON.stringify(graph,null,2));
const receipt:any={status:"submitting",source:facts,controls,modelName:graph["1"].inputs.unet_name,hardwareBefore:{ramFree:stats.system.ram_free,ramTotal:stats.system.ram_total,devices:stats.devices?.map((d:any)=>({name:d.name,vramTotal:d.vram_total,vramFree:d.vram_free}))},graphSha256:createHash("sha256").update(JSON.stringify(graph)).digest("hex"),startedAt:new Date().toISOString()};
const save=()=>writeFile(path.join(out,"receipt.json"),JSON.stringify(receipt,null,2));await save();
const posted=await json("/prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:graph,client_id:randomUUID()})});
receipt.promptId=posted.prompt_id;receipt.status="running";await save();console.log(JSON.stringify({promptId:receipt.promptId,frames:13,contextFrames:5,out}));
const deadline=Date.now()+900000;let done=false;
while(Date.now()<deadline){
  const entry=(await json(`/history/${receipt.promptId}`))[receipt.promptId];
  if(entry?.status?.status_str==="error"){receipt.status="failed";receipt.error=entry.status.messages?.find((m:any)=>m[0]==="execution_error")?.[1]?.exception_message??"Native execution failed";await save();throw new Error(receipt.error);}
  if(entry?.status?.completed){
    receipt.status="completed_unverified";await save();
    const media=Object.values(entry.outputs?.["17"]??{}).flatMap(v=>Array.isArray(v)?v:[]).find((m:any)=>m?.type==="output"&&typeof m.filename==="string"&&m.filename.endsWith(".mp4")) as any;
    if(!media)throw new Error("No MP4 artifact in native completion.");
    const response=await fetch(`${origin}/view?${new URLSearchParams({filename:media.filename,subfolder:media.subfolder??"",type:media.type??"output"})}`,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error("Native artifact unavailable.");
    const file=path.join(out,"continuation.mp4");await writeFile(file,Buffer.from(await response.arrayBuffer()));
    const output=await inspectVideoSource(file,{sourceAssetId:randomUUID(),projectId:facts.projectId});
    if(output.frameCount!==13||output.width!==facts.width||output.height!==facts.height||output.frameRate.numerator/output.frameRate.denominator!==16||output.hasAudio)throw new Error("Continuation frame/geometry/audio envelope mismatch.");
    receipt.status="succeeded";receipt.output=output;receipt.completedAt=new Date().toISOString();receipt.nativeArtifact=media;await save();console.log(JSON.stringify({status:receipt.status,promptId:receipt.promptId,output}));done=true;break;
  }
  await new Promise(resolve=>setTimeout(resolve,2000));
}
if(!done){receipt.status="timeout";await save();const current=await json("/queue");if(current.queue_running.some((r:any[])=>r[1]===receipt.promptId))await json("/interrupt",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).catch(()=>{});else await json("/queue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({delete:[receipt.promptId]})}).catch(()=>{});throw new Error("One bounded trial timed out; inspect its receipt before any retry.");}
