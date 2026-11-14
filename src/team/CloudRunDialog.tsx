import {Button,Dialog,Meta} from "../ds";

export const CLOUD_PLAN_LINE="Comfy Cloud workflows need a paid Comfy plan. Comfy Router models (FLUX, Seedance, Kling) run on your credits on any plan.";
export type CloudRunDialogKind="consent"|"plan-required";

/** Selecting Cloud first explains its use of credits. */
export function CloudRunConsent({onUse,onKeep,keepLabel="Keep local"}:{onUse:()=>void;onKeep:()=>void;keepLabel?:string}){
  return <Dialog open title="Use Comfy Cloud?" onClose={onKeep} footer={<>
    <Button variant="ghost" onClick={onKeep}>{keepLabel}</Button>
    <Button variant="primary" onClick={onUse}>Use Comfy Cloud</Button>
  </>}><Meta>Cloud runs use your Comfy Cloud credits.</Meta></Dialog>;
}

export function CloudRunDialog({kind,onUse,onKeep,onClose,keepLabel}:{kind:CloudRunDialogKind;onUse:()=>void;onKeep:()=>void;onClose:()=>void;keepLabel?:string}){
  if(kind==="consent")return <CloudRunConsent onUse={onUse} onKeep={onKeep} keepLabel={keepLabel}/>;
  return <Dialog open title="Comfy Cloud plan" onClose={onClose}
    footer={<Button variant="primary" onClick={onClose}>Keep using Router</Button>}>
    <Meta>{CLOUD_PLAN_LINE}</Meta>
  </Dialog>;
}
