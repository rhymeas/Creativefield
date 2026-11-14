/* A hosted guest's library lives in their browser. The server workspace is only a place
   to work from and is deleted after a day without a visit, so every file the guest sees is copied
   into Cache Storage (public/sw.js answers from it) with its record beside it. When the workspace
   is gone the records still list here, and a file is sent back under its own id only when a render
   needs it. Once a checked copy is here and no render is working, the server gives up its bytes
   (HOLD_MS keeps a file for the request that usually follows its upload). FotoField documents never
   leave this browser. A local install does not switch this on. */
import {ApiError,type Asset,type AssetPage} from "./api";

const CACHE="creativefield-library-v1",RESTORE_TIMEOUT=300000,HOLD_MS=120000,SWEEP_MS=30000;
const fileKey=(id:string)=>`/browser-library/file/${id}`,recordKey=(id:string)=>`/browser-library/record/${id}`,documentKey=(id:string)=>`/browser-library/document/${id}`;
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const RESTORABLE=new Set(["image","video","audio","mask","layer","reference","model3d"]);

type Send=<T>(path:string,method?:string,body?:unknown,options?:{timeoutMs?:number})=>Promise<T>;
export type LibraryRecord={asset:Asset;workspaceId:string;hidden?:boolean;/** The server gave up its bytes; the row stays. */released?:boolean;seenAt?:number};
export type LocalDocument={id:string;name:string;kind:string;revision:number;updated_at:string;document?:unknown};

let active=false;
/** Which project a browser-only file is currently listed in, so a render restores it into that one. */
const shownIn=new Map<string,string>();
let mirroring:Promise<void>=Promise.resolve(),releasing:Promise<void>=Promise.resolve();
let writes=0,sweeper:ReturnType<typeof setInterval>|undefined,workspaceNow="";

const open=()=>caches.open(CACHE);
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{"Content-Type":"application/json"}});
async function readAll<T>(prefix:string):Promise<T[]>{
  const cache=await open(),keys=(await cache.keys()).filter(key=>new URL(key.url).pathname.startsWith(prefix));
  return Promise.all(keys.map(async key=>(await (await cache.match(key))!.json()) as T));
}
const readRecord=async(id:string)=>{const hit=await (await open()).match(recordKey(id));return hit?await hit.json() as LibraryRecord:undefined;};
const writeRecord=async(record:LibraryRecord)=>{await (await open()).put(recordKey(record.asset.id),json(record));};
async function forget(id:string){const cache=await open();await Promise.all([cache.delete(recordKey(id)),cache.delete(fileKey(id))]);shownIn.delete(id);}

/** Turns the library on for this tab once the worker controls it. Without a worker nothing changes. */
export async function enableBrowserLibrary(){
  if(active||!("serviceWorker" in navigator)||!("caches" in window))return;
  try{
    await navigator.serviceWorker.register("/sw.js",{scope:"/"});
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller)await new Promise<void>(done=>{const stop=setTimeout(done,3000);navigator.serviceWorker.addEventListener("controllerchange",()=>{clearTimeout(stop);done();},{once:true});});
    if(!navigator.serviceWorker.controller)return;
    /* Asks the browser not to clear this copy when disk runs low. A refusal only leaves it best-effort. */
    await navigator.storage?.persist?.().catch(()=>false);
    active=true;
  }catch{/* The server copy keeps working. */}
}
/** For tests. */
export function setBrowserLibraryActive(value:boolean){active=value;shownIn.clear();writes=0;workspaceNow="";if(sweeper)clearInterval(sweeper);sweeper=undefined;}
/** Counts requests that change something: nothing is released while one is on its way. */
export function trackWrite(method:string){
  if(method==="GET")return ()=>{};
  writes++;return ()=>{writes--;};
}

function scope(path:string){const match=/^\/workspaces\/([^/]+)\/([^?]*)(?:\?(.*))?$/.exec(path);return match?{workspaceId:decodeURIComponent(match[1]),tail:match[2],query:new URLSearchParams(match[3]??"")}:null;}
const contentPath=(workspaceId:string,id:string)=>`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(id)}/content`;

