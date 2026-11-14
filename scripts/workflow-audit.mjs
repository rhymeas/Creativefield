#!/usr/bin/env node
import {access,readdir,readFile} from "node:fs/promises";
import {basename,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import process from "node:process";

/*
  One command that lists every workflow pack and whether this host can run it.
  Read only: it reads the manifests and asks ComfyUI which nodes and model files
  it has (GET /object_info, GET /models). It fails only when the packs themselves
  are wrong - two packs share an id, or a folder name no longer matches its
  manifest id. When ComfyUI is down readiness is printed as unknown and the exit
  code stays 0, because a stopped server is not a broken pack.
*/

const TIMEOUT_MS=8000;

/*
  Some folders are older than the name their screen and saved drafts use, so the
  folder keeps the old name. Anything else that disagrees with its folder fails.
*/
export const renamedFolders={
  "native-workflows/instantid-sdxl-character":"elements",
  "native-workflows/video-edit-extend-vace":"video-edit",
  "native-workflows/wan21-infinitetalk":"lip-sync",
  "native-workflows/wan22-fun-camera":"camera",
  "pipelines/t2v/wan22-ti2v-5b":"wan22-ti2v-5b-t2v"
};

const exists=async path=>access(path).then(()=>true,()=>false);
const folders=async path=>(await readdir(path,{withFileTypes:true}).then(entries=>entries,()=>[]))
  .filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();

/*
  The six packs under pipelines/ use the older manifest shape: no version and no
  routes. The server turns each into a local capability with version 1.0.0 and
  one requirement per node class in its template plus the models it declares
  (src/capabilities/legacy.ts), so this reads them the same way.
*/
function asCapability(manifest,folder,template){
  if(Array.isArray(manifest.routes))return manifest;
  const nodes=[...new Set(Object.values(template??{}).map(node=>node?.class_type).filter(name=>typeof name==="string"))];
  return {
    ...manifest,version:"1.0.0",category:folder.split("/")[1],outputs:[{type:"video"}],
    routes:[{
      id:"local",execution:"local_comfy",implementation:"implemented",
      requirements:[
        ...nodes.map(name=>({kind:"node",name})),
        ...(manifest.requires?.models??[]).map(model=>({kind:"model",name:model.file,location:model.folder}))
      ]
    }]
  };
}

/** Reads every pack: native-workflows/<pack> and pipelines/<pipeline>/<pack>. */
export async function loadPacks(root){
  const packs=[],skipped=[];
  const add=async folder=>{
    const url=join(root,folder,"manifest.json");
    if(!await exists(url)){skipped.push(folder);return;}
    const manifest=JSON.parse(await readFile(url,"utf8"));
    const hasTemplate=await exists(join(root,folder,"template.api.json"));
    const template=hasTemplate?JSON.parse(await readFile(join(root,folder,"template.api.json"),"utf8")):null;
    packs.push({folder,manifest,hasTemplate,capability:asCapability(manifest,folder,template)});
  };
  for(const name of await folders(join(root,"native-workflows")))await add(`native-workflows/${name}`);
  for(const pipeline of await folders(join(root,"pipelines"))){
    for(const name of await folders(join(root,"pipelines",pipeline)))await add(`pipelines/${pipeline}/${name}`);
  }
  packs.sort((a,b)=>a.folder.localeCompare(b.folder));
  return {packs,skipped};
}

/** Every reason a pack cannot be trusted: missing files, id versus folder, repeated ids. */
export function checkPacks(packs,renamed=renamedFolders){
  const problems=[],owners=new Map();
  for(const {folder,manifest,capability,hasTemplate} of packs){
    const id=capability?.id;
    if(typeof id!=="string"||!id){problems.push(`${folder}: manifest has no id`);continue;}
    if(typeof capability.version!=="string"||!capability.version)problems.push(`${folder}: manifest has no version`);
    if(!hasTemplate)problems.push(`${folder}: no template.api.json`);
    const name=basename(folder);
    if(id!==name&&renamed[folder]!==id)problems.push(`${folder}: id "${id}" does not match the folder name`);
    owners.set(id,[...(owners.get(id)??[]),folder]);
  }
  for(const [id,where] of owners){
    if(where.length>1)problems.push(`id "${id}" is used by ${where.join(" and ")}`);
  }
  return problems;
}

/** The local route a run would use: the implemented one, else the best local one. */
export function localRoute(manifest){
  const routes=manifest?.routes??[];
  return routes.find(route=>route.execution==="local_comfy"&&route.implementation==="implemented")
    ??routes.find(route=>route.execution==="local_comfy")??null;
}

/** Where in the app a pack can be reached, or "-" when no screen runs it. */
export function screenFor(manifest){
  const route=localRoute(manifest);
  if(route?.implementation!=="implemented")return "-";
  const types=Array.isArray(manifest.outputs)?manifest.outputs.map(output=>output.type):[];
  if(manifest.category==="motion"||manifest.modes?.includes("motion_control"))return "#motion";
  if(manifest.category==="audio"||types.includes("audio")||manifest.voiceContract)return "#audio";
  if(manifest.imageInputContract)return "#imageedit";
  if(manifest.mediaContract||manifest.outputContract)return "#video";
  if(manifest.category==="3d"||types.includes("model3d"))return "#3d";
  if(types.includes("video"))return "#video";
  if(types.includes("image"))return manifest.category==="canvas"?"#imageedit":"#image";
  return "-";
}

/** How a run reaches the model: the local ComfyUI or nothing. */
export function transportFor(manifest){
  const route=localRoute(manifest);
  if(route)return route.implementation==="implemented"?"local":`local (${route.implementation})`;
  const implemented=manifest?.routes?.find(item=>item.implementation==="implemented");
  return implemented?.execution??"none";
}

async function json(url){
  const response=await fetch(url,{signal:AbortSignal.timeout(TIMEOUT_MS),redirect:"error"});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Nodes and model folder names from one ComfyUI server. Offline leaves it empty. */
export async function probeComfy(base){
  const inventory={online:false,nodes:new Set(),folders:null,files:new Map()};
  try{
    const info=await json(`${base}/object_info`);
    if(!info||typeof info!=="object"||Array.isArray(info))return inventory;
    inventory.nodes=new Set(Object.keys(info));
    inventory.online=true;
  }catch{return inventory;}
  try{
    const listed=await json(`${base}/models`);
    if(Array.isArray(listed))inventory.folders=new Set(listed.filter(item=>typeof item==="string"));
  }catch{/* object_info answered, model folders did not: a needed folder stays unknown. */}
  return inventory;
}

/** File names in one ComfyUI model folder, cached. null means it could not be read. */
async function folderFiles(base,inventory,folder){
  if(!folder||!inventory.online||!inventory.folders)return null;
  if(inventory.files.has(folder))return inventory.files.get(folder);
  let files=null;
  try{
    if(!inventory.folders.has(folder))files=new Set();
    else{
      const listed=await json(`${base}/models/${encodeURIComponent(folder)}`);
      files=Array.isArray(listed)?new Set(listed.filter(item=>typeof item==="string")):null;
    }
  }catch{files=null;}
  inventory.files.set(folder,files);
  return files;
}

/** Yes, no with what is missing, unknown when a check could not run, n/a without a local route. */
export async function readiness(manifest,inventory,listFiles){
  const route=localRoute(manifest);
  if(!route)return {state:"n/a",detail:"no local route"};
  if(!inventory.online)return {state:"unknown",detail:"ComfyUI is down"};
  const missing=[];
  let unread=null;
  for(const need of route.requirements??[]){
    if(need.kind==="node"){
      if(!inventory.nodes.has(need.name))missing.push(`node ${need.name}`);
    }else if(need.kind==="model"){
      const files=await listFiles(need.location);
      if(files===null)unread=need.location??need.name;
      else if(!files.has(need.name))missing.push(`model ${need.location??""}/${need.name}`);
    }else if(need.kind){
      missing.push(`${need.kind} ${need.name}`);
    }
  }
  if(missing.length)return {state:"no",detail:missing.join(", ")};
  if(unread)return {state:"unknown",detail:`folder ${unread} could not be read`};
  return {state:"yes",detail:""};
}

const pad=(text,width)=>String(text).padEnd(width);

async function main(){
  const root=fileURLToPath(new URL("..",import.meta.url));
  const base=(process.env.COMFY_URL??"http://127.0.0.1:8188").replace(/\/$/,"");
  let loaded;
  try{loaded=await loadPacks(root);}
  catch(error){console.log(`cannot read the workflow packs: ${error instanceof Error?error.message:error}`);process.exit(1);}
  const {packs,skipped}=loaded;
  const problems=checkPacks(packs);
  const inventory=await probeComfy(base);
  const rows=[];
  for(const {folder,capability} of packs){
    const ready=await readiness(capability,inventory,name=>folderFiles(base,inventory,name));
    rows.push({
      id:capability.id??"-",folder,version:capability.version??"-",
      transport:transportFor(capability),screen:screenFor(capability),
      ready:ready.detail?`${ready.state}: ${ready.detail}`:ready.state
    });
  }
  const width=key=>Math.max(2,...rows.map(row=>String(row[key]).length),key.length);
  const columns=["id","folder","version","transport","screen","ready"];
  console.log(`workflow packs in ${root}\n`);
  console.log(columns.map(key=>pad(key,width(key))).join("  ").trimEnd());
  for(const row of rows)console.log(columns.map(key=>pad(row[key],width(key))).join("  ").trimEnd());
  const count=state=>rows.filter(row=>row.ready.startsWith(state)).length;
  console.log(`\n${rows.length} packs: ${count("yes")} ready, ${count("no")} not ready, ${count("unknown")} unknown, ${count("n/a")} without a local route`);
  console.log(inventory.online?`ComfyUI at ${base}`:`ComfyUI at ${base} is not reachable, so readiness is unknown`);
  if(skipped.length)console.log(`skipped (no manifest.json): ${skipped.join(", ")}`);
  const renamed=Object.entries(renamedFolders).filter(([folder,id])=>packs.some(pack=>pack.folder===folder&&pack.capability.id===id));
  if(renamed.length)console.log(`older folder names: ${renamed.map(([folder,id])=>`${folder} is ${id}`).join(", ")}`);
  if(problems.length){
    console.log(`\n${problems.length} problems:`);
    for(const problem of problems)console.log(`  ${problem}`);
    console.log("\nFix the pack ids or folders, then run this again.");
    process.exit(1);
  }
  console.log("\nEvery pack has one id, one folder and its template.");
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
