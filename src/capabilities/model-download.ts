import type {Requirement} from "./types";

/** Explicit browser downloads only; never an installer, inference call or arbitrary URL proxy. */
export function modelDownloadUrl(requirement:Requirement):string|undefined{
  if(requirement.kind!=="model"||!requirement.source)return undefined;
  try{
    const url=new URL(requirement.source);
    if(url.protocol!=="https:"||url.hostname!=="huggingface.co"||url.port||url.username||url.password||url.hash)return undefined;
    if([...url.searchParams.keys()].some(key=>key!=="download"))return undefined;
    const parts=url.pathname.split("/").slice(1);
    if(parts.length<5||!["blob","resolve"].includes(parts[2])||parts.some(part=>!part||!/^[-a-zA-Z0-9_.@]+$/.test(part)||part==="."||part===".."))return undefined;
    if(parts.at(-1)!==requirement.name||!/[.](safetensors|gguf|pt|pth|bin|ckpt)$/.test(requirement.name))return undefined;
    if(requirement.sourceRevision){if(!/^[a-f0-9]{40}$/.test(requirement.sourceRevision))return undefined;parts[3]=requirement.sourceRevision;}
    parts[2]="resolve";url.pathname="/"+parts.join("/");url.search="";url.searchParams.set("download","true");
    return url.href;
  }catch{return undefined;}
}

export function modelDownloadSize(bytes:number|undefined):string|undefined{
  if(bytes===undefined||!Number.isFinite(bytes)||bytes<=0)return undefined;
  const gib=bytes/1024**3;
  return gib>=1?gib.toFixed(2)+" GiB":(bytes/1024**2).toFixed(1)+" MiB";
}
