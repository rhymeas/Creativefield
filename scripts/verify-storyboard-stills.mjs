// Read-only verification of an explicitly selected real storyboard render.
// No generation, model downloads, paid routes or retries are started here.
import {mkdir,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";

const execute=promisify(execFile),uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
async function main(){
  const workspace=process.env.COMFYFIELD_WORKSPACE_ID,renderId=process.env.COMFYFIELD_RENDER_ID;
  if(!uuid.test(workspace??"")||!uuid.test(renderId??""))throw new Error("Specify existing COMFYFIELD_WORKSPACE_ID and COMFYFIELD_RENDER_ID");
  const origin=process.env.COMFYFIELD_URL??"http://127.0.0.1:8787";
  if(!["127.0.0.1","localhost","[::1]"].includes(new URL(origin).hostname))throw new Error("Use an explicit loopback app");
  if(!process.env.COMFYFIELD_QA_OUTPUT)throw new Error("Set COMFYFIELD_QA_OUTPUT to an evidence directory");
  const output=path.resolve(process.env.COMFYFIELD_QA_OUTPUT,renderId);
  let cookie="";
  async function get(tail,binary=false){
    const r=await fetch(origin+"/api/v1"+tail,{headers:{Origin:origin,...(cookie?{cookie}:{})},signal:AbortSignal.timeout(30000)});
    const session=r.headers.getSetCookie?.().find(v=>v.startsWith("cf_session="));if(session)cookie=session.split(";")[0];
    if(!r.ok)throw new Error(`GET ${tail}: ${r.status}`);
    return binary?Buffer.from(await r.arrayBuffer()):r.json();
  }
  await get("/auth/me");const base=`/workspaces/${workspace}`;
  const render=await get(base+`/storyboard-renders/${renderId}`);
  if(render.state!=="succeeded"||!render.output_asset_id)throw new Error(`Existing render is ${render.state}: ${render.error??"not complete"}. Inspect it; do not resubmit.`);
  const receipts=[];
  for(const shot of render.shots){
    const approved=shot.snapshot.approvedStill;
    if(!approved||shot.state!=="succeeded"||shot.invocation.inputs.start_image!==approved.assetId)throw new Error(`Shot ${shot.ordinal+1} is not bound to its approved still`);
    const video=await get(base+`/runs/${shot.child_run_id}/provenance`),still=await get(base+`/runs/${approved.producerRunId}/provenance`),run=await get(base+`/runs/${approved.producerRunId}`);
    if(!video.inputs.some(i=>i.role==="start_image"&&i.id===approved.assetId)||!still.outputs.some(a=>a.id===approved.assetId&&a.media_type==="image")||![video,still].every(r=>/^[a-f\d]{64}$/.test(r.workflowHash??"")))throw new Error(`Shot ${shot.ordinal+1} provenance is incomplete`);
    receipts.push({ordinal:shot.ordinal,approval:approved,stillRun:run.id,stillTransport:run.transport,video,still});
  }
  const asset=await get(base+`/assets/${render.output_asset_id}`),bytes=await get(base+`/assets/${render.output_asset_id}/content`,true),sha256=createHash("sha256").update(bytes).digest("hex");
  if(asset.project_id!==render.project_id||asset.sha256!==sha256)throw new Error("Final download does not match the published asset");
  await mkdir(output,{recursive:true});const filename=path.join(output,"storyboard.mp4");await writeFile(filename,bytes);
  const probe=JSON.parse((await execute(process.env.FFPROBE_PATH??"ffprobe",["-v","error","-count_frames","-show_entries","stream=width,height,r_frame_rate,nb_read_frames","-show_entries","format=duration","-of","json",filename],{windowsHide:true,timeout:30000,maxBuffer:1048576})).stdout);
  const v=probe.streams[0],frames=render.shots.reduce((n,s)=>n+s.snapshot.frames,0),[num,den]=v.r_frame_rate.split("/").map(Number);
  if(v.width!==render.assembly.width||v.height!==render.assembly.height||Number(v.nb_read_frames)!==frames||num/den!==render.assembly.fps||Math.abs(Number(probe.format.duration)-frames/render.assembly.fps)>.01)throw new Error("Decoded export does not match the frozen assembly timing");
  const result={render,receipts,download:{bytes:bytes.length,sha256},probe};await writeFile(path.join(output,"verification.json"),JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify({renderId,shots:receipts.length,stillTransports:receipts.map(r=>r.stillTransport),frames,bytes:bytes.length,sha256,output}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
