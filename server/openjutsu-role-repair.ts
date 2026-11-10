import {createHash} from "node:crypto";
import type {ApiGraph} from "../src/workflow/build";
import {OPENJUTSU_ADVANCED_FLASH_ID} from "../src/capabilities/openjutsu-advanced";
import {assertLocalGraphPolicy,localWorkflowClasses} from "../src/capabilities/policy";

export const OPENJUTSU_ROLE_RESOLVER = "CreativeFieldOpenJutsuResolveRoles";

const positionCues = [
  /\b(?:on (?:the )?left|far left|leftmost)\b/i,
  /\b(?:in the (?:center|centre|middle)|(?:center|centre|middle) (?:person|dancer|figure|performer|subject))\b/i,
  /\b(?:on (?:the )?right|far right|rightmost)\b/i,
];

/** Only a complete, unambiguous positional instruction can opt into repair. */
export function openJutsuRoleOrder(graph: ApiGraph): number[] | undefined {
  const plan = graph["20"];
  if (plan?.class_type !== "H3AdvancedSwapPlan" || typeof plan.inputs.roles !== "string") return;
  const roles = plan.inputs.roles.split("\n");
  if (roles.length !== 3) return;
  const order = [0, 0, 0];
  for (const [index, role] of roles.entries()) {
    const separator = role.indexOf(" - ");
    if (separator < 0) return;
    const cue = role.slice(separator + 3);
    const positions = positionCues.flatMap((pattern, position) => pattern.test(cue) ? [position] : []);
    if (positions.length !== 1 || order[positions[0]]) return;
    order[positions[0]] = index + 1;
  }
  return order;
}

const linked = (value: unknown, node: string, slot: number) => Array.isArray(value) && value[0] === node && value[1] === slot;

export function addOpenJutsuRoleRepair(graph: ApiGraph, order: number[]): ApiGraph {
  const plan = graph["35"], track = graph["44"], crops = graph["45"], matcher = graph["47"];
  const masks = Object.values(graph).filter(node => node.class_type === "H3RoleMask");
  const resolver = "cf-openjutsu-resolve-roles", preview = "cf-openjutsu-resolved-role-preview";
  if (plan?.class_type !== "MiniMaxH3ChainPlanModern" || track?.class_type !== "SAM3_VideoTrack"
    || crops?.class_type !== "H3TrackCrops" || matcher?.class_type !== "H3TrackRoles"
    || !linked(crops.inputs.track_data, "44", 0) || !linked(matcher.inputs.segments, "45", 1)
    || masks.length !== 3 || masks.some(node => !linked(node.inputs.labels, "47", 0)) || graph[resolver] || graph[preview]) return graph;

  const fingerprint = createHash("sha256").update("openjutsu-role-repair-v1").update(JSON.stringify(graph)).digest("hex");
  plan.inputs.run_name = `swap_role_repair_${fingerprint.slice(0, 24)}`;
  plan.inputs.generation_fingerprint = fingerprint;
  graph[resolver] = {class_type: OPENJUTSU_ROLE_RESOLVER, inputs: {
    track_data: ["44", 0], segments: ["45", 1], labels: ["47", 0], left_to_right: JSON.stringify(order),
  }};
  graph[preview] = {class_type: "PreviewAny", inputs: {source: [resolver, 0]}};
  for (const mask of masks) mask.inputs.labels = [resolver, 0];
  assertLocalGraphPolicy(graph, localWorkflowClasses(OPENJUTSU_ADVANCED_FLASH_ID));
  return graph;
}
