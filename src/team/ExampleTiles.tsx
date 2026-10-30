import {useEffect,useState} from "react";
import {Block,ResultGrid,ResultTile} from "../ds";
import {POOL_VIDEOS} from "./reels";
import {LOAD_TURN} from "./reload-turn";

/* Example media (the placeholder set) under a tool's own runs: clips play in a muted loop, pictures sit still. Clearly labelled, never mixed into the runs. */
export function ExampleTiles({kind,count}:{kind:"video"|"image";count?:number}){
  const [pictures,setPictures]=useState<string[]>([]);
  useEffect(()=>{let current=true;if(kind==="image")fetch("/examples/pool.json").then(r=>r.ok?r.json():{images:[]}).then((p:{images?:string[]})=>{if(current&&Array.isArray(p.images))setPictures(p.images.map(f=>`/examples/${f}`));}).catch(()=>{});return()=>{current=false;};},[kind]);
  const all=kind==="video"?POOL_VIDEOS:pictures,cut=all.length?LOAD_TURN%all.length:0,sources=all.slice(cut).concat(all.slice(0,cut));
  if(!sources.length)return null;
  return <Block label="Examples"><ResultGrid count={count??sources.length} aspect={0} label="Examples">{sources.slice(0,count??sources.length).map(src=><ResultTile key={src} caption="Example">{kind==="video"?<video src={src} muted loop autoPlay playsInline preload="metadata" aria-hidden/>:<img loading="lazy" src={src} alt=""/>}</ResultTile>)}</ResultGrid></Block>;
}
