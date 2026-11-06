import {useEffect,useState} from "react";
import {Button,LazyVideo,Meta,PresetCard,RotatingVideo,WelcomeDialog} from "../ds";
import logo from "../assets/creativefield-logo-trim.png";
import {POOL_VIDEOS} from "./reels";
import {LOAD_TURN} from "./reload-turn";
import type {StartTask,StartTaskId} from "./start-tasks";

const WELCOME_KEY = "creativefield.welcome.v2";
/** The places a newcomer is offered first, in this order; only the ones that run here are shown (rule 26). */
const FIRST_PICKS: StartTaskId[] = ["fix-picture","video","picture","model3d","film","character"];
const WELCOME_CLIPS: Partial<Record<StartTaskId, string>> = {"fix-picture":"fotofield",model3d:"3d"};

function WelcomeClipCard({task,clip,onSelect}:{task:StartTask;clip:string;onSelect:()=>void}) {
  const poster = `/examples/welcome-${clip}.webp`;
  const [reducedMotion,setReducedMotion] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(()=>{if(typeof matchMedia !== "function")return;const query=matchMedia("(prefers-reduced-motion: reduce)");const update=()=>setReducedMotion(query.matches);query.addEventListener("change",update);return()=>query.removeEventListener("change",update);},[]);
  return <PresetCard size="tool" featured={task.featured} label={task.label} hint={task.text} onSelect={onSelect}
    icon={<span className="ds-welcome__clip"><img src={poster} alt=""/>{!reducedMotion&&<LazyVideo src={`/examples/welcome-${clip}.mp4`} poster={poster}/>}</span>}/>;
}

/** A short introduction, shown once per browser and dismissible at any time. A pick opens that tool directly. */
export function Welcome({tools,onOpen,onCloud}:{tools:StartTask[];onOpen:(task:StartTask)=>void;/** A hosted try-out: renders run on the visitor's own Comfy Cloud account, signed in from here. */onCloud?:()=>void}) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(WELCOME_KEY) !== "dismissed"; }
    catch { return false; }
  });
  const [examples,setExamples]=useState<Record<string,string>>({});
  useEffect(()=>{if(!open)return;let current=true;fetch("/examples/index.json").then(r=>r.ok?r.json():{}).then(map=>{if(current&&map&&typeof map==="object")setExamples(map as Record<string,string>);}).catch(()=>{});return()=>{current=false;};},[open]);
  const close = () => {
    try { localStorage.setItem(WELCOME_KEY, "dismissed"); } catch { /* storage may be unavailable */ }
    setOpen(false);
  };
  const picks=FIRST_PICKS.map(id=>tools.find(t=>t.id===id)).filter((t):t is StartTask=>!!t).slice(0,4);
  return <WelcomeDialog open={open} onClose={close} logo={logo}
    title="What will you make today?"
    text="Turn a few words, a photo or a clip into pictures, video and 3D. Pick a place to start, or look around first."
    media={<RotatingVideo srcs={[POOL_VIDEOS[LOAD_TURN%POOL_VIDEOS.length]]}/>}
    picks={picks.length?<>{picks.map(t=>{const select=()=>{close();onOpen(t);};const clip=WELCOME_CLIPS[t.id];return clip?<WelcomeClipCard key={t.id} task={t} clip={clip} onSelect={select}/>:<PresetCard key={t.id} size="tool" featured={t.featured} label={t.label} hint={t.text} thumb={examples[t.id]?`/examples/${examples[t.id]}`:t.thumb} onSelect={select}/>;})}</>:undefined}
    note={<Meta>{onCloud?"Renders run on your own Comfy account and credits, the free plan included. Your key stays in this browser.":"Local generation needs a connected ComfyUI worker and its models."}</Meta>}
    action={onCloud?<><Button variant="secondary" onClick={close}>Look around</Button><Button variant="primary" onClick={()=>{close();onCloud();}}>Use with Comfy Cloud</Button></>:<Button variant="primary" onClick={close}>Let's create</Button>}/>;
}
