import {createHash} from "node:crypto";
import type {ApiGraph} from "../workflow/build";
import {openJutsuSceneGuideIssue} from "./openjutsu-advanced";

/** Append the guide to conditioning shared by every window, after the numbered characters. */
export function addOpenJutsuSceneGuide(graph:ApiGraph, characterCount:number){
  const issue=openJutsuSceneGuideIssue(characterCount);
  if(issue)throw new Error(issue);
  const conditioning=graph["65"], plan=graph["35"];
  const placeholder="ref_images.ref_image_4", promptId="cf-openjutsu-scene-guide-prompt";
  const guide=conditioning?.inputs[placeholder];
  if(conditioning?.class_type!=="MiniMaxH3ReferenceToVideo"||plan?.class_type!=="MiniMaxH3ChainPlanModern"
    ||!Array.isArray(guide)||guide[0]!=="cf-openjutsu-scene-guide"||guide[1]!==0||graph[promptId]){
    throw new Error("The OpenJutsu scene guide connection has changed.");
  }

  // The native plan's original resume key only covers the video and character pictures.
  const fingerprint=createHash("sha256").update(JSON.stringify(graph)).digest("hex");
  plan.inputs.run_name=`swap_scene_guide_${fingerprint.slice(0,24)}`;
  plan.inputs.generation_fingerprint=fingerprint;

  delete conditioning.inputs[placeholder];
  conditioning.inputs[`ref_images.ref_image_${characterCount}`]=guide;
  graph[promptId]={class_type:"StringConcatenate",inputs:{
    string_a:conditioning.inputs.prompt,
    string_b:`Use <Picture ${characterCount+1}> as a full-scene identity and placement reference. It shows which replacement goes at each person's position. Keep the corresponding individual picture for each replacement's face, body and clothing. Follow <Video 1> for each frame's movement, pose, camera and timing.`,
    delimiter:"\n\n",
  }};
  conditioning.inputs.prompt=[promptId,0];
}
