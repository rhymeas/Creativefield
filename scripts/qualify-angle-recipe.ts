// Explicitly opted-in, two-job local SDK qualification; never a cloud fallback.
// Run with COMFYFIELD_QUALIFY_ANGLES=1 and explicit source, source hash and output.
// An existing receipt prevents accidental resubmission.
import {createHash,randomUUID} from "node:crypto";
import {mkdir,readFile,writeFile,access} from "node:fs/promises";
import path from "node:path";
import {Comfy} from "@comfyorg/sdk";
import {compileLocal} from "../src/capabilities/compile";
import type {CapabilityManifestV2} from "../src/capabilities/types";

const root=path.resolve(import.meta.dirname,".."),native="http://127.0.0.1:8188",proxy="http://127.0.0.1:8189";
const backend=process.env.QUALIFY_ANGLE_BACKEND??"flux2-klein-angles";
const prepareOnly=process.argv.includes("--prepare");
const output=process.env.QUALIFY_ANGLE_OUTPUT;
const source=process.env.QUALIFY_ANGLE_SOURCE;
const expectedSource=process.env.QUALIFY_EXPECTED_SOURCE_SHA256;
if(!output||!source||!expectedSource||!/^[a-f0-9]{64}$/i.test(expectedSource))throw Error("Set QUALIFY_ANGLE_OUTPUT, QUALIFY_ANGLE_SOURCE and QUALIFY_EXPECTED_SOURCE_SHA256.");
const hash=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");

