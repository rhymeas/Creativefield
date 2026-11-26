import {useEffect,useMemo,useState,type ReactNode} from "react";
import {Button,EmptyState,Panel,SegmentedTabs} from "../ds";
import {Footprints,Maximize2,Palette,Shapes,UserRoundPen} from "lucide-react";
import type {Catalogue,Call,Project,User,Worker,Workspace} from "./api";
import type {CapabilityManifestV2,Readiness} from "../capabilities/types";
import {TeamComposer} from "./TeamComposer";
import {TeamChoice} from "./TeamChoice";
import {draftKey} from "./state";
import {backgroundManifest,restylePresentation,seedBackgroundDraft,selectTransformManifest,transformCandidates,changeChoices,type ChangeChoice,type RestyleKind,type TransformMode} from "./transform-video-state";

const TOOL_LABELS:Record<ChangeChoice,string>={person:"Replace character",motion:"Motion transfer",swap:"Swap a thing",restyle:"Restyle",reframe:"Reframe"};
const ICONS:Record<ChangeChoice,ReactNode>={person:<UserRoundPen size={18}/>,motion:<Footprints size={18}/>,swap:<Shapes size={18}/>,restyle:<Palette size={18}/>,reframe:<Maximize2 size={18}/>};

/* The card says what the tool does in large type; the model is already chosen, so the small line only names it. */
const CHOICE_MODEL:Record<ChangeChoice,string>={person:"MiniMax H3",motion:"HyperFlow H3",swap:"MiniMax H3",restyle:"HyperFlow H3",reframe:"HyperFlow H3"};
const CHOICE_LOOP:Partial<Record<ChangeChoice,string>>={swap:"/examples/promo/swap-thing.mp4",person:"/examples/squarehead/jutsu-01.mp4"};

/** "Change a video": the choice of tool sits at the top of the tool's own panel, so this page has exactly the
 *  same layout as Create (panel left, results in the free space). Replace character renders its own panel. */
export function TransformVideo({manifests,statuses,user,workspace,project,workers,call,canQueue,authorized,onCapability,onQueued,replace,swapThing,onModels,choice=replace?"person":"motion",reframe,unifiedSwap=false}:{
  manifests:Catalogue;statuses:Record<string,Readiness>;user:User;workspace:Workspace;project:Project;workers:Worker[];call:Call;canQueue:boolean;authorized:boolean;onCapability:(id:string)=>void;onQueued:()=>void;
  /** The place that shows which workflows are set up, so a tool without one is not a dead end. */
  onModels?:()=>void;
  /** The Replace character screen, given the tool choice to show at its top; absent when its workflow is not ready. */
  replace?:(top:ReactNode)=>ReactNode;/** Swap a thing, when its mask and edit workflows are ready. */swapThing?:(top:ReactNode)=>ReactNode;choice?:ChangeChoice;reframe?:CapabilityManifestV2;/** One Swap tool for a person, a thing and the whole look (DOC-2191). */unifiedSwap?:boolean;
}){
  const candidates=useMemo(()=>transformCandidates(manifests),[manifests]);
  const mode:TransformMode=choice==="person"||choice==="reframe"?"motion":choice;
  /* The tool picks its workflow automatically: no second model list inside Change. */
  const manifest=useMemo(()=>selectTransformManifest(manifests,statuses,mode),[manifests,statuses,mode]);
  /* A new background keeps the whole clip and changes only what is behind the subject, so it runs on the
     masked edit. The option exists only where that route is ready; the words start it off. */
  const [kind,setKind]=useState<RestyleKind>("look");
  const background=useMemo(()=>backgroundManifest(manifests,statuses),[manifests,statuses]);
  const backgroundEdit=useMemo(()=>background?selectTransformManifest(manifests,statuses,"swap"):undefined,[background,manifests,statuses]);
  const backgroundOn=choice==="restyle"&&kind==="background"&&!!backgroundEdit;
  const shown=backgroundOn?backgroundEdit:manifest;
  const displayShown=shown&&choice==="restyle"&&!backgroundOn?restylePresentation(shown):shown;
  const displayCatalogue=choice==="restyle"&&!backgroundOn?manifests.map(restylePresentation):manifests;
  function chooseKind(next:RestyleKind){
    if(next==="background"&&backgroundEdit){try{seedBackgroundDraft(localStorage,draftKey(user.id,workspace.id,project.id,backgroundEdit.id));}catch{/* A blocked browser store only costs the starting words. */}}
    setKind(next);
  }
  // The intents are a compact choice, not a wall of model cards; the workflow itself is automatic.
  // With the one Swap tool, a person and a new look are swaps: no separate cards (DOC-2191).
  const cards=changeChoices({replace:!!replace,swapThing:!!swapThing,reframe:!!reframe,unifiedSwap,candidates}).map(id=>({id,label:TOOL_LABELS[id]}));
  /* A retired tool (for example Wan motion transfer after the HyperFlow switch) keeps old links alive by
     moving them to the first tool this computer can actually run. */
  const availableKey=cards.map(card=>card.id).join(",");
  useEffect(()=>{if(cards.length&&!cards.some(card=>card.id===choice))location.hash=`video/transform/${cards[0].id}`;},[availableKey,choice]);
  /* Swap a thing and Replace character have no composer model card of their own: there the choice is the card. */
  const ownPanel=choice==="swap"&&!!swapThing||choice==="person"&&!!replace;
  const switcher=<div className="cf-form"><TeamChoice variant={ownPanel?"model":"pill"} label="What to change" display={TOOL_LABELS[choice]} subtitle={CHOICE_MODEL[choice]} video={CHOICE_LOOP[choice]} value={choice} options={cards.map(card=>({value:card.id,label:card.label,icon:ICONS[card.id]}))} onChange={id=>{location.hash=`video/transform/${id}`;}}/></div>;
  /* Inside Restyle, the background change is the second choice, offered only when its route is ready. */
  const kinds=choice==="restyle"&&background&&candidates.restyle.length>0
    ?<SegmentedTabs quiet label="What changes" value={backgroundOn?"background":"look"} onChange={chooseKind} items={[{id:"look" as const,label:"New look"},{id:"background" as const,label:"New background"}]}/>
    :null;
  const top=<>{switcher}{kinds}</>;
  if(choice==="person"&&replace)return <>{replace(switcher)}</>;
  if(choice==="swap"&&swapThing)return <>{swapThing(switcher)}</>;
  if(choice==="reframe"&&reframe)return <TeamComposer key={`${project.id}:${reframe.id}`} top={switcher} manifest={reframe} catalogue={manifests} workflowIds={[reframe.id]} onCapability={onCapability} user={user} workspace={workspace} project={project} workers={workers} call={call} canQueue={canQueue} authorized={authorized} onQueued={onQueued}/>;
  return displayShown
    ?<TeamComposer key={`${project.id}:${displayShown.id}`} top={top} manifest={displayShown} catalogue={displayCatalogue} workflowIds={[displayShown.id]} onCapability={onCapability} user={user} workspace={workspace} project={project} workers={workers} call={call} canQueue={canQueue} authorized={authorized} onQueued={onQueued}/>
    :<div className="cf-production"><Panel>{top}<EmptyState title={TOOL_LABELS[mode]} text="No workflow for this tool is ready on this computer yet. Models shows which workflows are set up and what each one still needs." action={onModels?<Button variant="secondary" onClick={onModels}>Open Models</Button>:undefined}/></Panel></div>;
}
