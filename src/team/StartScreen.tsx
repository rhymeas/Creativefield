import {useEffect,useState} from "react";
import type {ReactNode} from "react";
import {Block,Button,EmptyState,Hero,RotatingVideo,PresetCard,PresetGrid,SearchField,SectionHeader,Toolbar } from "../ds";
import {Box,Brush,Clapperboard,Film,Footprints,ImagePlus,Maximize2,MessageCircle,Palette,RotateCw,Shapes,UserRound,UserRoundPen} from "lucide-react";
import {POOL_VIDEOS} from "./reels";
import {LOAD_TURN} from "./reload-turn";
import {START_GROUPS,matchTasks,startTasks,type StartNeed,type StartTask,type StartTaskId} from "./start-tasks";

const ICONS:Record<StartTaskId,ReactNode>={
  "swap-person":<UserRoundPen size={20}/>,"copy-moves":<Footprints size={20}/>,"new-look":<Palette size={20}/>,"swap-thing":<Shapes size={20}/>,
  sharpen:<Maximize2 size={20}/>,video:<Film size={20}/>,film:<Clapperboard size={20}/>,picture:<ImagePlus size={20}/>,"fix-picture":<Brush size={20}/>,angles:<RotateCw size={20}/>,
  character:<UserRound size={20}/>,talk:<MessageCircle size={20}/>,model3d:<Box size={20}/>,
};

/** "All tools": one card per task this computer can run, each opening its screen directly. Search narrows by name and line.
    A task with its own workflow opens the composer on that workflow through `onOpen`. */
export function StartScreen({ready,onOpen}:{ready:Partial<Record<StartNeed,boolean>>;onOpen?:(task:StartTask)=>void}){
  const [query,setQuery]=useState("");
  /* Example pictures are dropped into public/examples and listed in its index.json ({"video": "video.webp"}): no code change per picture. */
  const [examples,setExamples]=useState<Record<string,string>>({}),[pool,setPool]=useState<string[]>([]);
  useEffect(()=>{let current=true;fetch("/examples/pool.json").then(r=>r.ok?r.json():{images:[]}).then((p:{images?:string[]})=>{if(current&&Array.isArray(p?.images))setPool(p.images.map((f:string)=>`/examples/${f}`));}).catch(()=>{});return()=>{current=false;};},[]);
  useEffect(()=>{let current=true;fetch("/examples/index.json").then(r=>r.ok?r.json():{}).then(map=>{if(current&&map&&typeof map==="object")setExamples(map as Record<string,string>);}).catch(()=>{});return()=>{current=false;};},[]);
  const shown=matchTasks(startTasks(ready),query);
  return <div className="cf-start">
    <Hero stage accent="Free." title="Create. Free. On your computer." text="Edit photos in FotoField, make video, images and 3D. Open source, powered by ComfyUI, nothing leaves your machine." media={<RotatingVideo srcs={[POOL_VIDEOS[LOAD_TURN%POOL_VIDEOS.length]]}/>}/>
    <Toolbar end={<SearchField label="Search tools" value={query} onChange={setQuery} placeholder="Search tools"/>}>
      <SectionHeader title="All tools" large/>
    </Toolbar>
    {shown.length===0?<EmptyState title="No tool matches." action={<Button variant="ghost" onClick={()=>setQuery("")}>Clear search</Button>}/>:
    <div className="cf-start__tools">{START_GROUPS.map(group=>{
        const tasks=shown.filter(t=>t.group===group);
        return tasks.length>0?<Block key={group} label={group}>
          <PresetGrid label={group}>
            {tasks.map(t=>{const at=shown.indexOf(t),turn=pool.length?pool.slice((at*3+LOAD_TURN)%pool.length).concat(pool.slice(0,(at*3+LOAD_TURN)%pool.length)):[],own=examples[t.id]?`/examples/${examples[t.id]}`:t.thumb;return <PresetCard key={t.id} size="tool" featured={t.featured} thumb={own??turn[0]} thumbs={turn} label={t.label} hint={t.text} icon={ICONS[t.id]} onSelect={()=>{if(onOpen)onOpen(t);else location.hash=t.href.slice(1);}}/>;})}
          </PresetGrid>
        </Block>:null;
      })}</div>}
  </div>;
}