async function main(){
  if(!["flux2-klein-angles","qwen-image-21-edit"].includes(backend))throw Error("Unsupported qualification backend.");
  if(!prepareOnly&&process.env.COMFYFIELD_QUALIFY_ANGLES!=="1")throw Error("Set COMFYFIELD_QUALIFY_ANGLES=1 only after approving two local renders and at most three minutes monitoring.");
  await mkdir(output,{recursive:true});
  const receiptPath=path.join(output,"receipt.json");
  try{await access(receiptPath);throw Error("Receipt already exists. Inspect it; do not resubmit this qualification.");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  const bytes=await readFile(source);if(hash(bytes)!==expectedSource.toLowerCase())throw Error("Source differs from the reviewed baseline.");
  const manifestBytes=await readFile(path.join(root,"native-workflows/flux2-klein-angles/manifest.json"));
  const angleManifest=JSON.parse(manifestBytes.toString()) as CapabilityManifestV2;
  if(angleManifest.version!=="0.2.0")throw Error("This comparison is pinned to candidate recipe0.2.0.");
  const backendBytes=await readFile(path.join(root,`native-workflows/${backend}/manifest.json`));
  const manifest=JSON.parse(backendBytes.toString()) as CapabilityManifestV2;
  const template=JSON.parse(await readFile(path.join(root,`native-workflows/${backend}/template.api.json`),"utf8"));
  const graphFor=(presetId:string,filename:string)=>{
    const note="Preserve the subject and scene; change only the camera angle.";
    const qwen=backend==="qwen-image-21-edit";
    const controls=Object.fromEntries(manifest.controls.filter(c=>c.default!==undefined).map(c=>[c.id,c.default!])) as Record<string,string|number|boolean>;
    const instruction=angleManifest.presets.find(p=>p.id===presetId)?.values.prompt;
    if(typeof instruction!=="string")throw Error("Missing reviewed angle instruction.");
    Object.assign(controls,{seed:20261019,prompt:qwen?`${instruction}\n\n${note}`:note});
    return compileLocal({manifest,template},{capabilityId:manifest.id,version:manifest.version,routeId:"local",inputs:qwen?{source_image:filename,reference_image:filename}:{source_image:filename},controls,presetId:qwen?undefined:presetId,audioPolicy:"mute"});
  };
  if(prepareOnly){
    const graphs=Object.fromEntries(["left-45","right-45"].map(preset=>[preset,graphFor(preset,"comfyfield-reviewed-source.png")]));
    await writeFile(path.join(output,"prepared-plan.json"),JSON.stringify({backend,backendVersion:manifest.version,backendManifestSha256:hash(backendBytes),angleRecipe:angleManifest.version,sourceSha256:expectedSource,submitted:false,graphs},null,2)+"\n");
    console.log(JSON.stringify({backend,prepared:true,submitted:false,output}));return;
  }
  const queueResponse=await fetch(native+"/queue",{signal:AbortSignal.timeout(10000)});
  if(!queueResponse.ok)throw Error("Cannot inspect local worker queue.");
  const queue=await queueResponse.json();if(queue.queue_running.length||queue.queue_pending.length)throw Error("Local worker is busy; no job submitted.");
  const form=new FormData();form.append("image",new Blob([bytes],{type:"image/png"}),`comfyfield-angle-qa-${randomUUID()}.png`);form.append("overwrite","false");
  const upload=await fetch(native+"/upload/image",{method:"POST",body:form,signal:AbortSignal.timeout(15000)});
  if(!upload.ok)throw Error(`Source upload rejected: ${upload.status}`);
  const image=await upload.json();if(image.subfolder||image.type!=="input")throw Error("Unexpected source upload location.");
  process.env.COMFY_BASE_URL=proxy;delete process.env.COMFY_API_KEY;
  const transport:typeof fetch=async(input,init)=>{
    const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);
    if(url.origin!==proxy)throw Error("Qualification SDK refuses any non-local-proxy request.");
    const signal=init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
    return fetch(input,{...init,signal});
  };
  const client=new Comfy({clientInfo:"ComfyField-angle-qualification",fetch:transport});
  const receipt:any={recipe:angleManifest.version,manifestSha256:hash(manifestBytes),backend,backendVersion:manifest.version,backendManifestSha256:hash(backendBytes),sourceSha256:expectedSource,transport:"official-sdk-local-proxy",proxy,native,startedAt:new Date().toISOString(),status:"started",jobs:[]};
  const save=()=>writeFile(receiptPath,JSON.stringify(receipt,null,2)+"\n");
  await save();const deadline=Date.now()+180000;
  for(const presetId of ["left-45","right-45"]){
    if(Date.now()>=deadline)throw Error("Three-minute comparison deadline reached before next submission.");
    const graph=graphFor(presetId,image.name),key=`angle-qualification-${randomUUID()}`;
    const record:any={presetId,key,graphSha256:hash(JSON.stringify(graph)),status:"submission_attempted"};receipt.jobs.push(record);
    await writeFile(path.join(output,`${presetId}-graph.json`),JSON.stringify(graph,null,2)+"\n");await save();
    let job:Awaited<ReturnType<Comfy["submit"]>>|undefined;
    try{
      job=await client.submit(client.workflows.fromJson(graph),{idempotencyKey:key,signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
      record.id=job.id;record.status=job.status;await save();console.log(JSON.stringify({presetId,id:job.id,status:job.status}));
      await job.wait(Math.max(1,deadline-Date.now()),AbortSignal.timeout(Math.max(1,deadline-Date.now())));
      record.status=job.status;if(job.status!=="succeeded")throw Error(`SDK job ended ${job.status}`);
      record.outputs=[];
      for(const [i,asset] of job.outputs.entries()){
        const filename=`${presetId}-${i}.png`;await asset.toFile(path.join(output,filename),{timeoutMs:15000});
        const png=await readFile(path.join(output,filename));
        if(png.toString("hex",0,8)!=="89504e470d0a1a0a")throw Error("Output is not PNG.");
        record.outputs.push({id:asset.id,name:asset.name,filename,sha256:hash(png),bytes:png.length,width:png.readUInt32BE(16),height:png.readUInt32BE(20)});
      }
      if(!record.outputs.length)throw Error("SDK returned no outputs.");
      await save();console.log(JSON.stringify({presetId,status:record.status,outputs:record.outputs}));
    }catch(e){
      record.error=(e as Error).message;
      if(job&&!['succeeded','failed','canceled','expired'].includes(job.status)){
        try{await job.cancel(AbortSignal.timeout(10000));record.status=job.status;}catch(cancel){record.cancellationError=(cancel as Error).message;}
      }
      receipt.status="needs_review";await save();throw e;
    }
  }
  receipt.status="completed";receipt.finishedAt=new Date().toISOString();await save();
}
main().catch(e=>{console.error((e as Error).message);process.exitCode=1;});
