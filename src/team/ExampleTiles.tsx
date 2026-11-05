import {useEffect,useState,type ReactNode} from "react";
import {Block,MediaViewer,MediaViewerInfo,ResultGrid,ResultTile} from "../ds";
import {LOW_PRIORITY_EXAMPLES,OPENJUTSU_SHOWCASE,POOL_VIDEOS} from "./reels";
import {LOAD_TURN} from "./reload-turn";
import {useRecreateMedia} from "./recreate";

/* Example media (the placeholder set) under a tool's own runs: clips play in a muted loop, pictures sit still. Clearly labelled, following the latest runs in the same grid. */
export function ExampleTiles({kind,count,leading,leadingCount=0,videoSources,imageSources,caption="Example"}:{kind:"video"|"image";count?:number;leading?:ReactNode;leadingCount?:number;videoSources?:readonly string[];imageSources?:readonly string[];caption?:string}){
  const [pictures,setPictures]=useState<string[]>([]);
  useEffect(()=>{let current=true;if(kind==="image")fetch("/examples/pool.json").then(r=>r.ok?r.json():{images:[]}).then((p:{images?:string[]})=>{if(current&&Array.isArray(p.images))setPictures(p.images.map(f=>`/examples/${f}`));}).catch(()=>{});return()=>{current=false;};},[kind]);
  const all=kind==="video"?videoSources??POOL_VIDEOS:imageSources??pictures;
  const showcases=all.some(src=>OPENJUTSU_SHOWCASE.some(item=>item.result===src))?OPENJUTSU_SHOWCASE.map(item=>item.result):[];
  /* OpenJutsu first, then the good examples taking turns at the top on each visit, and the early test clips always last. */
  const others=all.filter(src=>!showcases.includes(src)&&!LOW_PRIORITY_EXAMPLES.includes(src)),late=all.filter(src=>!showcases.includes(src)&&LOW_PRIORITY_EXAMPLES.includes(src));
  const cut=others.length?LOAD_TURN%others.length:0,sources=[...showcases,...others.slice(cut),...others.slice(0,cut),...late];
  if(!sources.length&&!leadingCount)return null;
  return <Block label="Examples"><ResultGrid count={leadingCount+Math.min(count??sources.length,sources.length)} aspect={0} label="Results and examples">{leading}{sources.slice(0,count??sources.length).map(src=><ExampleTile key={src} src={src} kind={kind} caption={caption}/>)}</ResultGrid></Block>;
}

/** A missing example is skipped for this view; a later visit retries it. */
function ExampleTile({src,kind,caption}:{src:string;kind:"image"|"video";caption:string}){
  const [failed,setFailed]=useState(false);
  const recreate=useRecreateMedia()({example:{src,name:src.split("/").pop()??`example.${kind==="image"?"png":"mp4"}`,kind}});
  if(failed)return null;
  return <div draggable onDragStart={event=>{event.dataTransfer.setData("application/x-comfyfield-example",src);event.dataTransfer.effectAllowed="copy";}} onErrorCapture={event=>{const target=event.target as HTMLElement;if((target.tagName==="IMG"||target.tagName==="VIDEO")&&target.getAttribute("src")===src)setFailed(true);}}>{OPENJUTSU_SHOWCASE.some(item=>item.result===src)?<ShowcaseTile src={src}/>:<ResultTile caption={caption} onRecreate={recreate?()=>void recreate():undefined}>{kind==="video"?<video src={src} muted loop autoPlay playsInline preload="metadata" aria-hidden/>:<img draggable={false} loading="lazy" src={src} alt=""/>}</ResultTile>}</div>;
}

const PROMPT="Replace the person in <Video 1> with the fantasy character in <Picture 1>. Clearly reproduce the character face, skin colour, hair and complete costume from the picture. Preserve the video performance, body motion, camera and background.";

function ShowcaseTile({src}:{src:string}){
  const [open,setOpen]=useState(false);
  const example=OPENJUTSU_SHOWCASE.find(item=>item.result===src)!;
  const recreate=useRecreateMedia()({capabilityId:"openjutsu-h3-swap",inputs:{source_video:{src:example.source,name:`openjutsu-example-${example.number}-source.mp4`},character_image:{src:example.character,name:`openjutsu-example-${example.number}-character.png`}},controls:{prompt:PROMPT}});
  return <><ResultTile caption="OpenJutsu example" onOpen={()=>setOpen(true)} onRecreate={recreate?()=>void recreate():undefined}><video src={src} muted loop autoPlay playsInline preload="metadata" aria-hidden/></ResultTile>
    {/* The same column as every result's full view: mode, reference tiles, prompt, model and settings. */}
    <MediaViewer open={open} src={src} name={`OpenJutsu example ${example.number}`} mediaType="video" onClose={()=>setOpen(false)} onRecreate={recreate} info={<MediaViewerInfo mode="Character swap" model="MiniMax H3 · OpenJutsu"
      inputs={[{src:example.original,label:"Original video",video:true},{src:example.source,label:"Prepared input",video:true},{src:example.character,label:`Character reference ${example.number}`}]}
      prompt={PROMPT}
      facts={[{label:"Workflow",value:"10 s prepared reference → H3 swap → 2× resize"},{label:"Quality",value:"480p · 8 steps · CFG 1 · 24 fps"},...(example.number===2?[{label:"Length",value:"Source slowed to 10 s, last frames held"}]:[])]}/>}/></>;
}
