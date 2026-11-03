import {useEffect,useRef,useState} from "react";
import {Button,Collapsible,Meta,Notice,PromptField,Toolbar} from "../ds";
import type {CapabilityManifestV2} from "../capabilities/types";
import {type Call} from "../team/api";
import type {ImageDraft} from "./image-state";
import {hasUnresolvedLegacyPhotoset,identityPhotosetCanResume,identityPhotosetDrafts,identityPhotosetStorageKey,readIdentityPhotoset,submitIdentityPhotoset,type IdentityPhotosetRecipe as Recipe} from "./identity-photoset";

type Props={variant?:"character"|"remix";manifest:CapabilityManifestV2;draft:ImageDraft;workspaceId:string;projectId:string;userId:string;workerId:string;allowed:boolean;disabled:boolean;call:Call;onChanged:()=>void;onBusy:(busy:boolean)=>void};
export function IdentityPhotoset({variant="character",manifest,draft,workspaceId,projectId,userId,workerId,allowed,disabled,call,onChanged,onBusy}:Props){
  const key=identityPhotosetStorageKey({userId,workspaceId,projectId,model:manifest.id},variant);
  const [recipe,setRecipe]=useState<Recipe|null>(()=>{try{return readIdentityPhotoset(sessionStorage.getItem(key),{userId,workspaceId,projectId,model:manifest.id});}catch{return null;}});
  const [legacyPending]=useState(()=>{if(variant!=="remix")return false;try{return hasUnresolvedLegacyPhotoset(sessionStorage.getItem(identityPhotosetStorageKey({userId,workspaceId,projectId,model:manifest.id},"character")),{userId,workspaceId,projectId,model:manifest.id});}catch{return true;}});
  const [text,setText]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const stop=useRef(false),submitting=useRef(false),mounted=useRef(true);
  useEffect(()=>()=>{mounted.current=false;stop.current=true;onBusy(false);},[]);
  function persist(value:Recipe){sessionStorage.setItem(key,JSON.stringify(value));if(mounted.current)setRecipe(value);}
  async function queue(){
    if(submitting.current||disabled||!allowed||!workerId||(legacyPending&&!recipe)||(recipe&&!identityPhotosetCanResume(recipe,workerId,manifest.version)))return;
    submitting.current=true;stop.current=false;setBusy(true);onBusy(true);setError("");
    try{
      let current=recipe??{id:crypto.randomUUID(),workspaceId,projectId,userId,workerId,model:manifest.id,version:manifest.version,drafts:identityPhotosetDrafts(manifest,draft,text),accepted:{}};
      persist(current);
      await submitIdentityPhotoset(current,manifest,call,persist,()=>stop.current,onChanged);
    }catch(e){if(mounted.current)setError(`${(e as Error).message} The same request can be retried without creating duplicate runs.`);}
    finally{submitting.current=false;if(mounted.current){setBusy(false);onBusy(false);}}
  }
  const count=recipe?Object.keys(recipe.accepted).length:0,complete=!!recipe&&count===recipe.drafts.length;
  const needsOriginal=!!recipe&&!complete&&!identityPhotosetCanResume(recipe,workerId,manifest.version);
  return <Collapsible title={variant==="remix"?"Image variations":"Character photoset"}><Meta>Enter two to eight variations, one per line. Each uses the same source and references with the prompt above. Results appear in the gallery.</Meta>
    {legacyPending&&!recipe&&<Notice inline title="Previous submission needs attention">Open the Character photoset in Image and resolve its uncertain submission before starting new variations.</Notice>}
    {needsOriginal&&<Notice inline title="Return to the original setup">Switch back to the ComfyUI installation and workflow version used for this photoset to continue it safely.</Notice>}
    {!allowed&&<Notice inline title="Photoset unavailable">Photosets require this computer's single-user GPU queue.</Notice>}
    {!recipe&&<PromptField label="Variations" placeholder={variant==="remix"?"A blue jacket in a bright studio\nA red jacket outdoors":"In a studio, wearing a coat\nWalking outdoors, casual clothes"} value={text} onChange={setText} disabled={busy||disabled}/>}
    {recipe&&<Meta>{count} of {recipe.drafts.length} requests submitted. Submitted runs can be canceled individually in the gallery.</Meta>}
    {error&&<Notice inline priority={60} title="Photoset submission paused">{error}</Notice>}
    <Toolbar>{!complete&&<Button variant="secondary" disabled={!allowed||disabled||busy||!workerId||needsOriginal||(legacyPending&&!recipe)} onClick={()=>void queue()}>{recipe?(variant==="remix"?"Continue variations":"Continue photoset"):(variant==="remix"?"Generate variations":"Generate photoset")}</Button>}{busy&&<Button variant="secondary" onClick={()=>{stop.current=true;}}>Stop adding runs</Button>}{recipe&&!busy&&recipe.pending===undefined&&<Button variant="ghost" onClick={()=>{sessionStorage.removeItem(key);setRecipe(null);setError("");}}>{variant==="remix"?"New variations":"New photoset"}</Button>}</Toolbar>
  </Collapsible>;
}
