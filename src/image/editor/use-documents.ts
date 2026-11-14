import {useEffect,useRef,useState} from "react";
import {assetUrl,workspacePath,type Asset,type Call} from "../../team/api";
import {blankCanvas,getBitmap,loadBitmap,sizeOf} from "./bitmaps";
import {DOCUMENT_FORMAT,documentKeys,mapDocumentKeys} from "./document-keys";
import type {Doc} from "./doc";

export type EditorDocument={id:string;name:string;kind:"saved"|"recovery";revision:number;updated_at:string;document?:Doc};
export function useDocuments({workspaceId,projectId,call,doc,getRoot,enabled,onLoad}:{workspaceId:string;projectId:string;call:Call;doc:Doc|null;getRoot:()=>Doc|null;enabled:boolean;onLoad:(doc:Doc)=>void}){
  const base=workspacePath(workspaceId,`projects/${projectId}/editor-documents`);
  const [records,setRecords]=useState<EditorDocument[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const queue=useRef<Promise<unknown>>(Promise.resolve()),mounted=useRef(true),assets=useRef(new Map<string,string>()),root=useRef(getRoot);
  root.current=getRoot;
  const recovery=useRef(new Map<string,{id:string;revision:number}>());
  const currentProject=useRef(base);currentProject.current=base;
  const currentDoc=useRef(doc),synced=useRef<Doc|null>(null);currentDoc.current=doc;
  const flush=useRef<()=>void>(()=>{});
  useEffect(()=>()=>flush.current(),[]);
  useEffect(()=>{const guard=(event:BeforeUnloadEvent)=>{if(enabled&&currentDoc.current&&currentDoc.current!==synced.current){event.preventDefault();event.returnValue="";}};window.addEventListener("beforeunload",guard);return()=>window.removeEventListener("beforeunload",guard);},[enabled]);
  const refresh=async()=>{const result=await call<EditorDocument[]>(base);if(mounted.current&&currentProject.current===base)setRecords(result);};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setRecords([]);setError("");setBusy(false);if(enabled)void refresh().catch(e=>{if(mounted.current&&currentProject.current===base)setError((e as Error).message);});},[base,enabled]);

  async function encode(snapshot:Doc):Promise<Doc>{
    const refs=new Map<string,string>();
    for(const key of documentKeys(snapshot)){
      const cacheKey=`${base}/${key}`;
      let id=assets.current.get(cacheKey);
      if(!id){
        const bitmap=getBitmap(key);if(!bitmap)throw new Error("A document bitmap is not loaded. Keep this tab open and try saving again.");
        const {w,h}=sizeOf(bitmap);if(w*h>67108864)throw new Error("A source bitmap exceeds the document save budget.");
        const canvas=blankCanvas(w,h);canvas.getContext("2d")!.drawImage(bitmap,0,0);
        const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("Document pixels could not be encoded.")),"image/png"));
        const form=new FormData();form.append("file",new File([blob],"document-layer.png",{type:"image/png"}));
        id=(await call<Asset>(workspacePath(workspaceId,`assets?projectId=${projectId}&kind=layer&purpose=editor-document`),"POST",form)).id;assets.current.set(cacheKey,id);
      }
      refs.set(key,`asset:${id}`);
    }
    return (await import("./document-format")).validateDocument(mapDocumentKeys(snapshot,key=>refs.get(key)!));
  }
  function persist(kind:"saved"|"recovery",name="Edited image"){
    const snapshot=root.current();if(!snapshot||!enabled)return Promise.resolve();
    const original=currentDoc.current;
    const target=base;
    const operation=queue.current.catch(()=>{}).then(async()=>{
      if(currentProject.current!==target)return;
      if(mounted.current)setBusy(true);
      try{
        const document=await encode(snapshot);
        if(currentProject.current!==target)return;
        const identity=kind==="recovery"?(recovery.current.get(base)??{id:crypto.randomUUID(),revision:0}):{id:crypto.randomUUID(),revision:0};
        const saved=await call<EditorDocument>(`${base}/${identity.id}`,"PUT",{format:DOCUMENT_FORMAT,name,kind,revision:identity.revision,document});
        if(kind==="recovery")recovery.current.set(base,{id:saved.id,revision:saved.revision});
        if(currentDoc.current===original)synced.current=original;
        if(mounted.current&&currentProject.current===target){setError("");await refresh();}
      }catch(e){if(mounted.current&&currentProject.current===target)setError(`Document not saved: ${(e as Error).message}. Keep this tab open.`);throw e;}
      finally{if(mounted.current&&currentProject.current===target)setBusy(false);}
    });
    queue.current=operation;return operation;
  }
  flush.current=()=>{if(currentDoc.current&&currentDoc.current!==synced.current)void persist("recovery","Recovered image").catch(()=>{});};
  useEffect(()=>{
    if(!doc||!enabled)return;
    const timer=setTimeout(()=>{void persist("recovery","Recovered image").catch(()=>{});},1500);
    return()=>clearTimeout(timer);
  },[doc,base,enabled]);
  async function open(id:string){
    if(busy)return;setBusy(true);
    try{
      const record=await call<EditorDocument>(`${base}/${id}`),stored=(await import("./document-format")).validateDocument(record.document);
      for(const key of documentKeys(stored)){const assetId=key.slice(6),url=assetUrl(workspaceId,assetId);await loadBitmap(url);assets.current.set(`${base}/${url}`,assetId);}
      const restored=mapDocumentKeys(stored,key=>assetUrl(workspaceId,key.slice(6)));
      if(mounted.current&&currentProject.current===base){onLoad(restored);setError("");}
    }catch(e){if(mounted.current&&currentProject.current===base)setError(`Document not opened: ${(e as Error).message}. The current canvas was kept.`);throw e;}
    finally{if(mounted.current&&currentProject.current===base)setBusy(false);}
  }
  return {records,busy,error,save:()=>persist("saved",doc?.layers[0]?.name??"Edited image"),open,refresh};
}
