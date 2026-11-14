import {useState} from "react";
import {Block,Button,Dialog,FormSection,Meta} from "../ds";
import type {Worker} from "./api";
import {comfyStep,connectComfyAction,type Audience} from "./audience";

export const onboardingKey=(userId:string,workspaceId:string)=>`comfyfield.onboarding:v1:${userId}:${workspaceId}`;
export function onboardingDismissed(storage:Pick<Storage,"getItem">,key:string){try{return storage.getItem(key)==="dismissed";}catch{return false;}}
export function saveOnboarding(storage:Pick<Storage,"setItem"|"removeItem">,key:string,dismissed:boolean){try{if(dismissed)storage.setItem(key,"dismissed");else storage.removeItem(key);}catch{/* The guide remains usable when storage is unavailable. */}}

/** The four setup steps. Navigation only: no probes, downloads, connections or renders start automatically. */
export function GettingStartedSteps({admin,workers,onSettings,onModels,onDone,audience="team"}:{admin:boolean;workers:Worker[];onSettings:()=>void;onModels?:()=>void;onDone?:()=>void;/** Who is reading: the one person on this computer, or a shared workspace. */audience?:Audience}){
  const localReady=workers.some(w=>w.enabled&&w.inventory?.online&&(w as Worker&{kind?:string}).kind!=="cloud"&&!/^https:\/\/cloud\.comfy\.org\/?$/.test(w.origin));
  const go=(hash:string)=>()=>{location.hash=hash;onDone?.();};
  const step=comfyStep(audience,localReady);
  /* In a shared workspace only an admin can connect ComfyUI; the one person on this PC always can. */
  const canConnect=audience==="solo"||admin;
  return <div className="cf-onboarding">
      <Block><FormSection title="1. Choose your project"><Meta>Keep inputs and results together. Switch projects from the top bar.</Meta><Button variant="secondary" onClick={go("projects")}>Projects</Button></FormSection></Block>
      <Block><FormSection title={step.title}><Meta>{step.text}</Meta>{canConnect&&<Button variant="secondary" onClick={()=>{onSettings();onDone?.();}}>{connectComfyAction(audience)}</Button>}</FormSection></Block>
      <Block><FormSection title="3. Check workflow requirements"><Meta>Models lists the required nodes and models. A connected worker may still need dependencies.</Meta><Button variant="secondary" onClick={()=>{if(onModels)onModels();else location.hash="catalogue";onDone?.();}}>Models</Button></FormSection></Block>
      <Block><FormSection title="4. Choose a tool"><Meta>Close setup, choose a tool and review its inputs before Generate. Cloud is optional; provider access and charges apply.</Meta></FormSection></Block>
    </div>;
}

/** Setup is opened explicitly from the All tools header; its steps live only in the modal. */
export function GettingStarted({admin,workers,onSettings,onModels,audience}:{userId:string;workspaceId:string;admin:boolean;workers:Worker[];onSettings:()=>void;onModels?:()=>void;/** Omit to use the account's own mode. */audience?:Audience}){
  const [open,setOpen]=useState(false);
  const close=()=>setOpen(false);
  return <>
    <Button variant="secondary" onClick={()=>setOpen(true)}>Workspace setup</Button>
    <Dialog open={open} title="Workspace setup" onClose={close} footer={<Button variant="primary" onClick={close}>Done</Button>}>
      <GettingStartedSteps admin={admin} workers={workers} onSettings={onSettings} onModels={onModels} onDone={close} audience={audience}/>
    </Dialog>
  </>;
}
