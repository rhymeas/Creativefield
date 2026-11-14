/** `minFreeShare` is the share of RAM the server keeps free before starting a run; absent in older records (15 %). */
export type WorkerHardware={checkedAt:string;minFreeShare?:number;ramTotal:number|null;ramFree:number|null;devices:{name:string;type:string;vramTotal:number|null;vramFree:number|null}[]};
const bytes=(v:unknown):number|null=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:null;
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const text=(v:unknown,max:number)=>typeof v==="string"?v.replace(/[\x00-\x1f\x7f]/g,"").slice(0,max):"Unknown";
export const DEFAULT_MIN_FREE_SHARE=0.15;
export function parseWorkerHardware(value:unknown,minFreeShare?:number):WorkerHardware{
  const raw=object(value),system=object(raw.system),ramTotal=bytes(system.ram_total),ramFree=bytes(system.ram_free);
  return {checkedAt:new Date().toISOString(),...(minFreeShare!==undefined?{minFreeShare}:{}),ramTotal,ramFree:ramTotal!==null&&ramFree!==null&&ramFree<=ramTotal?ramFree:null,
    devices:(Array.isArray(raw.devices)?raw.devices:[]).slice(0,8).map(item=>{const d=object(item),total=bytes(d.vram_total),free=bytes(d.vram_free);return {name:text(d.name,160),type:text(d.type,24),vramTotal:total,vramFree:total!==null&&free!==null&&free<=total?free:null};})};
}
export const gib=(bytes:number|null|undefined)=>bytes===null||bytes===undefined?"Not reported":`${(bytes/2**30).toFixed(1)} GiB`;
export function assessHardware(hardware:WorkerHardware|null|undefined):{tone:"info"|"warn";title:string;guidance:string}{
  if(!hardware||hardware.ramTotal===null||!hardware.devices.length)return {tone:"warn",title:"Hardware not fully reported",guidance:"Refresh the worker check before choosing a large workflow. Installed weights alone do not establish that a run will fit."};
  if(hardware.ramFree!==null&&hardware.ramFree/hardware.ramTotal<=(hardware.minFreeShare??DEFAULT_MIN_FREE_SHARE))return {tone:"warn",title:"System memory is under pressure",guidance:`Less than ${Math.round((hardware.minFreeShare??DEFAULT_MIN_FREE_SHARE)*100)}% of RAM is currently free. CreativeField waits before starting another job. Finish other jobs or close memory-heavy applications.`};
  const cuda=hardware.devices.filter(d=>d.type.toLowerCase()==="cuda"),vram=Math.max(0,...cuda.map(d=>d.vramTotal??0));
  if(vram>=23*2**30&&hardware.ramTotal>=60*2**30)return {tone:"info",title:"24 GB GPU / 64 GB RAM tier detected",guidance:"For Fun Camera, start at 640×640 and 17 frames, one job at a time. This matches the local test tier; other workflows and durations need their own trial."};
  return {tone:"warn",title:cuda.length?"Heavy video is unqualified on this setup":"No qualified CUDA device reported",guidance:"Start with smaller still-image jobs. The local heavy-video test tier is 24 GB GPU memory and 64 GB RAM; lower-memory or other devices need their own successful trial. CPU fallback may be very slow."};
}
