import {useEffect,useMemo,useState,type ReactNode} from "react";
import {Button,EmptyState,Panel,PresetCard,PresetGrid,SegmentedTabs} from "../ds";
import {Footprints,Palette,Shapes,UserRoundPen} from "lucide-react";
import type {Catalogue,Call,Project,User,Worker,Workspace} from "./api";
import type {Readiness} from "../capabilities/types";
import {TeamComposer} from "./TeamComposer";
import {draftKey} from "./state";
import {backgroundManifest,seedBackgroundDraft,selectTransformManifest,TRANSFORM_MODES,transformCandidates,type RestyleKind,type TransformMode} from "./transform-video-state";

export type ChangeChoice=TransformMode|"person";
const TOOL_LABELS:Record<ChangeChoice,string>={person:"Replace character",motion:"Motion transfer",swap:"Object swap",restyle:"Restyle"};
const ICONS:Record<ChangeChoice,ReactNode>={person:<UserRoundPen size={18}/>,motion:<Footprints size={18}/>,swap:<Shapes size={18}/>,restyle:<Palette size={18}/>};

/** "Change a video": the choice of tool sits at the top of the tool's own panel, so this page has exactly the
 *  same layout as Create (panel left, results in the free space). Replace character renders its own panel. */
export function TransformVideo({manifests,statuses,user,workspace,project,workers,call,canQueue,authorized,onCapability,onQueued,replace,swapThing,onModels,initial="person"}:{
  manifests:Catalogue;statuses:Record<string,Readiness>;user:User;workspace:Workspace;project:Project;workers:Worker[];call:Call;canQueue:boolean;authorized:boolean;onCapability:(id:string)=>void;onQueued:()=>void;
  /** The place that shows which workflows are set up, so a tool without one is not a dead end. */
  onModels?:()=>void;
  /** The Replace character screen, given the tool choice to show at its top; absent when its workflow is not ready. */
  replace?:(top:ReactNode)=>ReactNode;/** Swap a thing, when its mask and edit workflows are ready. */swapThing?:(top:ReactNode)=>ReactNode;initial?:ChangeChoice;
}){
  const [choice,setChoice]=useState<ChangeChoice>(initial==="person"&&!replace?"motion":initial);
  /* A tool opened from elsewhere (the full view's Open in, a link) changes the address; the card follows it. */
  useEffect(()=>{setChoice(initial==="person"&&!replace?"motion":initial);},[initial,!!replace]);
  const candidates=useMemo(()=>transformCandidates(manifests),[manifests]);
  const mode:TransformMode=choice==="person"?"motion":choice;
  // A workflow picked in a tool's own row changes that tool's panel; each tool keeps its own pick.
  const [picked,setPicked]=useState<{mode:TransformMode;id:string}|null>(null);
  const manifest=useMemo(()=>selectTransformManifest(manifests,statuses,mode,picked?.mode===mode?picked.id:undefined),[manifests,statuses,mode,picked]);
  /* A new background keeps the whole clip and changes only what is behind the subject, so it runs on the
     masked edit. The option exists only where that route is ready; the words start it off. */
  const [kind,setKind]=useState<RestyleKind>("look");
  const background=useMemo(()=>backgroundManifest(manifests,statuses),[manifests,statuses]);
  const backgroundEdit=useMemo(()=>background?selectTransformManifest(manifests,statuses,"swap",picked?.mode==="swap"?picked.id:undefined):undefined,[background,manifests,statuses,picked]);
  const backgroundOn=choice==="restyle"&&kind==="background"&&!!backgroundEdit;
  const shown=backgroundOn?backgroundEdit:manifest,shownMode:TransformMode=backgroundOn?"swap":mode;
  function chooseWorkflow(id:string){setPicked({mode:shownMode,id});onCapability(id);}
  function chooseKind(next:RestyleKind){
    if(next==="background"&&backgroundEdit){try{seedBackgroundDraft(localStorage,draftKey(user.id,workspace.id,project.id,backgroundEdit.id));}catch{/* A blocked browser store only costs the starting words. */}}
    setKind(next);
  }
  // Four tool boxes at the top of the panel; a tool that cannot work here gets no box (rule 26).
  const cards:{id:ChangeChoice;label:string}[]=[...(replace?[{id:"person" as const,label:TOOL_LABELS.person}]:[]),...TRANSFORM_MODES.map(m=>({id:m.id,label:TOOL_LABELS[m.id]}))];
  const switcher=<div className="cf-change-cards"><PresetGrid label="Change a video">
    {cards.map(card=><PresetCard key={card.id} label={card.label} icon={ICONS[card.id]} selected={card.id===choice} onSelect={()=>{setChoice(card.id);location.hash=`video/transform/${card.id}`;}}/>)}
  </PresetGrid></div>;
  /* Inside Restyle, the background change is the second choice, offered only when its route is ready. */
  const kinds=choice==="restyle"&&background&&candidates.restyle.length>0
    ?<SegmentedTabs quiet label="What changes" value={backgroundOn?"background":"look"} onChange={chooseKind} items={[{id:"look" as const,label:"New look"},{id:"background" as const,label:"New background"}]}/>
    :null;
  const top=<>{switcher}{kinds}</>;
  if(choice==="person"&&replace)return <>{replace(switcher)}</>;
  if(choice==="swap"&&swapThing)return <>{swapThing(switcher)}</>;
  return shown
    ?<TeamComposer key={`${project.id}:${shown.id}`} top={top} manifest={shown} catalogue={manifests} workflowIds={candidates[shownMode].map(m=>m.id)} onCapability={chooseWorkflow} user={user} workspace={workspace} project={project} workers={workers} call={call} canQueue={canQueue} authorized={authorized} onQueued={onQueued}/>
    :<div className="cf-production"><Panel>{top}<EmptyState title={TOOL_LABELS[mode]} text="No workflow for this tool is ready on this computer yet. Models shows which workflows are set up and what each one still needs." action={onModels?<Button variant="secondary" onClick={onModels}>Open Models</Button>:undefined}/></Panel></div>;
}
