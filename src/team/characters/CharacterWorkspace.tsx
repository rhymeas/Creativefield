import type {CapabilityManifestV2} from "../../capabilities/types";
import type {Call,CharacterRecord,Project,User,Workspace} from "../api";
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
  call:Call;
  authorized:boolean;
  canEdit:boolean;
  onOpenStoryboard:(boardId:string)=>void;
  onOpenCharacters?:()=>void;
  onOpenScenes?:()=>void;
  onOpenImages?:(record:CharacterRecord)=>string|undefined;
};

/** One studio for saved characters and the scene storyboards built from them. */
export function CharacterWorkspace({mode,user,workspace,project,catalogue,call,authorized,canEdit,onOpenStoryboard,onOpenCharacters,onOpenScenes,onOpenImages}:Props){
  /* "Make scenes" hands the character to the Scenes cast first, so the next screen opens with it
     selected; the switch itself belongs to the workspace screen. */
  const makeScenes=(characterId:string)=>{rememberCastMember(user.id,workspace.id,project.id,characterId);onOpenScenes?.();};
  return <div className="cf-character-studio">
    {mode==="characters"?<TeamCharacters key={`${workspace.id}:${project.id}`} workspace={workspace} project={project} call={call} authorized={authorized} canCreate={canEdit} onMakeScenes={onOpenScenes?makeScenes:undefined} onMakeImages={onOpenImages}/>:<InfluencerStudio user={user} workspace={workspace} project={project} catalogue={catalogue} call={call} authorized={authorized} canEdit={canEdit} onOpenStoryboard={onOpenStoryboard} onOpenCharacters={onOpenCharacters}/>}
  </div>;
}
