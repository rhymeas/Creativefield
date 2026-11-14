import {execFile} from "node:child_process";
import {readdir,stat} from "node:fs/promises";
import {join} from "node:path";

type RuntimeDeps={directories:(path:string)=>Promise<string[]>;isFile:(path:string)=>Promise<boolean>;version:(path:string)=>Promise<string>};
const system:RuntimeDeps={
  directories:path=>readdir(path,{withFileTypes:true}).then(entries=>entries.filter(e=>e.isDirectory()).map(e=>e.name),()=>[]),
  isFile:path=>stat(path).then(value=>value.isFile(),()=>false),
  version:path=>new Promise((resolve,reject)=>execFile(path,["--version"],{windowsHide:true,timeout:5000,maxBuffer:4096},(error,stdout)=>error?reject(error):resolve(stdout.trim()))),
};
function version(value:string){const found=/^codex-cli (\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(value);return found?{number:found.slice(1,4).map(Number),pre:found[4]??""}:undefined;}

/** The desktop runtime understands its own user's config; npm may contain an older incompatible CLI. */
export async function desktopCodex(env:NodeJS.ProcessEnv=process.env,platform=process.platform,deps:RuntimeDeps=system):Promise<string|undefined>{
  if(platform!=="win32"||env.COMFYFIELD_CODEX_BIN?.trim()||!env.LOCALAPPDATA)return undefined;
  const base=join(env.LOCALAPPDATA,"OpenAI","Codex","bin"),dirs=await deps.directories(base);
  const candidates=await Promise.all(dirs.slice(0,32).filter(name=>/^[\w.-]+$/.test(name)).map(async name=>{
    const path=join(base,name,"codex.exe");
    if(!await deps.isFile(path))return undefined;
    try{const parsed=version(await deps.version(path));return parsed?{path,...parsed}:undefined;}catch{return undefined;}
  }));
  return candidates.filter((x):x is {path:string;number:number[];pre:string}=>!!x).sort((a,b)=>{
    for(let i=0;i<3;i++)if(a.number[i]!==b.number[i])return b.number[i]-a.number[i];
    if(!a.pre||!b.pre)return a.pre?1:b.pre?-1:0;
    const pre=b.pre.localeCompare(a.pre,"en",{numeric:true});if(pre)return pre;
    return a.path.localeCompare(b.path);
  })[0]?.path;
}
