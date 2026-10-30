#!/usr/bin/env node
import {existsSync,readFileSync,readdirSync} from "node:fs";
import {join,resolve} from "node:path";
import process from "node:process";
import {Client} from "pg";

/*
  Clean-machine preflight. It never prints secret values: app.env is only
  inspected for which keys exist. Required repository/installation checks stop
  with exit 1; optional local services only warn, because a fresh checkout is
  allowed to run this before ComfyUI or the app is started.
*/

const root=process.cwd();
const home=resolve(process.env.COMFYFIELD_HOME??join(root,".comfyfield"));
const envFile=join(home,"app.env");
const checks=[];

function add(status,label,detail=""){checks.push({status,label,detail});}
function pass(label,detail){add("PASS",label,detail);}
function warn(label,detail){add("WARN",label,detail);}
function fail(label,detail){add("FAIL",label,detail);}
function has(file){return existsSync(join(root,file));}
function readAppEnv(){
  if(!existsSync(envFile))return {};
  const values={};
  for(const line of readFileSync(envFile,"utf8").split(/\r?\n/)){
    const match=line.match(/^([A-Z0-9_]+)=(.*)$/);
    if(match)values[match[1]]=match[2].trim();
  }
  return values;
}
async function reachable(url,milliseconds=3000){
  try{
    const response=await fetch(url,{signal:AbortSignal.timeout(milliseconds)});
    return response.ok;
  }catch{return false;}
}

const appEnv=readAppEnv();
const configured=Object.keys(appEnv).sort();
const modelRoot=appEnv.COMFYFIELD_MODEL_ROOT;
const storageRoot=appEnv.STORAGE_ROOT;
const appUrl=(appEnv.PUBLIC_ORIGIN??process.env.PUBLIC_ORIGIN??"http://127.0.0.1:8787").replace(/\/$/,"");
const comfyUrl=(process.env.COMFY_URL??"http://127.0.0.1:8188").replace(/\/$/,"");

const major=Number(process.versions.node.split(".")[0]);
if(major>=22)pass("Node.js",`${process.versions.node} (requires 22+)`);
else fail("Node.js",`${process.versions.node}; install Node.js 22 or newer`);

let pkg={};
try{pkg=JSON.parse(readFileSync(join(root,"package.json"),"utf8"));}catch{}
if(pkg.license==="GPL-3.0-only")pass("Repository license","GPL-3.0-only");
else fail("Repository license",`expected GPL-3.0-only, found ${pkg.license??"none"}`);

for(const file of ["LICENSE","README.md","package-lock.json","docs/LICENSE-INVENTORY.md","docs/INSTALL-BACKUP-RECOVERY.md"]){
  if(has(file))pass(`File ${file}`);
  else fail(`File ${file}`,"missing");
}

if(has("node_modules/pg/package.json"))pass("Dependencies","node_modules and pg installed");
else fail("Dependencies","run npm install (node_modules/pg missing)");

const inventory=has("docs/LICENSE-INVENTORY.md")?readFileSync(join(root,"docs/LICENSE-INVENTORY.md"),"utf8"):"";
const workflowDirs=[];
try{
  for(const entry of readdirSync(join(root,"native-workflows"),{withFileTypes:true})){
    if(entry.isDirectory()&&existsSync(join(root,"native-workflows",entry.name,"manifest.json")))workflowDirs.push(entry.name);
  }
}catch{}
const missingLicenses=workflowDirs.filter(id=>!inventory.includes(id));
if(workflowDirs.length&&!missingLicenses.length)pass("Workflow license inventory",`${workflowDirs.length} bundled workflows`);
else if(!workflowDirs.length)warn("Workflow license inventory","no native-workflows manifests found");
else fail("Workflow license inventory",`missing ${missingLicenses.join(", ")}`);

