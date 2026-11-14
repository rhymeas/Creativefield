import {readFile,writeFile,mkdir} from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {assertLocalGraphPolicy} from "../src/capabilities/policy.ts";
import {SCENE_VIDEO_PROBE_ID,SCENE_VIDEO_PROBE_VERSION,VIDEO_PROBE_INDICES} from "../src/capabilities/replace-video-probe.ts";
import type {ApiGraph} from "../src/workflow/build.ts";

// Export an offline comparison from a real saved run. No worker/network/model calls.
const [receiptFile,destination]=process.argv.slice(2);
if(!receiptFile||!destination)throw new Error("Usage: node --import tsx scripts/scene-probe-mode-comparison.mts <run-receipt.json> <new-directory>");
const receipt=JSON.parse(await readFile(receiptFile,"utf8")),base=receipt.graph as ApiGraph;
if(receipt.invocation?.capabilityId!==SCENE_VIDEO_PROBE_ID||!receipt.invocation.sceneReference?.sha256)throw new Error("A frozen scene-probe run receipt is required");
if(base["213:203"]?.class_type!=="PrimitiveBoolean"||base["213:203"].inputs.value!==true)throw new Error("The baseline must be a Replacement Mode run");
for(const id of ["213:114","213:197","213:199"])if(JSON.stringify(base[id]?.inputs.replacement_mode)!==JSON.stringify(["213:203",0]))throw new Error("Mixed mode wiring is not a valid control");
if(base["213:114"].inputs.length!==5||VIDEO_PROBE_INDICES.some(i=>base[`probe:save:${i}`]?.class_type!=="SaveImage"))throw new Error("The bounded video-frame contract changed");
assertLocalGraphPolicy(base);
const candidate=structuredClone(base);candidate["213:203"].inputs.value=false;assertLocalGraphPolicy(candidate);
const changed=Object.keys(base).filter(id=>JSON.stringify(base[id])!==JSON.stringify(candidate[id]));
if(JSON.stringify(changed)!==JSON.stringify(["213:203"]))throw new Error("More than the one mode setting changed");
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex"),dir=path.resolve(destination);
await mkdir(dir,{recursive:true});
await writeFile(path.join(dir,"baseline.api.json"),JSON.stringify(base,null,2)+"\n",{flag:"wx"});
await writeFile(path.join(dir,"candidate.api.json"),JSON.stringify(candidate,null,2)+"\n",{flag:"wx"});
const proof={baselineRunId:receipt.runId,sceneReference:receipt.invocation.sceneReference,sourceVideoId:receipt.invocation.inputs.source_video,baselineGraphSha256:hash(base),candidateGraphSha256:hash(candidate),changedPaths:["213:203.inputs.value"],from:true,to:false,consumers:["213:114","213:197","213:199"],proposedInvocation:{...receipt.invocation,version:SCENE_VIDEO_PROBE_VERSION,controls:{...receipt.invocation.controls,replacement_mode:false}},status:"prepared, not rendered; exported file names belong to the old run; use normal asset admission for a new run"};
await writeFile(path.join(dir,"comparison.json"),JSON.stringify(proof,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({directory:dir,baselineRunId:proof.baselineRunId,changedPaths:proof.changedPaths,sceneSha256:proof.sceneReference.sha256,status:proof.status}));
