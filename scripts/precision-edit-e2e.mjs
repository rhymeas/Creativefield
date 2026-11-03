// Opt-in real local generation. Reuses an explicit existing project/worker and
// durable per-case receipts; never retries an unknown or failed job automatically.
import {mkdir,readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import sharp from "sharp";

const cases={
  jacket:{source:"Studio product photograph of a plain red outdoor jacket on a torso mannequin, no head, no logo. Front view, centered entire jacket and sleeves, gray seamless background, detailed zipper, soft even light. No text.",edit:"Change only the red jacket to royal blue fabric. Keep the mannequin, zipper details, background, lighting and composition unchanged.",rect:[95,85,320,340]},
  prop:{source:"Product photograph of a small plain red ceramic coffee mug centered on a wooden desk, a closed beige book on the right, plain gray wall behind. The mug is entirely visible, soft daylight, no text or logos.",edit:"Change only the red coffee mug to cobalt blue glazed ceramic. Keep the wooden desk, book, wall and lighting unchanged.",rect:[150,155,210,215]},
  background:{source:"Photograph of a simple living room, white walls, beige sofa on the left foreground, a small potted green plant in the far right background corner. Wide static composition, natural daylight, no people, no text or logos.",edit:"Replace only the potted plant in the right background corner with a warm amber floor lamp. Keep the sofa, floor, white walls, lighting and framing unchanged.",rect:[360,125,144,320]},
};

async function main(){
  if(process.env.COMFYFIELD_PRECISION_QA!=="1"){console.log("Opt in with COMFYFIELD_PRECISION_QA=1 and explicit project/worker IDs; no model downloads occur.");return;}
  const which=process.argv[2],fixture=cases[which];if(!fixture)throw new Error("Choose jacket, prop or background");
  const origin=process.env.COMFYFIELD_URL??"http://127.0.0.1:8787";
  if(!["127.0.0.1","localhost","[::1]"].includes(new URL(origin).hostname))throw new Error("This QA script runs only against an explicit loopback app");
  const workspaceId=process.env.COMFYFIELD_WORKSPACE_ID,projectId=process.env.COMFYFIELD_PROJECT_ID,workerId=process.env.COMFYFIELD_QA_WORKER_ID;
  if(!workspaceId||!projectId||!workerId)throw new Error("Specify existing COMFYFIELD_WORKSPACE_ID, COMFYFIELD_PROJECT_ID and COMFYFIELD_QA_WORKER_ID");
  if(!process.env.COMFYFIELD_QA_OUTPUT)throw new Error("Set COMFYFIELD_QA_OUTPUT to a dedicated evidence directory.");
  const root=path.resolve(process.env.COMFYFIELD_QA_OUTPUT);await mkdir(root,{recursive:true});
  const receiptPath=path.join(root,which+".json");
  let receipt;try{receipt=JSON.parse(await readFile(receiptPath,"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;receipt={fixture:which,workspaceId,projectId,workerId,sourceKey:randomUUID(),editKey:randomUUID()};}
  if(receipt.workspaceId!==workspaceId||receipt.projectId!==projectId||receipt.workerId!==workerId)throw new Error("Receipt belongs to a different project or worker");
  const save=()=>writeFile(receiptPath,JSON.stringify(receipt,null,2)+"\n");await save();
  let cookie="";
  const request=async(method,tail,body,binary=false)=>{
    const headers={Origin:origin,...(cookie?{cookie}:{})};
    const form=body instanceof FormData;if(body!==undefined&&!form)headers["Content-Type"]="application/json";
    const response=await fetch(origin+"/api/v1"+tail,{method,headers,body:form?body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    const session=response.headers.getSetCookie?.().find(value=>value.startsWith("cf_session="));if(session)cookie=session.split(";")[0];
    if(!response.ok)throw new Error(`${method} ${tail}: ${response.status} ${(await response.text()).slice(0,240)}`);
    return binary?Buffer.from(await response.arrayBuffer()):response.json();
  };
  await request("GET","/auth/me");const base=`/workspaces/${workspaceId}`;
  const catalogue=await request("GET",base+"/catalogue");
  const worker=(await request("GET",base+"/workers")).find(w=>w.id===workerId&&w.enabled);
  if(!worker||!["127.0.0.1","localhost","[::1]"].includes(new URL(worker.origin).hostname))throw new Error("Use an enabled loopback worker; hosted routes are not used");
  await request("POST",`${base}/workers/${workerId}/probe`);
  const wait=async id=>{
    const deadline=Date.now()+180000;
    while(Date.now()<deadline){
      const run=await request("GET",`${base}/runs/${id}`);
      if(run.state==="succeeded")return run;
      if(["failed","canceled","submission_unknown","cancel_requested"].includes(run.state))throw new Error(`Run ${id} stopped at ${run.state}: ${run.error??""}; receipt retained, no automatic resubmit`);
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    throw new Error(`Run ${id} exceeded three minutes. Inspect the existing run; do not resubmit it.`);
  };
  if(process.argv.includes("--refine-mask")&&receipt.maskRevision!=="corrected-v2"){
    if(receipt.editRun){const previous=await request("GET",`${base}/runs/${receipt.editRun}`);if(!["succeeded","failed","canceled"].includes(previous.state))throw new Error("Resolve the existing job before starting a corrected-mask take");}
    receipt.previousAttempts=[...(receipt.previousAttempts??[]),{editRun:receipt.editRun,maskAsset:receipt.maskAsset,preservation:receipt.preservation,maskRevision:receipt.maskRevision??"rectangle-v1"}];
    delete receipt.editRun;delete receipt.maskAsset;delete receipt.preservation;delete receipt.completedAt;
    receipt.editKey=randomUUID();receipt.maskRevision="corrected-v2";await save();
  }
  const queue=async(capabilityId,key,inputs,controls)=>{
    const version=catalogue.find(c=>c.id===capabilityId)?.version;if(!version)throw new Error("Reviewed capability not available");
    if(capabilityId==="flux2-klein-preserve-edit"){receipt.precisionVersion=version;await save();}
    return request("POST",base+"/runs",{projectId,workerId,idempotencyKey:key,capabilityId,version,routeId:"local",inputs,controls,audioPolicy:"mute"});
  };
  if(!receipt.sourceRun){receipt.sourceRun=(await queue("flux2-klein-t2i",receipt.sourceKey,{}, {prompt:fixture.source,width:512,height:512,batch_size:1,steps:4,seed:20261021+Object.keys(cases).indexOf(which)})).id;await save();}
  const source=await wait(receipt.sourceRun);receipt.generatedSourceAsset=source.output_ids[0];await save();
  const original=await request("GET",`${base}/assets/${receipt.generatedSourceAsset}/content`,undefined,true);await writeFile(path.join(root,which+"-original.png"),original);
  // Mirrors the editor's aligned-input upload. Legacy generation outputs have
  // lightweight probes, not the strict decoded-PNG upload receipt this route requires.
  if(!receipt.validatedSourceAsset){
    const form=new FormData();form.append("file",new Blob([original],{type:"image/png"}),which+"-original.png");
    receipt.validatedSourceAsset=(await request("POST",`${base}/assets?projectId=${projectId}&kind=image`,form)).id;await save();
  }
  receipt.sourceAsset=receipt.validatedSourceAsset;await save();
  if(!receipt.maskAsset){
    const [x,y,w,h]=receipt.maskRevision==="corrected-v2"&&which==="background"?[410,180,100,285]:fixture.rect;
    let mask;
    if(receipt.maskRevision==="corrected-v2"&&which!=="background"){
      // Explicit color-wand fixture correction for the visible red material,
      // not an automatic semantic mask or a replacement preservation algorithm.
      const image=await sharp(original).removeAlpha().raw().toBuffer();const pixels=Buffer.alloc(512*512);
      for(let i=0;i<pixels.length;i++){const p=i*3,r=image[p],g=image[p+1],b=image[p+2];pixels[i]=r>40&&r>g*1.7&&r>b*1.7?255:0;}
      mask=await sharp(pixels,{raw:{width:512,height:512,channels:1}}).png().toBuffer();
    }else mask=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="black"/><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/></svg>`)).png().toBuffer();
    await writeFile(path.join(root,which+"-manual-mask.png"),mask);
    const form=new FormData();form.append("file",new Blob([mask],{type:"image/png"}),which+"-manual-mask.png");
    receipt.maskAsset=(await request("POST",`${base}/assets?projectId=${projectId}&kind=mask`,form)).id;await save();
  }
  if(!receipt.editRun){receipt.editRun=(await queue("flux2-klein-preserve-edit",receipt.editKey,{source_image:receipt.sourceAsset,edit_mask:receipt.maskAsset},{prompt:fixture.edit,steps:4,seed:20261022,mask_mode:"replace",feather_pct:.5,context_pixels:32})).id;await save();}
  const edited=await wait(receipt.editRun);
  const final=await request("GET",`${base}/assets/${edited.output_ids[0]}`);
  const record=final.metadata?.preservation;
  if(!record||record.sourceAssetId!==receipt.sourceAsset||!edited.output_ids.includes(record.candidateAssetId)||!edited.output_ids.includes(record.effectiveMaskAssetId))throw new Error("Incomplete preservation artifact receipt");
  for(const [label,id] of [["final",record.finalAssetId],["candidate",record.candidateAssetId],["effective-mask",record.effectiveMaskAssetId]])await writeFile(path.join(root,`${which}-${label}.png`),await request("GET",`${base}/assets/${id}/content`,undefined,true));
  await writeFile(path.join(root,which+"-drift.png"),await request("GET",`${base}/runs/${edited.id}/preservation/drift`,undefined,true));
  const provenance=await request("GET",`${base}/runs/${edited.id}/provenance`);await writeFile(path.join(root,which+"-provenance.json"),JSON.stringify(provenance,null,2)+"\n");
  const workflow=await request("GET",`${base}/runs/${edited.id}/workflow`);await writeFile(path.join(root,which+"-workflow.json"),JSON.stringify(workflow,null,2)+"\n");
  receipt.preservation=record;receipt.completedAt=new Date().toISOString();await save();
  console.log(JSON.stringify({fixture:which,runId:edited.id,sourceRun:source.id,artifacts:edited.output_ids,qa:record.qa,output:root}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
