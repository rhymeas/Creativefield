// Native prompt validation, without queueing. COMFY_ROOT and COMFY_PYTHON must
// point to the same ComfyUI installation and its Python environment.
// Optional: COMFY_INPUT_DIR points to test media; COMFY_FIXTURES is a JSON
// object mapping port IDs or media types to existing comfyfield-* filenames.
// COMFY_EXPECTED_REVISION checks a clean tracked ComfyUI checkout at that commit.
// COMFY_EXPECTED_NODES maps folders to Git commits or tree-sha256:<digest>, and .py files to sha256:<digest>.
// COMFY_STRICT_NODES=1 also rejects enabled custom nodes absent from that map.
// COMFY_MODELS_DIRS optionally supplies a JSON array of additional model roots.
// COMFY_PARTNER_SCHEMAS optionally names local partner-schema modules to load.
// COMFY_AUTO_FIXTURES=1 creates or reuses synthetic inputs in COMFY_INPUT_DIR.
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync,readFileSync,readdirSync,statSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {loadServerCatalogue} from "../server/catalogue";
import {compileLocal} from "../src/capabilities/compile";
import {nativeValidationExit,nativeValidationReasons,nativeValidationStatus} from "../src/workflow/native-validation-report";
import {nativeFixtureVariants} from "../src/workflow/native-fixtures";
import {nativeFixtureFor} from "../src/workflow/native-fixtures";
import {compileAnchorStill} from "../src/capabilities/anchor-still";
import {missingNativeTemplates,nativeTemplateIssues} from "../src/workflow/native-coverage";
import {nativePartnerSchemas} from "../src/workflow/native-partner-schemas";
import {nativeNodeTreeHash} from "../src/workflow/native-node-tree";
import {probeFixtureVideo as probeVideoFixture} from "../src/workflow/native-fixture-probe";
import {compileWanAnimateMotion,planWanAnimateFrames} from "../src/capabilities/motion";
import {scailChunksEnabled} from "../server/config";

