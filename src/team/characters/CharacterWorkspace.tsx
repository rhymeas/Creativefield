import type {CapabilityManifestV2} from "../../capabilities/types";
import type {Call,Project,User,Worker,Workspace} from "../api";
import {TeamCharacters} from "./TeamCharacters";
import {InfluencerStudio} from "../influencer/InfluencerStudio";
import {rememberCastMember} from "./state";
import "./character-studio.css";

export type CharacterMode="characters"|"scenes";

type Props={
  mode:CharacterMode;
  user:User;
  workspace:Workspace;
  project:Project;
  catalogue:CapabilityManifestV2[];
  /** Part of the screen contract; the cast no longer reads worker inventory. */
  workers:Worker[];
  call:Call;
  authorized:boolean;
  canEdit:boolean;
  onCount?:(count:number)=>void;
  onOpenStoryboard:()=>void;
  onOpenCharacters?:()=>void;
  onOpenScenes?:()=>void;
};

/** One studio for saved characters and the scene storyboards built from them. */
export function CharacterWorkspace({mode,user,workspace,project,catalogue,call,authorized,canEdit,onCount,onOpenStoryboard,onOpenCharacters,onOpenScenes}:Props){
  /* "Make scenes" hands the character to the Scenes cast first, so the next screen opens with it
     selected; the switch itself belongs to the workspace screen. */
  const makeScenes=(characterId:string)=>{rememberCastMember(user.id,workspace.id,project.id,characterId);onOpenScenes?.();};
  return <div className="cf-character-studio">
    {mode==="characters"?<TeamCharacters key={`${workspace.id}:${project.id}`} workspace={workspace} project={project} call={call} authorized={authorized} canCreate={canEdit} onCount={onCount} onMakeScenes={onOpenScenes?makeScenes:undefined}/>:<InfluencerStudio user={user} workspace={workspace} project={project} catalogue={catalogue} call={call} authorized={authorized} canEdit={canEdit} onOpenStoryboard={onOpenStoryboard} onOpenCharacters={()=>onOpenCharacters?.()}/>}
  </div>;
}