if(existsSync(envFile)){
  pass("App environment",`${envFile} (${configured.length} keys; values not shown)`);
  for(const key of ["DATABASE_URL","STORAGE_ROOT","MASTER_KEY","PUBLIC_ORIGIN","COMFYFIELD_MODEL_ROOT"]){
    if(!configured.includes(key))warn(`Environment ${key}`,"missing from app.env");
  }
  // Optional hosted text. Only the key names are ever printed.
  const llmKeys=["COMFYFIELD_LLM_URL","COMFYFIELD_LLM_MODEL","COMFYFIELD_LLM_API_KEY"];
  const llmSet=llmKeys.filter(key=>appEnv[key]);
  const llmMissing=llmKeys.filter(key=>!appEnv[key]);
  if(!llmSet.length)pass("AI text","local ComfyUI worker only; no hosted endpoint keys");
  else if(llmMissing.length)warn("AI text",`set all three, or none: missing ${llmMissing.join(", ")}`);
  else pass("AI text",`${llmKeys.join(", ")} set (values not shown)`);
}else warn("App environment",`${envFile} missing; run npm run setup`);

// Comfy Cloud key: the direct value wins over a key file. A key file is only
// reported as found, missing or empty; its path and contents are never shown.
if(appEnv.COMFY_CLOUD_API_KEY)pass("Comfy Cloud key","COMFY_CLOUD_API_KEY set (value not shown)");
else if(!appEnv.COMFY_CLOUD_API_KEY_FILE)pass("Comfy Cloud key","no key; Comfy Cloud workers stay off");
else{
  let text=null;
  try{text=readFileSync(resolve(appEnv.COMFY_CLOUD_API_KEY_FILE),"utf8");}catch{}
  if(text===null)fail("Comfy Cloud key file","missing");
  else if(!text.trim())fail("Comfy Cloud key file","empty");
  else pass("Comfy Cloud key file","found");
}

if(has("dist/index.html"))pass("Built UI","dist/index.html");
else warn("Built UI","missing; run npm run build");

if(modelRoot&&existsSync(modelRoot)){
  let count=0;
  try{for(const entry of readdirSync(modelRoot,{recursive:true,withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith(".safetensors"))count++;}catch{}
  if(count>0)pass("Model root",`${modelRoot} (${count} .safetensors files)`);
  else warn("Model root",`${modelRoot} exists but has no .safetensors files`);
}else warn("Model root",modelRoot?"configured path does not exist":"COMFYFIELD_MODEL_ROOT is not configured");

if(storageRoot&&existsSync(storageRoot))pass("Asset storage",storageRoot);
else warn("Asset storage",storageRoot?"configured path does not exist":"STORAGE_ROOT is not configured");

if(await reachable(`${comfyUrl}/system_stats`))pass("ComfyUI",comfyUrl);
else warn("ComfyUI",`not reachable at ${comfyUrl}; start ComfyUI and set COMFY_URL if needed`);

if(await reachable(appUrl))pass("App server",appUrl);
else warn("App server",`not reachable at ${appUrl}; run npm start`);

if(appEnv.DATABASE_URL){
  const client=new Client({connectionString:appEnv.DATABASE_URL,connectionTimeoutMillis:2500});
  try{
    await client.connect();
    await client.query("SELECT 1");
    pass("PostgreSQL","DATABASE_URL reachable (value not shown)");
  }catch{
    warn("PostgreSQL","DATABASE_URL is configured but not reachable");
  }finally{
    await client.end().catch(()=>{});
  }
}else warn("PostgreSQL","DATABASE_URL is not configured");

const failed=checks.filter(check=>check.status==="FAIL").length;
const warned=checks.filter(check=>check.status==="WARN").length;
const passed=checks.length-failed-warned;

console.log("ComfyField doctor\n");
for(const check of checks){
  const mark=check.status==="PASS"?"[ok]":check.status==="WARN"?"[warn]":"[fail]";
  console.log(`${mark.padEnd(7)} ${check.label}${check.detail?` - ${check.detail}`:""}`);
}
console.log(`\n${passed} passed, ${warned} warnings, ${failed} failed`);
if(failed){
  console.log("Fix the [fail] items, then run npm run doctor again.");
  process.exit(1);
}
console.log("Repository prerequisites are usable. Start the app with npm start.");
