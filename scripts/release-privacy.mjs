import {createHash} from "node:crypto";
import {lstat, readFile} from "node:fs/promises";
import {join} from "node:path";

// This is an accidental-publication guard, not a complete secret scanner.
// A reviewer must select public files and inspect their contents before recording hashes.
const reviewPath=[".comfyfield","public-release-review.json"];
const maxManifestBytes=2*1024*1024;
const maxFileBytes=16*1024*1024;
const maxTotalBytes=128*1024*1024;

export function assertPublicPath(path){
  if(typeof path!=="string"||!path||!/^[a-zA-Z0-9_@. /-]+$/.test(path)||path.startsWith("/")||path.includes("\\"))throw new Error("Release review contains an invalid relative path.");
  const parts=path.split("/");
  if(parts.some(part=>!part||part==="."||part===".."||part.trim()!==part||/[. ]$/.test(part)))throw new Error("Release review contains an unsafe relative path.");
  if(parts.some((part,index)=>part.startsWith(".")&&!(index===0&&[".github",".gitignore",".env.example"].includes(part))))throw new Error("Release review contains private dotfiles or workspace state.");
  if(/^(node_modules|dist|release|renders|backups|evidence-live)(\/|$)/i.test(path)||/^(AGENTS\.md|NEXT-STEPS\.md|TODO\.md|PLAN\.md)$/i.test(path)||/^docs\/ContextContinuity(\/|$)/i.test(path))throw new Error("Release review contains internal development or runtime material.");
  if(/(^|\/)((auth|credentials|token|tokens|storage-state|storageState)\.(json|ya?ml|toml)(\.[^/]*)?|app\.env)$/i.test(path)||/\.(pem|key|p12|pfx|log|sqlite|db|bak)$/i.test(path))throw new Error("Release review contains a credential, log or private data filename.");
}

export function assertPublicText(content){
  if(content.includes(0))return; // Binary files require manual media/provenance review.
  const text=content.toString("utf8");
  if(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|\b(?:ghp|github_pat|gho)_[A-Za-z0-9_]{20,}|\bAKIA[A-Z0-9]{16}\b/.test(text))throw new Error("Release blocked: possible credential content; values are redacted.");
  if(/\b[A-Za-z]:[\\/]|\/(?:home|Users)\/[^\s/]+\//i.test(text))throw new Error("Release blocked: personal absolute filesystem path; values are redacted.");
  if(/(?:127\.0\.0\.1|localhost):7777\b/i.test(text))throw new Error("Release blocked: private local tracker reference.");
}

export async function readReviewedRelease(root){
  let manifest;
  try{
    const path=join(root,...reviewPath);
    const info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size>maxManifestBytes)throw new Error();
    manifest=JSON.parse(await readFile(path,"utf8"));
  }catch{
    throw new Error("Public packaging is locked. Complete the privacy/media review and supply the local per-file SHA-256 release manifest first. Nothing was exported.");
  }
  if(manifest?.version!==1||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>10000)throw new Error("Invalid release review manifest.");
  const files=[],seen=new Set();
  let total=0;
  for(const entry of manifest.files){
    assertPublicPath(entry?.path);
    if(typeof entry.sha256!=="string"||!/[a-f0-9]{64}/.test(entry.sha256)||entry.sha256.length!==64||seen.has(entry.path.toLowerCase()))throw new Error("Invalid or duplicate release review entry.");
    seen.add(entry.path.toLowerCase());
    let path=root;
    const parts=entry.path.split("/");
    for(let index=0;index<parts.length;index++){
      path=join(path,parts[index]);
      const info=await lstat(path);
      if(info.isSymbolicLink()||(index<parts.length-1?!info.isDirectory():!info.isFile()))throw new Error("Release blocked: linked or nonregular file.");
      if(index===parts.length-1&&(info.size>maxFileBytes||(total+=info.size)>maxTotalBytes))throw new Error("Release review exceeds its bounded file-size limit.");
    }
    const content=await readFile(path);
    if(content.length>maxFileBytes||createHash("sha256").update(content).digest("hex")!==entry.sha256)throw new Error("Release blocked: file changed since privacy review.");
    assertPublicText(content);
    files.push({path:entry.path,content});
  }
  // Package these exact checked bytes; never rediscover untracked files or include Git history.
  return files;
}
