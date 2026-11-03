import {useEffect,useState,type ReactNode} from "react";
import {Block,ResultGrid,ResultTile} from "../ds";
import {POOL_VIDEOS} from "./reels";
import {LOAD_TURN} from "./reload-turn";

/* Example media (the placeholder set) under a tool's own runs: clips play in a muted loop, pictures sit still. Clearly labelled, following the latest runs in the same grid. */
export function ExampleTiles({kind,count,leading,leadingCount=0,videoSources}:{kind:"video"|"image";count?:number;leading?:ReactNode;leadingCount?:number;videoSources?:readonly string[]}){
  const [pictures,setPictures]=useState<string[]>([]);
  useEffect(()=>{let current=true;if(kind==="image")fetch("/examples/pool.json").then(r=>r.ok?r.json():{images:[]}).then((p:{images?:string[]})=>{if(current&&Array.isArray(p.images))setPictures(p.images.map(f=>`/examples/${f}`));}).catch(()=>{});return()=>{current=false;};},[kind]);
  const all=kind==="video"?videoSources??POOL_VIDEOS:pictures,cut=all.length?LOAD_TURN%all.length:0,sources=all.slice(cut).concat(all.slice(0,cut));
  if(!sources.length&&!leadingCount)return null;
  return <Block label="Examples"><ResultGrid count={leadingCount+Math.min(count??sources.length,sources.length)} aspect={0} label="Results and examples">{leading}{sources.slice(0,count??sources.length).map(src=><div key={src} draggable onDragStart={event=>{event.dataTransfer.setData("application/x-comfyfield-example",src);event.dataTransfer.effectAllowed="copy";}}><ResultTile caption="Example">{kind==="video"?<video src={src} muted loop autoPlay playsInline preload="metadata" aria-hidden/>:<img draggable={false} loading="lazy" src={src} alt=""/>}</ResultTile></div>)}</ResultGrid></Block>;
}