/** Copies files in the background, one at a time; the worker stores each answer as it passes. */
function mirror(workspaceId:string,items:Asset[]){
  mirroring=mirroring.then(async()=>{
    const cache=await open();
    for(const item of items){
      if(await cache.match(fileKey(item.id)))continue;
      await fetch(contentPath(workspaceId,item.id),{credentials:"same-origin"}).then(response=>response.body?.cancel()).catch(()=>undefined);
    }
  }).catch(()=>undefined);
}
async function remember(workspaceId:string,items:Asset[]){
  await Promise.all(items.map(async asset=>{
    const prior=await readRecord(asset.id),same=prior?.workspaceId===workspaceId;
    await writeRecord({asset,workspaceId,seenAt:same?prior?.seenAt??Date.now():Date.now(),...(same&&prior?.released?{released:true}:{})});
  }));
  mirror(workspaceId,items);
}
const hex=(bytes:ArrayBuffer)=>[...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
/** Tells the server to drop each file this browser holds in full. A refusal waits for the next sweep. */
export function sweepReleases(send:Send,now=Date.now()){
  releasing=releasing.then(async()=>{
    if(!workspaceNow)return;
    const cache=await open(),records=await readAll<LibraryRecord>("/browser-library/record/");
    for(const record of records){
      if(writes>0)return;
      const {asset}=record;
      if(record.workspaceId!==workspaceNow||record.hidden||record.released||!asset.sha256||now-(record.seenAt??now)<HOLD_MS)continue;
      const stored=await cache.match(fileKey(asset.id));if(!stored)continue;
      const blob=await stored.blob();
      if(blob.size!==Number(asset.bytes)||hex(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer()))!==asset.sha256)continue;
      try{await send(`/workspaces/${encodeURIComponent(workspaceNow)}/assets/${encodeURIComponent(asset.id)}/release`,"POST",{sha256:asset.sha256});}
      catch{return;}
      await writeRecord({...record,released:true});
    }
  }).catch(()=>undefined);
  return releasing;
}
/** A file from an earlier workspace: the server no longer has it, only this browser does. */
const onlyHere=(record:LibraryRecord,workspaceId:string)=>record.workspaceId!==workspaceId&&!record.hidden;
const listable=(record:LibraryRecord,kind:string|null)=>(!kind||record.asset.media_type===kind)&&record.asset.metadata?.libraryHidden!==true&&record.asset.metadata?.editorDocumentBitmap!==true;

/** Answers what never reaches the server. `undefined` means: ask the server. */
export async function answerLocally(path:string,method:string,body:unknown):Promise<unknown>{
  if(!active)return undefined;
  const place=scope(path);if(!place)return undefined;
  const {workspaceId,tail,query}=place;
  const documents=/^projects\/[^/]+\/editor-documents(?:\/([^/]+))?$/.exec(tail);
  if(documents)return documentRequest(documents[1],method,body);
  if(method==="POST"&&tail==="assets"&&query.get("purpose")==="editor-document"&&body instanceof FormData)return documentBitmap(workspaceId,body);
  const single=/^assets\/([^/]+)$/.exec(tail);
  if(single&&(method==="GET"||method==="DELETE")){
    const record=await readRecord(single[1]);if(!record||!onlyHere(record,workspaceId))return undefined;
    if(method==="DELETE"){await forget(single[1]);return {};}
    return {...record.asset,project_id:shownIn.get(record.asset.id)??record.asset.project_id,relations:[]};
  }
  return undefined;
}
async function documentRequest(id:string|undefined,method:string,body:unknown){
  const cache=await open();
  if(!id){
    if(method!=="GET")return undefined;
    const all=await readAll<LocalDocument>("/browser-library/document/");
    return all.sort((a,b)=>b.updated_at.localeCompare(a.updated_at)).map(({document:_document,...record})=>record);
  }
  const hit=await cache.match(documentKey(id)),stored=hit?await hit.json() as LocalDocument:undefined;
  if(method==="GET"){if(!stored)throw new ApiError(404,"Document not found");return stored;}
  if(method==="PUT"){
    const input=body as {name:string;kind:string;revision:number;document:unknown};
    if((stored?.revision??0)!==input.revision)throw new ApiError(409,"This document changed in another tab");
    const saved:LocalDocument={id,name:input.name,kind:input.kind,revision:input.revision+1,updated_at:new Date().toISOString(),document:input.document};
    await cache.put(documentKey(id),json(saved));return saved;
  }
  return undefined;
}
async function documentBitmap(workspaceId:string,form:FormData){
  const file=form.get("file");if(!(file instanceof File))throw new ApiError(400,"Choose a media file");
  const id=crypto.randomUUID();
  const asset:Asset={id,project_id:null,name:file.name,media_type:"layer",content_type:file.type,bytes:String(file.size),created_at:new Date().toISOString(),parent_id:null,metadata:{editorDocumentBitmap:true}};
  await (await open()).put(fileKey(id),new Response(file,{headers:{"Content-Type":file.type,"Content-Disposition":"inline"}}));
  await writeRecord({asset,workspaceId,hidden:true});
  return asset;
}

/** Sends back the browser-only files a request names before it goes out. A file another workspace still
    holds (a lost session, inside the day) comes back under a new id, and the request is rewritten to it. */
