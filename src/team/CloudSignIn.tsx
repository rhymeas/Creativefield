import {useState} from "react";
import {Button,Dialog,LinkButton,Meta,TextField} from "../ds";
import {ApiError,storeCloudKey,workspacePath,type Call} from "./api";

/** The Comfy account behind a key, as the server reads it (name, email, workspace, credits). */
export type CloudAccountFacts={connected:boolean;name?:string;email?:string;workspace?:string;credits?:number;canSubmit?:boolean;addCreditsUrl?:string;reason?:string};

/* A guest tab that was out of date is resynced and remounted; the dialog then opens again on its own. */
const REOPEN="creativefield.cloud-sign-in-again";
export function reopenCloudSignIn():boolean{try{const again=sessionStorage.getItem(REOPEN)==="1";sessionStorage.removeItem(REOPEN);return again;}catch{return false;}}

/** Where Comfy hands out API keys. */
const KEYS_URL="https://platform.comfy.org/profile/api-keys";

/* Sign in with your own Comfy Cloud API key. The server checks it with Comfy's account read (no job,
   no credits) and only holds it in memory; this browser keeps it, so renders here run on that account. */
export function CloudSignIn({workspaceId,call,onClose,onSignedIn}:{workspaceId:string;call:Call;onClose:()=>void;onSignedIn:(account:CloudAccountFacts)=>void|Promise<void>}){
  const [key,setKey]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function submit(){
    const value=key.trim();if(!value||busy)return;
    setBusy(true);setError("");
    try{const account=await call<CloudAccountFacts>(workspacePath(workspaceId,"cloud-key"),"POST",{key:value});storeCloudKey(value);await onSignedIn(account);}
    catch(e){const stale=e instanceof ApiError&&(e.status===401||e.status===403);if(stale)try{sessionStorage.setItem(REOPEN,"1");}catch{/* storage may be unavailable */}setError(stale?"This tab was out of date and has been refreshed. Sign in again.":(e as Error).message);}
    finally{setBusy(false);}
  }
  return <Dialog open title="Use CreativeField with Comfy Cloud" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Not now</Button><Button variant="primary" disabled={busy||!key.trim()} onClick={()=>void submit()}>{busy?"Checking…":"Sign in"}</Button></>}>
    <form onSubmit={event=>{event.preventDefault();void submit();}}>
      <TextField label="Comfy Cloud API key" type="password" autoComplete="off" autoFocus value={key} onChange={setKey} error={error||undefined}
        hint="The key stays in this browser. Renders run on your Comfy Cloud account and use its credits."/>
    </form>
    <Meta>No account yet? Create one and a key at Comfy, then paste the key here.</Meta>
    <LinkButton variant="ghost" href={KEYS_URL} target="_blank" rel="noreferrer">Get an API key</LinkButton>
  </Dialog>;
}
