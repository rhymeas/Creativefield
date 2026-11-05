import {useEffect,useState,type ReactNode} from "react";
import {Block,MediaViewer,ResultGrid,ResultTile} from "../ds";
import {OPENJUTSU_SHOWCASE,POOL_VIDEOS} from "./reels";
import {LOAD_TURN} from "./reload-turn";

/* Example media (the placeholder set) under a tool's own runs: clips play in a muted loop, pictures sit still. Clearly labelled, following the latest runs in the same grid. */
export function ExampleTiles({kind,count,leading,leadingCount=0,videoSources,imageSources,caption="Example"}:{kind:"video"|"image";count?:number;leading?:ReactNode;leadingCount?:number;videoSources?:readonly string[];imageSources?:readonly string[];caption?:string}){
  const [pictures,setPictures]=useState<string[]>([]);
  useEffect(()=>{let current=true;if(kind==="image")fetch("/examples/pool.json").then(r=>r.ok?r.json():{images:[]}).then((p:{images?:string[]})=>{if(current&&Array.isArray(p.images))setPictures(p.images.map(f=>`/examples/${f}`));}).catch(()=>{});return()=>{current=false;};},[kind]);
  const all=kind==="video"?videoSources??POOL_VIDEOS:imageSources??pictures;
  const showcases=all.some(src=>OPENJUTSU_SHOWCASE.some(item=>item.result===src))?OPENJUTSU_SHOWCASE.map(item=>item.result):[];
  const others=all.filter(src=>!showcases.includes(src)),cut=others.length?LOAD_TURN%others.length:0,sources=[...showcases,...others.slice(cut),...others.slice(0,cut)];
  if(!sources.length&&!leadingCount)return null;
  return <Block label="Examples"><ResultGrid count={leadingCount+Math.min(count??sources.length,sources.length)} aspect={0} label="Results and examples">{leading}{sources.slice(0,count??sources.length).map(src=><ExampleTile key={src} src={src} kind={kind} caption={caption}/>)}</ResultGrid></Block>;
}

/** A missing example is skipped for this view; a later visit retries it. */
function ExampleTile({src,kind,caption}:{src:string;kind:"image"|"video";caption:string}){
  const [failed,setFailed]=useState(false);
  if(failed)return null;
  return <div draggable onDragStart={event=>{event.dataTransfer.setData("application/x-comfyfield-example",src);event.dataTransfer.effectAllowed="copy";}} onErrorCapture={event=>{const target=event.target as HTMLElement;if((target.tagName==="IMG"||target.tagName==="VIDEO")&&target.getAttribute("src")===src)setFailed(true);}}>{OPENJUTSU_SHOWCASE.some(item=>item.result===src)?<ShowcaseTile src={src}/>:<ResultTile caption={caption}>{kind==="video"?<video src={src} muted loop autoPlay playsInline preload="metadata" aria-hidden/>:<img draggable={false} loading="lazy" src={src} alt=""/>}</ResultTile>}</div>;
}

function ShowcaseTile({src}:{src:string}){
  const [open,setOpen]=useState(false);
  const example=OPENJUTSU_SHOWCASE.find(item=>item.result===src)!;
  return <><ResultTile caption="OpenJutsu example" onOpen={()=>setOpen(true)}><video src={src} muted loop autoPlay playsInline preload="metadata" aria-hidden/></ResultTile>
    <MediaViewer open={open} src={src} name={`OpenJutsu example ${example.number}`} mediaType="video" onClose={()=>setOpen(false)} info={<>
      <h3>How it was made</h3><p>Character swap with MiniMax H3 and OpenJutsu. The source performance, camera and setting guide the result.</p>
      <p><strong>Original video</strong></p><video src={example.original} controls playsInline preload="metadata" style={{width:"100%",maxHeight:200}}/>
      <p><strong>Prepared input to the workflow</strong></p><video src={example.source} controls playsInline preload="metadata" style={{width:"100%",maxHeight:200}}/>
      <p><strong>Character reference</strong></p><img src={example.character} alt={`Character reference ${example.number}`} style={{width:"100%",maxHeight:200,objectFit:"contain"}}/>
      <p><strong>Workflow</strong><br/>10-second prepared reference → H3 character swap → 2× Lanczos resize.</p>
      <p><strong>Prompt</strong><br/>Replace the person in &lt;Video 1&gt; with the fantasy character in &lt;Picture 1&gt;. Clearly reproduce the character face, skin colour, hair and complete costume from the picture. Preserve the video performance, body motion, camera and background.</p>
      <p><strong>Settings</strong><br/>480p generation · 8 steps · CFG 1 · 24 fps</p>
      {example.number===2&&<p>The shorter source was slowed to fill 10 seconds; the final frames were extended.</p>}
    </>}/></>;
}
