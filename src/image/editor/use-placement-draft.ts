import {useEffect,useRef,useState} from "react";
import type {CapabilityManifestV2} from "../../capabilities/types";
import {ApiError, workspacePath, type Call, type CharacterRecord} from "../../team/api";
import {characterPath} from "../../team/characters/state";
import {characterEditBindings} from "./character-references";
import {blankCanvas,getBitmap} from "./bitmaps";
import type {Doc} from "./doc";
import {renderDoc} from "./render";
import {imageSignature} from "./region-tools";
import {placementDraftKey,placementDraftSchema,placementScopeSchema,readPlacementDraft,type PlacementDraft,type PlacementScope} from "./placement-draft";

type RemoteOperation={type:"put";draft:PlacementDraft;epoch:number}|{type:"delete";epoch:number};
const draftPath=(scope:PlacementScope)=>workspacePath(scope.workspaceId,`projects/${scope.projectId}/placement-drafts/${scope.assetId}`);

export function usePlacementDraft(options:{scope:PlacementScope;doc:Doc|null;bitmapRevision:number;character:CharacterRecord|null;placementId:string|null;prompt:string;manifest?:CapabilityManifestV2;enabled:boolean;call:Call;currentDoc:()=>Doc|null;onRestore:(snapshot:Doc,record:CharacterRecord,mask:HTMLCanvasElement|null,prompt:string)=>void}){
  const current=useRef(options);current.current=options;
  const writeEpoch=useRef(0);
  const key=placementDraftKey(options.scope),[saved,setSaved]=useState<PlacementDraft|null>(null),[error,setError]=useState(""),[attempt,setAttempt]=useState(0);
  const attempted=useRef(""),attemptedDoc=useRef<Doc|null>(null),failedAttempt=useRef<number|null>(null),sceneCache=useRef<{key:string;hash:Promise<string>}|null>(null),maskCache=useRef<{key:string;mask:string|null}|null>(null);
  const scoped=placementScopeSchema.safeParse(options.scope).success;
  const remoteAbort=useRef<AbortController|null>(null),remoteOps=useRef<RemoteOperation[]>([]),remoteRunning=useRef(false);
  useEffect(()=>{attempted.current="";attemptedDoc.current=null;failedAttempt.current=null;setSaved(null);setError("");remoteAbort.current?.abort();if(!scoped)return;let local:PlacementDraft|null=null;try{const raw=sessionStorage.getItem(key);local=readPlacementDraft(raw,options.scope);if(raw&&!local)setError("The saved placement draft is invalid. Clear it and place the character again.");setSaved(local);}catch{setError("Browser storage is unavailable for placement recovery.");}if(local)return;const abort=new AbortController();remoteAbort.current=abort;void options.call<{draft:PlacementDraft}>(draftPath(options.scope),"GET",undefined,{signal:abort.signal}).then(remote=>{if(abort.signal.aborted)return;const draft=readPlacementDraft(JSON.stringify(remote.draft),options.scope);if(!draft){setError("The cloud placement draft is invalid. Clear it and place the character again.");return;}try{sessionStorage.setItem(key,JSON.stringify(draft));}catch{}setSaved(draft);setError("");}).catch(cause=>{if(abort.signal.aborted||(cause instanceof ApiError&&cause.status===404))return;if(!local)setError(`Placement draft not loaded: ${(cause as Error).message}`);});return()=>abort.abort();},[key,scoped]);

  function sceneHash(doc:Doc,revision:number){
    if(doc.width>2048||doc.height>2048)throw new Error("Placement recovery supports canvases up to 2048 pixels per side. Save the editor document before leaving.");
    const signature=`${imageSignature(doc)}:${revision}`;
    if(sceneCache.current?.key===signature)return sceneCache.current.hash;
    const canvas=blankCanvas(doc.width,doc.height),ctx=canvas.getContext("2d",{willReadFrequently:true})!;
    renderDoc(ctx,{...doc,selection:null});
    const bytes=ctx.getImageData(0,0,doc.width,doc.height).data;
    const hash=crypto.subtle.digest("SHA-256",bytes).then(buffer=>Array.from(new Uint8Array(buffer),value=>value.toString(16).padStart(2,"0")).join(""));
    sceneCache.current={key:signature,hash};return hash;
  }
  function selectionMask(doc:Doc,revision:number){
    const signature=`${doc.selection}:${doc.width}:${doc.height}:${revision}`;
    if(maskCache.current?.key===signature)return maskCache.current.mask;
    let mask:string|null=null;
    if(doc.selection){const bitmap=getBitmap(doc.selection);if(!bitmap)throw new Error("The selection is still loading. Keep this tab open.");const canvas=blankCanvas(doc.width,doc.height);canvas.getContext("2d")!.drawImage(bitmap,0,0);mask=canvas.toDataURL("image/png");}
    maskCache.current={key:signature,mask};return mask;
  }
  function drainRemote(){
    if(remoteRunning.current)return;
    remoteRunning.current=true;
    void (async()=>{try{
      while(remoteOps.current.length){
        const operation=remoteOps.current.shift()!;
        if(operation.type==="put"&&operation.epoch!==writeEpoch.current)continue;
        try{
          if(operation.type==="put")await current.current.call(draftPath(operation.draft),"PUT",operation.draft);
          else await current.current.call(draftPath(options.scope),"DELETE");
        }catch{
          if(operation.type==="delete")setError("The placement draft was cleared here but the cloud copy could not be removed. It may return on another device.");
        }
      }
    }finally{remoteRunning.current=false;}})();
  }
  function syncRemote(draft:PlacementDraft){
    const operations=remoteOps.current,lastDelete=operations.map(operation=>operation.type).lastIndexOf("delete");
    remoteOps.current=[...operations.slice(0,lastDelete+1),{type:"put",draft,epoch:writeEpoch.current}];
    drainRemote();
  }
  function clearRemote(){
    remoteOps.current=remoteOps.current.filter(operation=>operation.type!=="put");
    remoteOps.current.push({type:"delete",epoch:writeEpoch.current});
    drainRemote();
  }
  useEffect(()=>{
    const {doc,character,placementId,manifest,enabled,bitmapRevision,prompt,scope}=options;
    if(!enabled||!scoped||!doc||!character||character.id!==placementId||!manifest)return;
    let cancelled=false;const epoch=writeEpoch.current;
    void (async()=>{try{
      characterEditBindings(character,manifest,scope.projectId);
      const hash=await sceneHash(doc,bitmapRevision);
      if(cancelled||epoch!==writeEpoch.current||current.current.currentDoc()!==doc||current.current.bitmapRevision!==bitmapRevision)return;
      const draft=placementDraftSchema.parse({version:1,...scope,characterId:character.id,capabilityId:manifest.id,capabilityVersion:manifest.version,width:doc.width,height:doc.height,sceneHash:hash,mask:selectionMask(doc,bitmapRevision),prompt});
      sessionStorage.setItem(key,JSON.stringify(draft));setSaved(draft);setError("");syncRemote(draft);
    }catch(cause){if(!cancelled)setError(`Placement draft not saved: ${(cause as Error).message}`);}})();
    return()=>{cancelled=true;};
  },[key,scoped,options.doc,options.bitmapRevision,options.character,options.placementId,options.prompt,options.manifest,options.enabled,attempt]);

  useEffect(()=>{
    const {doc,manifest,enabled,placementId,bitmapRevision,scope,call,prompt,character}=options;
    if(!saved||!enabled||!scoped||!doc||!manifest||placementId||failedAttempt.current===attempt)return;
    const identity=`${key}:${saved.sceneHash}:${imageSignature(doc)}:${bitmapRevision}:${attempt}`;
    if(attempted.current===identity){if(attemptedDoc.current!==doc){failedAttempt.current=attempt;setError("The selection changed during recovery. Review it and retry placement recovery.");}return;}attempted.current=identity;attemptedDoc.current=doc;
    const abort=new AbortController();let cancelled=false;
    void (async()=>{try{
      if(saved.capabilityId!==manifest.id||saved.capabilityVersion!==manifest.version)throw new Error("The saved placement uses a different workflow version. Place the character again.");
      if(doc.width!==saved.width||doc.height!==saved.height||await sceneHash(doc,bitmapRevision)!==saved.sceneHash)throw new Error("Open the matching saved scene before resuming this placement.");
      const record=await call<CharacterRecord>(characterPath(scope.workspaceId,scope.projectId,saved.characterId),"GET",undefined,{signal:abort.signal});
      characterEditBindings(record,manifest,scope.projectId);
      let mask:HTMLCanvasElement|null=null;
      if(saved.mask){const image=new Image();image.src=saved.mask;await image.decode();if(image.naturalWidth!==doc.width||image.naturalHeight!==doc.height)throw new Error("The saved selection size is invalid.");mask=blankCanvas(doc.width,doc.height);mask.getContext("2d")!.drawImage(image,0,0);}
      if(cancelled||abort.signal.aborted)return;
      if(current.current.currentDoc()!==doc||current.current.bitmapRevision!==bitmapRevision||current.current.prompt!==prompt||current.current.character!==character)throw new Error("The image or instructions changed during recovery. Review them and retry placement recovery.");
      current.current.onRestore(doc,record,mask,saved.prompt);setError("");
    }catch(cause){if(!cancelled&&!abort.signal.aborted){failedAttempt.current=attempt;setError(`Placement not restored: ${(cause as Error).message}`);}}})();
    return()=>{cancelled=true;abort.abort();};
  },[key,scoped,saved,options.doc,options.bitmapRevision,options.manifest,options.enabled,options.placementId,attempt]);
  function clear(){writeEpoch.current++;remoteAbort.current?.abort();try{sessionStorage.removeItem(key);setSaved(null);setError("");attempted.current="";attemptedDoc.current=null;failedAttempt.current=null;}catch{setSaved(null);setError("The placement draft could not be cleared from browser storage. A saved copy may return after reload.");}clearRemote();}
  return {error,clear,retry:()=>setAttempt(value=>value+1)};
}
