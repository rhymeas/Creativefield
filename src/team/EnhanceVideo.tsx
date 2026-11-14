/* Enhance video: one tool instead of one workspace per finishing pack. The person picks a step per row
   (Upscale: Fast or Best; Smooth motion: 2x) and the ready packs behind each choice run one after the
   other on the server, each an unchanged workflow. Which pack stands behind a choice is the manifests'
   `finishStep` (src/capabilities/finish-steps.ts); this screen names no pack. */
import {useMemo,useState,type ComponentProps} from "react";
import {Film,Maximize2} from "lucide-react";
import {Meta,ParamButton,Params} from "../ds";
import {chainLine,finishRows,planFinish,type FinishChoice,type FinishRow} from "../capabilities/finish-steps";
import type {CapabilityManifestV2} from "../capabilities/types";
import {TeamComposer,type ComposerFinish} from "./TeamComposer";

const ROW_TITLES:Record<string,string>={upscale:"Upscale",interpolate:"Smooth motion"};
/** The button shows the row in one short word, so two buttons fit side by side. */
const ROW_SHORT:Record<string,string>={interpolate:"Smooth"};
const ROW_ICONS:Record<string,typeof Maximize2>={upscale:Maximize2,interpolate:Film};
const OFF="off";
const optionLabel=(option:string)=>option===OFF?"Off":option.charAt(0).toUpperCase()+option.slice(1);
const storageKey=(userId:string)=>`comfyfield:enhance:${userId}`;

function readChoice(userId:string,rows:FinishRow[]):FinishChoice{
  try{const saved=JSON.parse(localStorage.getItem(storageKey(userId))??"null") as FinishChoice|null;if(saved&&typeof saved==="object")return saved;}catch{/* A fresh choice below. */}
  /* A first visit upscales with the first ready option and leaves the rest off. */
  const upscale=rows.find(row=>row.step==="upscale")??rows[0];
  return upscale?{[upscale.step]:upscale.options[0]?.option}:{};
}

type ComposerProps=Omit<ComponentProps<typeof TeamComposer>,"manifest"|"finish"|"workflowIds"|"modelChoice"|"initialInputs">;

/** `screen` is the resolved Enhance screen: the ready finishing packs and an optional clip from the link. */
export function EnhanceVideo({screen:{packs,assetId},...composer}:{screen:{packs:CapabilityManifestV2[];assetId?:string}}&ComposerProps){
  const rows=useMemo(()=>finishRows(packs),[packs]);
  const [choice,setChoiceState]=useState<FinishChoice>(()=>readChoice(composer.user.id,rows));
  const setChoice=(step:string,option:string)=>setChoiceState(old=>{
    const next={...old,[step]:option};
    try{localStorage.setItem(storageKey(composer.user.id),JSON.stringify(next));}catch{/* The choice still holds for this visit. */}
    return next;
  });
  const steps=useMemo(()=>planFinish(choice,packs),[choice,packs]);
  /* The composer shows the first step's pack: its input, readiness and worker are what Generate needs first. */
  const lead=packs.find(pack=>pack.id===steps[0]?.capabilityId)??packs.find(pack=>pack.id===rows[0]?.options[0]?.pack)??packs[0];
  const silent=steps.filter(step=>!packs.find(pack=>pack.id===step.capabilityId)?.audioPolicies.includes("preserve"));
  const standIn=steps.filter(step=>step.fallback);
  const finish:ComposerFinish={
    title:"Enhance video",
    subtitle:steps.length?chainLine(steps):"Choose a step below",
    params:<>
      <Params>{rows.map(row=>{
        const Icon=ROW_ICONS[row.step]??Maximize2,value=choice[row.step]&&row.options.some(option=>option.option===choice[row.step])?choice[row.step]!:OFF;
        const options=[{value:OFF,label:"Off"},...row.options.map(option=>({value:option.option,label:optionLabel(option.option)}))];
        return <ParamButton key={row.step} title={ROW_TITLES[row.step]??optionLabel(row.step)} icon={<Icon size={16}/>}
          label={`${ROW_SHORT[row.step]??ROW_TITLES[row.step]??optionLabel(row.step)}: ${optionLabel(value)}`} value={value} options={options} onChange={next=>setChoice(row.step,next)}/>;
      })}</Params>
      {steps.length>1&&<Meta>{`Runs ${chainLine(steps)}`}</Meta>}
      {silent.length>0&&<Meta>{`${silent.map(step=>ROW_TITLES[step.step]??step.label).join(" and ")} drops the sound`}</Meta>}
      {standIn.length>0&&<Meta>{`${standIn.map(step=>step.label).join(", ")} stands in: the preferred pack is not ready here`}</Meta>}
    </>,
    request:()=>{
      const [first,...rest]=steps;
      const pack=first&&packs.find(item=>item.id===first.capabilityId);
      if(!first||!pack)return undefined;
      return {capabilityId:pack.id,version:pack.version,controls:first.controls,audioPolicy:pack.audioPolicies.includes("preserve")?"preserve":pack.audioPolicies[0]??"mute",
        finish:rest.map(({capabilityId,controls})=>({capabilityId,controls}))};
    },
  };
  if(!lead)return null;
  /* The info button explains every step that will run, not only the first pack. */
  const info=<>{steps.map(step=>{const pack=packs.find(item=>item.id===step.capabilityId);return pack?<Meta key={step.capabilityId}>{`${step.label}: ${pack.description}`}</Meta>:null;})}</>;
  return <TeamComposer {...composer} workflowInfo={info} manifest={lead} workflowIds={[lead.id]} finish={finish} initialInputs={assetId?{source_video:assetId}:undefined}/>;
}
