import type { ApiGraph } from "../workflow/build";

export const OPENJUTSU_ADVANCED_ID = "openjutsu-h3-advanced";
export const OPENJUTSU_ADVANCED_FLASH_ID = "openjutsu-h3-advanced-hyperflow";
export const OPENJUTSU_SCENE_GUIDE = "scene_guide";
export const isOpenJutsuAdvanced = (id: string) => id === OPENJUTSU_ADVANCED_ID || id === OPENJUTSU_ADVANCED_FLASH_ID;

export const openJutsuSceneGuideIssue = (characterCount: number) =>
  characterCount < 2 ? "Add at least two character references to use a scene guide, or remove the guide." : undefined;

/** Picture numbers are stable slot numbers. Tell the user what to attach before queueing. */
export function openJutsuReferenceIssue(occupied:readonly boolean[],prompt:string){
  const gap=occupied.indexOf(false),last=occupied.lastIndexOf(true);
  if(gap>=0&&gap<last)return `Add Character ${gap+1} in References before using Character ${last+1}.`;
  for(const match of prompt.matchAll(/@Image\s*(\d+)\b/gi)){
    const slot=Number(match[1]);
    if(slot<1||slot>occupied.length)return `${match[0]} is outside the available character slots. Edit the prompt to use @Image 1 through @Image ${occupied.length}.`;
    if(!occupied[slot-1])return `Add Character ${slot} in References to use ${match[0]}, or remove that mention.`;
  }
}

/** The upstream graph is pinned to D3voz/openjutsu 7fe118bb. The route remains
 * experimental; the caller must validate worker and model readiness. */
type TitledNode = ApiGraph[string] & { _meta?: { title?: string } };
type TitledGraph = Record<string, TitledNode>;
const isLink = (value: unknown): value is [string, number] => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]);

/** Read the target in phrases such as “replace the person with the robot from @Image 1”. */
function targetBeforeImage(text: string): string | undefined {
  const commands = [...text.matchAll(/\b(?:replace|swap)\b/gi)];
  const last = commands.at(-1);
  if (!last) return undefined;
  return text.slice(last.index).match(/^(?:replace|swap)\s+(.+?)\s+with(?:\s+(?:the\s+)?[^,;.\n]+?\s+from)?\s*$/i)?.[1]?.trim();
}

/** Associate optional @Image mentions with the corresponding ordered role. */
export function openJutsuRoles(text:string,count:number):string[] {
  const hits=[...text.matchAll(/@Image\s*(\d+)\b/gi)];
  if(!hits.length){
    // Explicit replacement instructions can identify targets without requiring
    // reference mentions. Their order corresponds to the attached pictures.
    const targets=[...text.matchAll(/\b(?:replace|swap)\s+([^.!?;\n]+?)\s+(?:with|for)\b/gi)]
      .map(match=>match[1].trim());
    return targets.length ? targets : text.split(/\r?\n/);
  }
  const roles=Array<string>(count).fill("");
  const lines=text.split(/\r?\n/);
  if(lines.every(line => [...line.matchAll(/@Image\s*\d+\b/gi)].length <= 1)) {
    for(const line of lines) {
      const match=line.match(/@Image\s*(\d+)\b/i);
      if(!match)continue;
      const n=Number(match[1])-1;
      if(n<0||n>=count)throw new Error(`@Image ${n+1} has no attached character reference.`);
      const before=line.slice(0,match.index).trim();
      const after=line.slice(match.index!+match[0].length).replace(/^[\s,:;\-]+|[\s,:;\-]+$/g,"");
      const replacement=before.match(/(?:replace|swap)\s+(.+?)\s+with\s*$/i);
      const target=targetBeforeImage(before) ?? replacement?.[1];
      if(target)roles[n]=target;
      else if(!roles[n])roles[n]=after;
    }
    return roles;
  }
  for(let i=0;i<hits.length;i++){
    const n=Number(hits[i][1])-1;
    if(n<0||n>=count)throw new Error(`@Image ${n+1} has no attached character reference.`);
    const start=hits[i].index!+hits[i][0].length;
    const end=hits[i+1]?.index??text.length;
    const before=text.slice(i?hits[i-1].index!+hits[i-1][0].length:0,hits[i].index);
    const replacement=before.match(/\b(?:replace|swap|and)\s+([^,;]+?)\s+with\s*$/i);
    const target=targetBeforeImage(before) ?? replacement?.[1]?.trim();
    if(target)roles[n]=target;
    else if(!roles[n])roles[n]=text.slice(start,end).replace(/^[\s,:;\-]+|[\s,:;\-]+$/g,"");
  }
  return roles;
}

function titleId(graph: TitledGraph, title: string, classType: string): string {
  const matches = Object.entries(graph).filter(([, node]) => node._meta?.title === title && node.class_type === classType);
  if (matches.length !== 1) throw new Error(`The advanced workflow must contain one ${title} node.`);
  return matches[0][0];
}

/** Remove unused character branches rather than sending fake placeholder images.
 * Picture names must already be uploaded to the selected ComfyUI worker. */
export function prepareOpenJutsuAdvancedCharacters(source: TitledGraph, filenames: string[], roles: string[] = []): TitledGraph {
  if (!Array.isArray(filenames) || filenames.length < 1 || filenames.length > 4 || filenames.some(name => typeof name !== "string" || !name.trim())) throw new Error("Choose one to four character pictures.");
  if (!Array.isArray(roles) || roles.length > filenames.length || roles.some(role => typeof role !== "string")) throw new Error("Provide at most one role per character.");
  const graph = structuredClone(source);
  const planId = titleId(graph, "Swap Plan (roles, seed, size)", "H3AdvancedSwapPlan");
  const plan = graph[planId];
  const removed = new Set<string>();
  for (let i = 1; i <= 4; i++) {
    const loader = titleId(graph, `Picture ${i}`, "LoadImage");
    const describe = titleId(graph, `Describe picture ${i}`, "TextGenerate");
    const scales = Object.entries(graph).filter(([, node]) => node.class_type === "ImageScaleToMaxDimension" && isLink(node.inputs.image) && node.inputs.image[0] === loader);
    if (scales.length !== 1 || !isLink(graph[describe].inputs.image) || graph[describe].inputs.image[0] !== scales[0][0]) throw new Error(`The advanced workflow picture ${i} branch has changed.`);
    if (i <= filenames.length) graph[loader].inputs.image = filenames[i - 1];
    else for (const id of [loader, scales[0][0], describe]) removed.add(id);
  }
  for (const id of removed) delete graph[id];
  for (const [id, node] of Object.entries(graph)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (!isLink(value)) continue;
      if (removed.has(value[0])) {
        const permitted = (id === planId && /^picture_[1-4](?:_text)?$/.test(field)) || (node.class_type === "MiniMaxH3ReferenceToVideo" && /^ref_images\.ref_image_[0-3]$/.test(field));
        if (!permitted) throw new Error(`Unexpected link from ${id}.${field} to removed character branch.`);
        delete node.inputs[field];
      } else if (!graph[value[0]] || value[1] < 0) {
        throw new Error(`Invalid workflow link at ${id}.${field}.`);
      }
    }
  }
  const cleaned = Array.from({ length: filenames.length }, (_, i) => (roles[i] ?? "").replace(/\s+/g, " ").trim());
  const ordinal = ["", "second ", "third ", "fourth "];
  plan.inputs.roles = cleaned.some(Boolean) ? cleaned.map((role, i) => role || (filenames.length === 1 ? "the main person" : `the person with the ${ordinal[i]}most screen time`)).join("\n") : "";
  return graph;
}
