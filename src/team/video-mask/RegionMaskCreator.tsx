import {useCallback,useState,type ComponentProps} from "react";
import {Notice,SegmentedTabs} from "../../ds";
import type {CapabilityManifestV2} from "../../capabilities/types";
import {workerReadiness} from "../state";
import {MaskCreator} from "./MaskCreator";

/** Both targets retain the existing durable tracking and explicit review flow. */
export function RegionMaskCreator({backgroundManifest,pointManifest,onBusyChange,...props}:ComponentProps<typeof MaskCreator>&{backgroundManifest?:CapabilityManifestV2;pointManifest?:CapabilityManifestV2}){
  const key=`comfyfield:tracking-target:v1:${props.userId}:${props.workspace.id}:${props.project.id}:${props.source.id}${props.storageScope?`:${props.storageScope}`:""}`;
  const [target,setTarget]=useState(()=>{try{const saved=sessionStorage.getItem(key);return saved==="background"&&backgroundManifest?"background":saved==="points"&&pointManifest?"points":"object";}catch{return "object";}}),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const reportBusy=useCallback((value:boolean)=>{setBusy(value);onBusyChange?.(value);},[onBusyChange]);
  const available=!!backgroundManifest&&props.workers.some(worker=>workerReadiness(backgroundManifest,worker).state==="ready");
  const background=target==="background"&&backgroundManifest;
  const points=target==="points"&&pointManifest,pointsAvailable=!!pointManifest&&props.workers.some(worker=>workerReadiness(pointManifest,worker).state==="ready");
  const items=[{id:"object",label:"Describe",disabled:busy||!props.canEdit},...(available||background?[{id:"background",label:"Background",disabled:busy||!props.canEdit}]:[]),...(pointsAvailable||points?[{id:"points",label:"Click object",disabled:busy||!props.canEdit}]:[])];
  return <>
    {items.length>1&&<SegmentedTabs quiet label="Area to edit" value={target} onChange={value=>{if(busy||!props.canEdit)return;setTarget(value);try{sessionStorage.setItem(key,value);setError("");}catch{setError("Keep this tab open: the selected tracking mode could not be saved.");}}} items={items}/>}
    {error&&<Notice inline tone="info" priority={20} title="This tab remembers the area">{error}</Notice>}
    <MaskCreator {...props} key={(points||background||props.manifest).id} manifest={points||background||props.manifest} preserveSubject={!!background} onBusyChange={reportBusy}/>
  </>;
}