export async function restoreFor(path:string,method:string,body:unknown,send:Send):Promise<{path:string;body:unknown}>{
  const unchanged={path,body};
  if(!active||method==="GET"||method==="DELETE")return unchanged;
  const place=scope(path);
  if(!place||place.query.has("restoreId")||/^assets\/[^/]+\/(release|restore)$/.test(place.tail)||place.tail==="assets/lookup")return unchanged;
  await releasing;
  const base=`/workspaces/${encodeURIComponent(place.workspaceId)}/assets`,moved=new Map<string,string>();
  const text=`${path} ${body===undefined||body instanceof FormData?"":JSON.stringify(body)}`;
  for(const id of new Set((text.match(UUID)??[]).map(value=>value.toLowerCase()))){
    if(id===place.workspaceId.toLowerCase())continue;
    const record=await readRecord(id);if(!record)continue;
    /* An upload only names its project and parent; a released parent keeps its row. */
    const released=record.released&&record.workspaceId===place.workspaceId&&place.tail!=="assets",projectId=shownIn.get(id);
    if(!released&&(!onlyHere(record,place.workspaceId)||!projectId||!RESTORABLE.has(record.asset.media_type)))continue;
    const stored=await (await open()).match(fileKey(id));
    if(!stored)throw new ApiError(410,`${record.asset.name} is no longer in this browser. Add it again.`);
    const blob=await stored.blob(),form=()=>{const value=new FormData();value.append("file",new File([blob],record.asset.name,{type:record.asset.content_type}));return value;};
    const upload=(tail:string)=>send<Asset>(`${base}${tail}`,"POST",form(),{timeoutMs:RESTORE_TIMEOUT});
    const keep=(asset:Asset)=>writeRecord({asset:{...record.asset,...asset,metadata:{...record.asset.metadata,...asset.metadata}},workspaceId:place.workspaceId,seenAt:Date.now()});
    if(released){await keep(await upload(`/${id}/restore`));continue;}
    const query=`?projectId=${projectId}&kind=${record.asset.media_type}`;
    try{await keep(await upload(`${query}&restoreId=${id}`));}
    catch(error){
      if(!(error instanceof ApiError)||error.status!==409)throw error;
      const fresh=await upload(query);
      await (await open()).put(fileKey(fresh.id),new Response(blob,{headers:stored.headers}));
      await keep(fresh);await forget(id);shownIn.set(fresh.id,projectId!);moved.set(id,fresh.id);
    }
  }
  if(!moved.size)return unchanged;
  const swap=(value:string)=>[...moved].reduce((text,[from,to])=>text.split(from).join(to),value);
  return {path:swap(path),body:body===undefined||body instanceof FormData?body:JSON.parse(swap(JSON.stringify(body)))};
}

/** Keeps a copy of what the server answered, and adds the browser's own files to a finished list. */
export async function afterResponse<T>(path:string,method:string,body:unknown,content:T,send:Send):Promise<T>{
  if(!active)return content;
  const place=scope(path);if(!place)return content;
  const {workspaceId,tail,query}=place;
  workspaceNow=workspaceId;
  sweeper??=setInterval(()=>{void sweepReleases(send);},SWEEP_MS);
  if(method==="GET"&&tail==="assets"){
    const page=content as unknown as AssetPage,projectId=query.get("projectId");
    await remember(workspaceId,page.items);
    if(page.nextCursor||!projectId)return content;
    const known=new Set(page.items.map(item=>item.id));
    const here=(await readAll<LibraryRecord>("/browser-library/record/")).filter(record=>onlyHere(record,workspaceId)&&!known.has(record.asset.id)&&listable(record,query.get("kind")));
    for(const record of here)shownIn.set(record.asset.id,projectId);
    const extra=here.map(record=>({...record.asset,project_id:projectId})).sort((a,b)=>b.created_at.localeCompare(a.created_at));
    return {...page,items:[...page.items,...extra]} as T;
  }
  if(method==="POST"&&tail==="assets"){await remember(workspaceId,[content as unknown as Asset]);return content;}
  if(method==="POST"&&tail==="assets/lookup"){
    const page=content as unknown as {items:Asset[]},input=body as {projectId:string;ids:string[]},known=new Set(page.items.map(item=>item.id)),extra:Asset[]=[];
    for(const id of input.ids){
      if(known.has(id))continue;
      const record=await readRecord(id);
      if(record&&onlyHere(record,workspaceId)){shownIn.set(id,input.projectId);extra.push({...record.asset,project_id:input.projectId});}
    }
    return {...page,items:[...page.items,...extra]} as T;
  }
  const removed=/^assets\/([^/]+)$/.exec(tail);
  if(method==="DELETE"&&removed){await forget(removed[1]);return content;}
  if(method==="DELETE"&&/^runs\/[^/]+$/.test(tail))await dropDeleted(workspaceId,send);
  return content;
}
/** A deleted result took its files with it on the server; its copy goes too, or it would come back. */
async function dropDeleted(workspaceId:string,send:Send){
  const records=(await readAll<LibraryRecord>("/browser-library/record/")).filter(record=>record.workspaceId===workspaceId&&!record.hidden&&record.asset.project_id);
  const byProject=new Map<string,string[]>();
  for(const record of records)byProject.set(record.asset.project_id!,[...byProject.get(record.asset.project_id!)??[],record.asset.id]);
  for(const [projectId,ids] of byProject)for(let start=0;start<ids.length;start+=200){
    const batch=ids.slice(start,start+200);
    const found=await send<{items:Asset[]}>(`/workspaces/${encodeURIComponent(workspaceId)}/assets/lookup`,"POST",{projectId,ids:batch}).catch(()=>null);
    if(!found)continue;
    const alive=new Set(found.items.map(item=>item.id));
    for(const id of batch)if(!alive.has(id))await forget(id);
  }
}
