import {useEffect,useState} from "react";
import type {ReactNode} from "react";
import {Block,Button,EmptyState,Hero,RotatingVideo,PresetCard,PresetGrid,SearchField,SectionHeader,Toolbar } from "../ds";
import {Box,Brush,Camera,Clapperboard,Film,Flame,Footprints,ImagePlus,Maximize2,MessageCircle,Palette,RotateCw,Shapes,UserRound,UserRoundPen} from "lucide-react";
import {POOL_VIDEOS} from "./reels";
import {LOAD_TURN} from "./reload-turn";
import {START_GROUPS,matchTasks,type StartTask,type StartTaskId} from "./start-tasks";

const ICONS:Record<StartTaskId,ReactNode>={
  remix:<Palette size={20}/>,ad:<Camera size={20}/>,block:<Camera size={20}/>,"effect-clips":<Flame size={20}/>,"swap-person":<UserRoundPen size={20}/>,"copy-moves":<Footprints size={20}/>,"new-look":<Palette size={20}/>,"swap-thing":<Shapes size={20}/>,
  sharpen:<Maximize2 size={20}/>,video:<Film size={20}/>,film:<Clapperboard size={20}/>,filmstudio:<Clapperboard size={20}/>,picture:<ImagePlus size={20}/>,"fix-picture":<Brush size={20}/>,angles:<RotateCw size={20}/>,
  character:<UserRound size={20}/>,talk:<MessageCircle size={20}/>,model3d:<Box size={20}/>,
};

/** "All tools": one card per task this computer can run, each opening its screen directly. The start field narrows them
    by name and line.
    A task with its own workflow opens the composer on that workflow through `onOpen`. */
export function StartScreen({tools,onOpen,hosted=false}:{tools:StartTask[];onOpen?:(task:StartTask)=>void;hosted?:boolean}){
  const [query,setQuery]=useState("");
  /* Example pictures are dropped into public/examples and listed in its index.json ({"video": "video.webp"}): no code change per picture. */
  const [examples,setExamples]=useState<Record<string,string>>({}),[pool,setPool]=useState<string[]>([]);
  useEffect(()=>{let current=true;fetch("/examples/pool.json").then(r=>r.ok?r.json():{images:[]}).then((p:{images?:string[]})=>{if(current&&Array.isArray(p?.images))setPool(p.images.map((f:string)=>`/examples/${f}`));}).catch(()=>{});return()=>{current=false;};},[]);
  useEffect(()=>{let current=true;fetch("/examples/index.json").then(r=>r.ok?r.json():{}).then(map=>{if(current&&map&&typeof map==="object")setExamples(map as Record<string,string>);}).catch(()=>{});return()=>{current=false;};},[]);
  const shown=matchTasks(tools,query);
  return <div className="cf-start">
    <Hero title="What do you want to make?" text={hosted?"Free and open source, powered by ComfyUI. Renders run on your own Comfy account.":"Free and open source, powered by ComfyUI. Nothing leaves your computer."} media={<RotatingVideo srcs={POOL_VIDEOS.slice(LOAD_TURN%POOL_VIDEOS.length).concat(POOL_VIDEOS.slice(0,LOAD_TURN%POOL_VIDEOS.length))}/>}>
      <SearchField label="Search tools" value={query} onChange={setQuery} placeholder="Describe it: a video of my dog, a product shot…"/>
    </Hero>
    <Toolbar>
      <SectionHeader title="All tools" large/>
    </Toolbar>
    {shown.length===0?<EmptyState title="No tool matches." action={<Button variant="ghost" onClick={()=>setQuery("")}>Show all tools</Button>}/>:
    <div className="cf-start__tools">{START_GROUPS.map(group=>{
        const tasks=shown.filter(t=>t.group===group);
        return tasks.length>0?<Block key={group} label={group}>
          <PresetGrid label={group}>
            {tasks.map(t=>{const at=shown.indexOf(t),turn=pool.length?pool.slice((at*3+LOAD_TURN)%pool.length).concat(pool.slice(0,(at*3+LOAD_TURN)%pool.length)):[],own=examples[t.id]?`/examples/${examples[t.id]}`:t.thumb;return <PresetCard key={t.id} size="tool" featured={t.featured} promo={t.promo} video={t.video} thumb={own??turn[0]} thumbs={turn} label={t.label} hint={t.text} icon={ICONS[t.id]} onSelect={()=>{if(onOpen)onOpen(t);else location.hash=t.href.slice(1);}}/>;})}
          </PresetGrid>
        </Block>:null;
      })}</div>}
  </div>;
}