const root=process.env.COMFY_ROOT, python=process.env.COMFY_PYTHON;
if(!root||!python){console.error("Set COMFY_ROOT and COMFY_PYTHON to a local ComfyUI installation.");process.exit(2);}
const expectedRevision=process.env.COMFY_EXPECTED_REVISION;
if(expectedRevision){
  if(!/^[a-f0-9]{40}$/i.test(expectedRevision)){console.error("COMFY_EXPECTED_REVISION must be a full Git commit hash.");process.exit(2);}
  const revision=spawnSync("git",["-C",root,"rev-parse","HEAD"],{encoding:"utf8"});
  const changes=spawnSync("git",["-C",root,"status","--porcelain","--untracked-files=normal"],{encoding:"utf8"});
  if(revision.status!==0||changes.status!==0||revision.stdout.trim().toLowerCase()!==expectedRevision.toLowerCase()||changes.stdout.trim()){
    console.error("ComfyUI revision does not match the expected clean commit.");process.exit(2);
  }
  console.log(`ComfyUI revision ${revision.stdout.trim()} (working tree clean; ignored files excluded)`);
}
if(process.env.COMFY_STRICT_NODES==="1"&&!process.env.COMFY_EXPECTED_NODES){console.error("COMFY_STRICT_NODES requires COMFY_EXPECTED_NODES.");process.exit(2);}
if(process.env.COMFY_EXPECTED_NODES){
  let expectedNodes:Record<string,string>;
  try{
    expectedNodes=JSON.parse(process.env.COMFY_EXPECTED_NODES);
    if(!expectedNodes||typeof expectedNodes!=="object"||Array.isArray(expectedNodes))throw new Error("expected an object");
    for(const [name,hash] of Object.entries(expectedNodes)){
      if(!/^[a-zA-Z0-9_.-]+$/.test(name)||name==="."||name===".."||typeof hash!=="string")throw new Error(`invalid node name or pin: ${name}`);
      const directory=join(process.env.COMFY_BASE_DIR??root,"custom_nodes",name);
      if(/^tree-sha256:[a-f0-9]{64}$/i.test(hash)){
        if(!existsSync(directory)||!statSync(directory).isDirectory())throw new Error(`node ${name} must be an existing directory`);
        const actual=nativeNodeTreeHash(directory);
        if(actual!==hash.slice(12).toLowerCase())throw new Error(`node ${name} does not match the expected tree SHA-256`);
        console.log(`Node ${name} tree SHA-256 ${actual} (Python caches excluded)`);
        continue;
      }
      if(/^sha256:[a-f0-9]{64}$/i.test(hash)){
        if(!name.endsWith(".py")||!existsSync(directory)||!statSync(directory).isFile())throw new Error(`node ${name} must be an existing .py file`);
        const actual=createHash("sha256").update(readFileSync(directory)).digest("hex");
        if(actual!==hash.slice(7).toLowerCase())throw new Error(`node ${name} does not match the expected SHA-256`);
        console.log(`Node ${name} SHA-256 ${actual}`);
        continue;
      }
      if(!/^[a-f0-9]{40}$/i.test(hash))throw new Error(`invalid node commit: ${name}`);
      // Without this check git -C would search upward and report ComfyUI's
      // revision for an unversioned copied node directory.
      if(!existsSync(join(directory,".git")))throw new Error(`node ${name} has no independent Git checkout`);
      const revision=spawnSync("git",["-C",directory,"rev-parse","HEAD"],{encoding:"utf8"});
      const changes=spawnSync("git",["-C",directory,"status","--porcelain","--untracked-files=normal"],{encoding:"utf8"});
      if(revision.status!==0||changes.status!==0||revision.stdout.trim().toLowerCase()!==hash.toLowerCase()||changes.stdout.trim())throw new Error(`node ${name} does not match the expected clean commit`);
      console.log(`Node ${name} revision ${revision.stdout.trim()} (working tree clean; ignored files excluded)`);
    }
    if(process.env.COMFY_STRICT_NODES==="1"){
      if(process.env.COMFY_CORE_ONLY==="1")throw new Error("strict custom-node checks cannot run in core-only mode");
      const directory=join(process.env.COMFY_BASE_DIR??root,"custom_nodes");
      const enabled=readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.name!=="__pycache__"&&!entry.name.endsWith(".disabled")&&(entry.isDirectory()||entry.isSymbolicLink()||entry.name.endsWith(".py"))).map(entry=>entry.name);
      const unlisted=enabled.filter(name=>!Object.hasOwn(expectedNodes,name));
      if(unlisted.length)throw new Error(`unlisted enabled custom nodes: ${unlisted.sort().join(", ")}`);
    }
  }catch(error){console.error(`Invalid COMFY_EXPECTED_NODES: ${(error as Error).message}`);process.exit(2);}
}
const filter=process.env.COMFY_VALIDATE_FILTER;
let partnerSchemas:string[]=[];
try{
  if(process.env.COMFY_PARTNER_SCHEMAS){
    const parsed:unknown=JSON.parse(process.env.COMFY_PARTNER_SCHEMAS);
    if(!Array.isArray(parsed)||parsed.some(value=>typeof value!=="string"||!/^nodes_[a-z0-9_]+\.py$/.test(value)))throw new Error("expected an array of nodes_*.py module names");
    partnerSchemas=[...new Set(parsed)];
  }
}catch(error){console.error(`Invalid COMFY_PARTNER_SCHEMAS: ${(error as Error).message}`);process.exit(2);}
let modelDirectories:string[]=[];
try{
  if(process.env.COMFY_MODELS_DIRS){
    const parsed:unknown=JSON.parse(process.env.COMFY_MODELS_DIRS);
    if(!Array.isArray(parsed)||parsed.some(value=>typeof value!=="string"||!value.trim()))throw new Error("expected an array of directory paths");
    modelDirectories=parsed;
  }
  if(process.env.COMFY_MODELS_DIR)modelDirectories.unshift(process.env.COMFY_MODELS_DIR);
  modelDirectories=[...new Set(modelDirectories)];
}catch(error){console.error(`Invalid COMFY_MODELS_DIRS: ${(error as Error).message}`);process.exit(2);}
const inputDirectory=process.env.COMFY_INPUT_DIR;
let fixtures:Record<string,string>={};
try{
  if(process.env.COMFY_FIXTURES)fixtures=JSON.parse(process.env.COMFY_FIXTURES);
  if(!fixtures||typeof fixtures!=="object"||Array.isArray(fixtures))throw new Error("expected an object");
  if(process.env.COMFY_AUTO_FIXTURES==="1"){
    if(!inputDirectory)throw new Error("COMFY_INPUT_DIR is required for automatic fixtures");
    const generated={image:"comfyfield-fixture-image.png",mask:"comfyfield-fixture-mask.png",audio:"comfyfield-fixture-audio.wav",video:"comfyfield-fixture-video.mp4"};
    const present=Object.values(generated).filter(name=>existsSync(join(inputDirectory,name))).length;
    if(present!==0&&present!==Object.keys(generated).length)throw new Error("automatic fixture set is incomplete; choose an empty input directory");
    if(!present){
      const generator=fileURLToPath(new URL("./make-validation-fixtures.py",import.meta.url));
      const result=spawnSync(python,[generator,"--directory",inputDirectory],{encoding:"utf8",timeout:90_000});
      if(result.status!==0)throw new Error(`fixture generation failed: ${result.error?.message??(result.stderr?.trim()||`exit ${result.status}`)}`);
    }
    fixtures={...generated,...fixtures};
  }
  for(const name of Object.values(fixtures)){
    if(typeof name!=="string"||!/^comfyfield-[a-zA-Z0-9_.-]+$/.test(name)||!inputDirectory||!existsSync(join(inputDirectory,name)))throw new Error("fixture names must be existing comfyfield-* files in COMFY_INPUT_DIR");
  }
}catch(error){console.error(`Invalid COMFY_FIXTURES: ${(error as Error).message}`);process.exit(2);}
const graphs:Array<{id:string;prompt:unknown}>=[], skipped:Array<{id:string;reason:string}>=[];
function probeFixtureVideo(filename:string):{frames:number;fps:number}{
  if(!inputDirectory)throw new Error("video fixture directory is required");
  return probeVideoFixture(inputDirectory,filename);
}
// Check the actual native template folders as well as the catalogue. A pack
// omitted from the catalogue must be reported, not silently counted as covered.
const nativeDirectory=fileURLToPath(new URL("../native-workflows/",import.meta.url));
const nativeRecords=readdirSync(nativeDirectory,{withFileTypes:true}).filter(entry=>entry.isDirectory()).flatMap(entry=>{
  const folder=join(nativeDirectory,entry.name),manifestFile=join(folder,"manifest.json");
  if(!existsSync(join(folder,"template.api.json")))return [];
  if(!existsSync(manifestFile))return [{folder:entry.name,error:"native template is missing manifest.json"}];
  try{
    const manifest=JSON.parse(readFileSync(manifestFile,"utf8")) as {id?:unknown}|null;
    return [{folder:entry.name,id:manifest?.id}];
  }catch{return [{folder:entry.name,error:"native template manifest cannot be read or parsed"}];}
});
skipped.push(...nativeTemplateIssues(nativeRecords,filter));
const nativeIds=nativeRecords.flatMap(record=>typeof record.id==="string"&&record.id.trim()?[record.id]:[]);
let bundles:Awaited<ReturnType<typeof loadServerCatalogue>>;
try{bundles=await loadServerCatalogue({log:()=>undefined,onInvalidNative:(id,reason)=>skipped.push({id,reason})});}
catch(error){
  for(const item of skipped)console.error(`partial ${item.id}: ${item.reason}`);
  console.error(`Cannot load workflow catalogue: ${(error as Error).message}`);
  process.exit(2);
}
const catalogueIds=new Set(bundles.filter(bundle=>bundle.template).map(bundle=>bundle.manifest.id));
for(const id of missingNativeTemplates(nativeIds,catalogueIds,filter))skipped.push({id,reason:"native template not present in loaded catalogue"});
for(const bundle of bundles){
  const {manifest,template}=bundle;
  if(!template||(filter&&manifest.id!==filter))continue;
  const route=manifest.routes.find(r=>r.execution==="local_comfy"&&r.implementation==="implemented")??manifest.routes.find(r=>r.execution==="local_comfy"&&r.implementation==="experimental")??manifest.routes.find(r=>r.execution==="comfy_cloud"&&(r.implementation==="implemented"||r.implementation==="experimental"));
  if(!route){skipped.push({id:manifest.id,reason:"no implemented or experimental ComfyUI route"});continue;}
  let variants:ReturnType<typeof nativeFixtureVariants>;
  try{variants=nativeFixtureVariants(fixtures,manifest.id,manifest.inputs);}
  catch(error){skipped.push({id:manifest.id,reason:`cannot plan input variants: ${(error as Error).message}`});continue;}
  if(manifest.id==="replace-anchor-still"){
    const video=manifest.inputs.find(port=>port.id==="source_video");
    const fixture=video&&nativeFixtureFor(fixtures,manifest.id,video);
    if(fixture)variants[0].inputs.source_video=fixture;
  }
  if(manifest.inputs.some(p=>p.required&&!variants[0].inputs[p.id])){skipped.push({id:manifest.id,reason:"requires fixture input media"});continue;}
  for(const {id,inputs} of variants){
  try{
    const invocation={capabilityId:manifest.id,version:manifest.version,routeId:route.id,inputs,controls:{},audioPolicy:manifest.audioPolicies[0]??"mute" as const};
    let graph=manifest.id==="replace-anchor-still"?compileAnchorStill(bundle,invocation):compileLocal(bundle,invocation,{allowExperimental:route.implementation==="experimental"});
    if(route.execution==="comfy_cloud")console.log(`info ${manifest.id}: checking cloud-route graph against local node definitions only`);
    if(manifest.motionContract){
      const filename=inputs[manifest.motionContract.motionInput];
      if(!filename||!inputDirectory)throw new Error("motion video fixture is required");
      const {frames,fps}=probeFixtureVideo(filename);
      if(fps!==manifest.motionContract.fps)throw new Error(`motion fixture must have a readable frame count at ${manifest.motionContract.fps} fps`);
      graph=compileWanAnimateMotion(graph,planWanAnimateFrames(frames));
    }
    if(manifest.replaceContract){
      if(route.implementation==="experimental")throw new Error("experimental replace runtime compiler is not supported by this check");
      const filename=inputs[manifest.replaceContract.sourceInput];
      if(!filename)throw new Error("replace video fixture is required");
      const {frames}=probeFixtureVideo(filename);
      const {compileRunGraph}=await import("../server/execution");
      graph=compileRunGraph(bundle,invocation,inputs,frames);
      const mode=manifest.replaceContract.kind==="scail_replace_chunks_v1"?`SCAIL chunking ${scailChunksEnabled()?"enabled":"disabled"}`:"Jutsu relay";
      console.log(`info ${manifest.id}: ${frames} fixture frames; ${mode}`);
    }
    if(route.execution==="comfy_cloud")partnerSchemas=[...new Set([...partnerSchemas,...nativePartnerSchemas(graph)])];
    graphs.push({id,prompt:graph});
  }catch(error){skipped.push({id,reason:`cannot compile inputs: ${(error as Error).message}`});}
  }
}
for(const item of skipped)console.log(`partial ${item.id}: ${item.reason}`);
if(!graphs.length){console.error("No eligible workflows to validate.");process.exit(2);}
const script=fileURLToPath(new URL("./comfy-validate-prompt.py",import.meta.url));
const args=[script,"--comfy-root",root,...(process.env.COMFY_BASE_DIR?["--base-directory",process.env.COMFY_BASE_DIR]:[]),...modelDirectories.flatMap(directory=>["--models-directory",directory]),...partnerSchemas.flatMap(name=>["--partner-schema",name]),...(inputDirectory?["--input-directory",inputDirectory]:[]),...(process.env.COMFY_CORE_ONLY==="1"?["--no-custom-nodes"]:[])];
const result=spawnSync(python,args,{input:JSON.stringify(graphs),encoding:"utf8",timeout:120_000,maxBuffer:10*1024*1024});
if(result.stderr)process.stderr.write(result.stderr);
if(result.error||!result.stdout){console.error(`ComfyUI validator failed: ${result.error?.message??`exit ${result.status}`}`);process.exit(2);}
let report:{node_import_failures:string[];results:Array<{id:string;valid:boolean;error?:{message?:string;details?:string};node_errors?:unknown}>};
try{report=JSON.parse(result.stdout);}catch{console.error("Invalid response from ComfyUI validator.");process.exit(2);}
if(!report||!Array.isArray(report.node_import_failures)){console.error("Missing node initialization report.");process.exit(2);}
const entries=report.results;
if(!Array.isArray(entries)||entries.length!==graphs.length||entries.some((entry,index)=>entry.id!==graphs[index].id||typeof entry.valid!=="boolean")){
  console.error("Incomplete response from ComfyUI validator.");process.exit(2);
}
for(const entry of entries){
  console.log(`${nativeValidationStatus(entry.valid,entry.node_errors)} ${entry.id}${entry.error?`: ${entry.error.message??"validation failed"} ${entry.error.details??""}`:""}`);
  for(const reason of nativeValidationReasons(entry.node_errors))console.log(`  ${reason}`);
}
for(const failure of report.node_import_failures)console.error(`Node import failed: ${failure}`);
const exit=nativeValidationExit({statuses:entries.map(entry=>nativeValidationStatus(entry.valid,entry.node_errors)),skipped:skipped.length,nodeImportFailures:report.node_import_failures.length,filtered:!!filter,coreOnly:process.env.COMFY_CORE_ONLY==="1",revisionPinned:!!expectedRevision,strictNodes:process.env.COMFY_STRICT_NODES==="1",validatorExit:result.status});
if(exit===2)console.error("Partial check: full coverage or pinned initialization has not been verified.");
process.exit(exit);
