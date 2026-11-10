import type {ApiGraph} from "../workflow/build";
import {openJutsuRoles} from "./openjutsu-advanced";

/** Extract explicit target descriptions while keeping general creative text
 * out of the tracker. The complete instruction is passed separately to H3. */
export function experimentalOpenJutsuRoles(text:string, pictureCount:number):string[] {
  const hits = [...text.matchAll(/@Image\s*(\d+)\b/gi)];
  if (hits.length) {
    const fallback = openJutsuRoles(text, pictureCount);
    for (let i = 0; i < hits.length; i++) {
      const n = Number(hits[i][1]) - 1;
      const previousEnd = i ? hits[i-1].index! + hits[i-1][0].length : 0;
      const before = text.slice(previousEnd, hits[i].index);
      // Prefer the last explicit command. A preceding reference description may
      // itself contain "and" (e.g. "shorts and gloves") and is not a target.
      const commands = [...before.matchAll(/\b(?:replace|swap)\s+/gi)];
      const lastCommand = commands.at(-1);
      const commandTail = lastCommand ? before.slice(lastCommand.index! + lastCommand[0].length) : "";
      // Preserve the source cue in "replace X with @Image 1", "with the
      // robot from @Image 1", and "with the robot @Image 1".
      const command = commandTail.match(/^([^.!?;]+?)\s+with\s+(?:the|a|an)\s+[^.!?;]+?\s+from\s*$/i)
        ?? commandTail.match(/^([^.!?;]+?)\s+with\s*(?:(?:[^.!?;]*?\s+from)\s*)?$/i)
        ?? commandTail.match(/^([^.!?;\r\n]+)\s+with\s+(?:the|a|an)\s+[^.!?;\r\n]+$/i);
      if (command) fallback[n] = command[1].trim();
      else if (i > 0) {
        // In "@Image 1, wearing shorts and gloves and the woman with
        // @Image 2", the final article starts the next target, not an
        // attribute of the preceding reference.
        const target = before.match(/\band\s+((?:the|a|an)\s+[^.!?;]+?)\s+with\s*(?:(?:[^.!?;]*?\s+from)\s*)?$/i);
        if (target) fallback[n] = target[1].trim();
      }
    }
    return fallback;
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // Preserve the existing compact one-target-per-line form, but do not feed
  // directions such as "keep the background" to person tracking as a role.
  const targetLine = /\b(?:person|people|man|woman|boy|girl|character|dancer|subject|personne|mensch|mann|frau|figur)\b/i;
  const instruction = /^(?:keep|preserve|make|use|ensure|retain|change|remove|add|avoid|don't|do not|behalte|erhalte|mache|ändere|entferne)\b/i;
  if (lines.length >= pictureCount && lines.slice(0,pictureCount).every(line => targetLine.test(line) && !instruction.test(line) && !/\b(?:replace|swap)\b/i.test(line))) {
    return lines.slice(0,pictureCount);
  }
  // A direct replacement sentence can identify the original person even when
  // the user has not inserted an @Image chip. Unknown targets stay unspecified
  // so the workflow can use its own video description rather than a fake role.
  return [...text.matchAll(/\b(?:replace|swap)\s+([^.!?;\n]+?)\s+with\b/gi)]
    .slice(0,pictureCount).map(match=>match[1].trim());
}

/** Keep source motion without requiring a reference character to have human
 * skin, hair, or the same mouth. Applied only to the generated upstream text,
 * before the user's own words are appended. */
export const CHARACTER_NEUTRAL_REWRITES:ReadonlyArray<readonly [string,string]> = [
  ["the referenced facial identity, hair, skin tone and complete outfit remain consistent while poses and mouth movements follow", "the referenced appearance, anatomy and complete outfit remain consistent while poses and character-appropriate expressions follow"],
  ["the same gestures, steps, gaze, expressions and mouth shapes at the same moments", "the same gestures, steps and gaze at the same moments, with expressions appropriate to the reference character"],
  ["with natural skin tones and the source lighting and lens perspective", "with the source lighting and lens perspective"],
];

/** Preserve the full instruction in the experimental multi-character graph.
 * The upstream roles field is only for identifying people, not a video prompt. */
export function addOpenJutsuUserInstruction(graph:ApiGraph, text:string, pictureCount:number):ApiGraph {
  // Give a differently shaped replacement more room than the source silhouette.
  // This is limited to the experimental Flash graph and deliberately keeps the
  // background outside the expanded mask untouched.
  const personMask = graph["58"], grownMask = graph["60"];
  if (personMask?.class_type !== "H3RoleMask" || grownMask?.class_type !== "GrowMaskWithBlur") throw new Error("The OpenJutsu person mask has changed.");
  personMask.inputs.headroom = 0.22;
  // This mask lives in SAM's independently resized tracking coordinates, not
  // the output resolution. Keep the value used by the successful short test.
  grownMask.inputs.expand = 60;
  if (pictureCount >= 3) {
    // In a crowded swap, the optional mouth-motion guide can carry the source
    // faces into conditioning even when all tracks and edit masks are correct.
    const motionGuide = graph["61"];
    if (motionGuide?.class_type !== "H3GreyMannequins") throw new Error("The OpenJutsu motion guide has changed.");
    delete motionGuide.inputs.faces;
    delete motionGuide.inputs.face_size;
    const plan = graph["20"];
    if (plan?.class_type !== "H3AdvancedSwapPlan" || typeof plan.inputs.roles !== "string") throw new Error("The OpenJutsu role plan has changed.");
    // OpenJutsu uses the part after " - " for track matching, and only the
    // name before it in generation. Source hair and clothing are track cues.
    if (plan.inputs.roles) {
      plan.inputs.roles = plan.inputs.roles.split("\n").map((role,i)=>`the source person ${i+1} - ${role}`).join("\n");
    }
  }
  const conditioning = Object.entries(graph).filter(([,node]) => node.class_type === "MiniMaxH3ReferenceToVideo");
  if (conditioning.length !== 1) throw new Error("Expected one OpenJutsu reference-conditioning node.");
  const input = conditioning[0][1].inputs.prompt;
  if (!Array.isArray(input) || input.length !== 2 || typeof input[0] !== "string" || !graph[input[0]] || !Number.isInteger(input[1])) {
    throw new Error("The OpenJutsu video prompt connection has changed.");
  }
  const instruction = text.replace(/@Image\s*(\d+)\b/gi, (match, digits:string) => {
    const n = Number(digits);
    if (n < 1 || n > pictureCount) throw new Error(`${match} has no attached character reference.`);
    return `<Picture ${n}>`;
  });
  const userNode = "cf-openjutsu-user-instruction", concatNode = "cf-openjutsu-complete-prompt";
  const ids = CHARACTER_NEUTRAL_REWRITES.map((_,i)=>`cf-openjutsu-character-rewrite-${i}`);
  if ([...ids,...(text.trim()?[userNode,concatNode]:[])].some(id=>graph[id])) throw new Error("OpenJutsu prompt node IDs are already in use.");
  let current = input as [string,number];
  for (let i=0;i<CHARACTER_NEUTRAL_REWRITES.length;i++) {
    const id = ids[i];
    const [find,replace] = CHARACTER_NEUTRAL_REWRITES[i];
    graph[id] = {class_type:"StringReplace", inputs:{string:current,find,replace}};
    current = [id,0];
  }
  if (!text.trim()) {
    conditioning[0][1].inputs.prompt = current;
    return graph;
  }
  const sourceCue = pictureCount >= 3 ? "\nUse descriptions of the original people only to identify their motion tracks. The replacement's face, hair and clothing come from its reference picture." : "";
  graph[userNode] = {class_type:"PrimitiveStringMultiline", inputs:{value:`User instructions: ${instruction}${sourceCue}\nFully replace each selected person's original body and clothing. Match the complete shape and number of limbs to the corresponding reference; do not retain duplicate source body parts.`}};
  graph[concatNode] = {class_type:"StringConcatenate", inputs:{string_a:current, string_b:[userNode,0], delimiter:"\n\n"}};
  conditioning[0][1].inputs.prompt = [concatNode,0];
  return graph;
}
