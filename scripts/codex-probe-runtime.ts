/** Native subscription experiments only. Does not change ComfyField's public providers. */
import {execFile} from 'node:child_process';
import {readdir,stat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';

export type ProbeRuntime={bin:string;prefix:string[];source:'explicit'|'desktop'|'npm'|'path';version:string;imageGeneration:boolean};
type Candidate=Pick<ProbeRuntime,'bin'|'prefix'|'source'>;
export type RuntimeDeps={
 exists:(path:string)=>Promise<boolean>;
 directories:(path:string)=>Promise<string[]>;
 run:(bin:string,args:string[])=>Promise<string>;
};
export function sanitizedProbeEnvironment(env:NodeJS.ProcessEnv){return Object.fromEntries(Object.entries(env).filter(([key])=>!key.toUpperCase().endsWith('API_KEY')&&!['OPENAI_BASE_URL','OPENAI_API_BASE','CODEX_PROVIDER','CODEX_MODEL_PROVIDER'].includes(key.toUpperCase())));}
const nativeDeps:RuntimeDeps={
 exists:path=>stat(path).then(s=>s.isFile(),()=>false),
 directories:path=>readdir(path,{withFileTypes:true}).then(entries=>entries.filter(e=>e.isDirectory()).map(e=>e.name),()=>[]),
 run:(bin,args)=>new Promise((res,rej)=>execFile(bin,args,{windowsHide:true,shell:false,timeout:10000,maxBuffer:65536,env:sanitizedProbeEnvironment(process.env)},(error,stdout)=>error?rej(new Error('Native Codex runtime inspection failed. No fallback started.')):res(stdout))),
};
function versionParts(version:string){const match=version.match(/^codex-cli (\d+)\.(\d+)\.(\d+)(?:[\w.+-]*)$/);if(!match)throw new Error('Unrecognized native Codex version.');return match.slice(1).map(Number);}
function newerFirst(a:string,b:string){
 const av=versionParts(a),bv=versionParts(b);for(let i=0;i<3;i++){if(av[i]!==bv[i])return bv[i]-av[i];}
 const ap=a.slice('codex-cli '.length).split('-').slice(1).join('-'),bp=b.slice('codex-cli '.length).split('-').slice(1).join('-');
 if(!ap||!bp)return ap?1:bp?-1:0;
 return bp.localeCompare(ap,'en',{numeric:true});
}
export function requireImageRuntime(runtime:ProbeRuntime){
 const [major,minor]=versionParts(runtime.version);
 if(major===0&&minor<164)throw new Error(`Codex ${runtime.version} predates this probe's native image contract (0.164+). No model turn started.`);
 if(!runtime.imageGeneration)throw new Error('Native image_generation is not enabled in this runtime. No model turn started.');
}
/** Explicit binary wins. Otherwise prefer the newest installed desktop CLI, then npm/PATH. Never retry another binary after selection fails. */
export async function resolveProbeRuntime(env:NodeJS.ProcessEnv=process.env,platform=process.platform,deps:RuntimeDeps=nativeDeps):Promise<ProbeRuntime>{
 const candidates:Candidate[]=[];
 if(env.COMFYFIELD_CODEX_BIN?.trim()){
  const bin=env.COMFYFIELD_CODEX_BIN.trim();if(!isAbsolute(bin)||!await deps.exists(bin))throw new Error('COMFYFIELD_CODEX_BIN must name an existing absolute executable.');
  candidates.push({bin,prefix:/\.m?js$/i.test(bin)?[bin]:[],source:'explicit'});
  if(candidates[0].prefix.length)candidates[0].bin=process.execPath;
 }else if(platform==='win32'){
  if(env.LOCALAPPDATA){const base=join(env.LOCALAPPDATA,'OpenAI/Codex/bin'),dirs=await deps.directories(base);if(dirs.length>32)throw new Error('Too many native runtime candidates; set COMFYFIELD_CODEX_BIN explicitly.');
   for(const dir of dirs){if(!/^[\w.-]+$/.test(dir))continue;const bin=join(base,dir,'codex.exe');if(await deps.exists(bin))candidates.push({bin,prefix:[],source:'desktop'});}}
  if(!candidates.length&&env.APPDATA){const script=join(env.APPDATA,'npm/node_modules/@openai/codex/bin/codex.js');if(await deps.exists(script))candidates.push({bin:process.execPath,prefix:[script],source:'npm'});}
 }else candidates.push({bin:'codex',prefix:[],source:'path'});
 if(!candidates.length)throw new Error('No installed native Codex CLI found. No installation or fallback attempted.');
 const versions=[];
 for(const candidate of candidates){const version=(await deps.run(candidate.bin,[...candidate.prefix,'--version'])).trim();versionParts(version);versions.push({...candidate,version});}
 versions.sort((a,b)=>newerFirst(a.version,b.version)||a.bin.localeCompare(b.bin));
 const selected=versions[0],features=await deps.run(selected.bin,[...selected.prefix,'features','list']);
 return {...selected,imageGeneration:/^image_generation\s+\S+\s+true\s*$/m.test(features)};
}
export function probeServerArgs(configMcpArgs:string[]){return ['-c','model_reasoning_effort="low"','-c','features.image_generation=true','-c','features.shell_tool=false','-c','features.multi_agent=false','-c','web_search="disabled"',...configMcpArgs,'app-server'];}
