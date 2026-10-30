import {useCallback,useEffect,useState,type ReactNode} from "react";
import {ChevronRight} from "lucide-react";
import {ChoiceDialog,Dialog,EmptyState,Meta,ModelCard,Pill,Row,SearchField,Thumb,ThumbGrid,type ChoiceOption,type OptionStatus} from "../ds";
import {friendlyMediaName} from "./media-names";
import "./pick.css";

export type TeamChoiceOption={value:string;label:string;note?:string;disabled?:boolean;status?:OptionStatus;detail?:ReactNode;/** The picture or symbol at the start of the box. */icon?:ReactNode;preview?:{src:string;video?:boolean}};
/** Existing studio triggers and selection surfaces; never a browser-native select. `prefix` writes the quiet label before the value; turn it off when the value is the whole action. `size` is the pill height (`lg` for a full label like "Choose from library"). */
/** A choice as the design system's box: its own symbol, or its small picture. */
const toChoice=(o:TeamChoiceOption):ChoiceOption=>({value:o.value,label:o.label,note:o.note,status:o.status,detail:o.detail,disabled:o.disabled,icon:o.icon??(o.preview?(o.preview.video?<video src={o.preview.src} muted playsInline preload="metadata"/>:<img src={o.preview.src} alt="" loading="lazy"/>):undefined)});
export function TeamChoice({label,display,value,options,onChange,disabled=false,variant="row",size="md",prefix=true,subtitle,video,openSignal=0}:{label:string;display:string;value:string;options:TeamChoiceOption[];onChange:(value:string)=>void;disabled?:boolean;variant?:"row"|"model"|"pill";size?:"md"|"lg";prefix?:boolean;subtitle?:string;video?:string;openSignal?:number}){
  const [open,setOpen]=useState(false),close=useCallback(()=>setOpen(false),[]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useEffect(()=>{if(openSignal>0&&!disabled)setOpen(true);},[openSignal,disabled]);
  const choose=(option:TeamChoiceOption)=>{if(disabled||option.disabled)return;onChange(option.value);close();};
  // Media choices are picked by looking at them: a picture grid with plain names instead of a list of file names.
  const visual=options.length>0&&options.every(o=>o.preview),[query,setQuery]=useState("");
  const shown=visual&&query.trim()?options.filter(o=>`${o.label} ${friendlyMediaName(o.label)}`.toLowerCase().includes(query.trim().toLowerCase())):options;
  return <>
    {variant==="model"?<ModelCard title={display} subtitle={subtitle??"Local ComfyUI"} video={video} onChange={disabled?undefined:()=>setOpen(true)}/>:variant==="pill"?<Pill quiet size={size} type="button" disabled={disabled} aria-label={prefix?label:undefined} onClick={()=>setOpen(true)}>{prefix&&<span className="ds-pill__prefix">{label}</span>}{display}<ChevronRight size={14}/></Pill>:<Row label={label} display={display} disabled={disabled} onClick={()=>setOpen(true)}/>}
    {visual||!options.length
      ?<Dialog wide={visual} open={open&&!disabled} title={label} onClose={close}>
        {visual?<div className="cf-form">
          {options.length>12&&<SearchField label={`Search ${label.toLowerCase()}`} value={query} onChange={setQuery} placeholder="Search by name"/>}
          {shown.length?<ThumbGrid label={label}>{shown.map(o=><div key={o.value} className="cf-pick" onMouseEnter={e=>void e.currentTarget.querySelector("video")?.play().catch(()=>{})} onMouseLeave={e=>{const v=e.currentTarget.querySelector("video");if(v){v.pause();v.currentTime=0;}}}>
            <Thumb src={o.preview!.src} video={o.preview!.video} label={friendlyMediaName(o.label)} selected={o.value===value} disabled={o.disabled} onSelect={()=>choose(o)} info={<>{o.label}{o.note&&<><br/>{o.note}</>}</>}/>
            <Meta>{friendlyMediaName(o.label)}</Meta>
          </div>)}</ThumbGrid>:<EmptyState title="Nothing matches" text="Try another word."/>}
        </div>:<EmptyState title="No choices available" text="Add a compatible resource to this workspace first."/>}
      </Dialog>
      :<ChoiceDialog open={open&&!disabled} title={label} value={value} options={options.map(toChoice)} onPick={picked=>{const option=options.find(o=>o.value===picked);if(option)choose(option);}} onClose={close}/>}
  </>;
}
