/* Turns a reviewed @-reference plan into a chain of local runs: per person, an optional character preparation
   (face tweak and outfit on the reference image), an optional dressing from a clothes or product picture, and a
   SCAIL-2 replacement that feeds the next person's pass. */
import type { ReferencePlan } from "../workflow/reference-prompt";
import { describeReplacePrompt } from "../workflow/reference-prompt";
import { capability } from "../capabilities/lookup";
import { scailPersonIndices } from "../capabilities/replace";

export const REPLACE_CAPABILITY = capability("scail2-character-replace");
export const PREPARE_CAPABILITY = capability("flux2-klein-edit");
/** Dressing from a picture: the only local edit that takes a second image, so the clothes or product
 *  picture is a real reference instead of more prompt words. */
export const DRESS_CAPABILITY = capability("qwen-image-21-edit");

/** A step's input is a chosen asset or the output of an earlier step. */
export type StepInput = { asset: string } | { step: string };
export type ReplaceStep = {
  id: string; label: string; capabilityId: string; version: string;
  inputs: Record<string, StepInput>; controls: Record<string, unknown>;
};
/** `clothes` is the asset id of this person's clothes or product picture, when they have one. */
export type PlannedPerson = ReferencePlan["people"][number] & { index: number; clothes?: string };

/** The people one run can replace, counted from the left; the model's person control offers exactly this many. */
export const MAX_PEOPLE = 4;
const ORDINAL = ["1st", "2nd", "3rd", "4th"];

/** Where a face goes, in words: "3rd person from the left". */
export function personLabel(index: number): string {
  return `${ORDINAL[index] ?? `${index + 1}th`} person from the left`;
}

/** The people a face can be put on, for the person picker. */
export function personChoices(): Array<{ value: string; label: string }> {
  return ORDINAL.map((_, i) => ({ value: String(i), label: personLabel(i) }));
}

/** A face and the person it replaces. */
export type FaceSpot = { index: number };

/** The first person from the left no face takes yet, so faces added one after another go left to right. */
export function freePerson(faces: FaceSpot[]): number {
  const taken = new Set(faces.map((f) => f.index));
  return [...Array(MAX_PEOPLE).keys()].find((i) => !taken.has(i)) ?? 0;
}

/** Put a face on another person. A face already on that person swaps places, so two faces never share one. */
export function placeFace<T extends FaceSpot>(faces: T[], at: number, index: number): T[] {
  const from = faces[at]?.index;
  if (from === undefined || index < 0 || index >= MAX_PEOPLE) return faces;
  return faces.map((f, i) => (i === at ? { ...f, index } : f.index === index ? { ...f, index: from } : f));
}

/** Take a face out. Faces that fill the people left to right close the gap; a face put on a later person
 *  on purpose keeps its person. */
export function removeFace<T extends FaceSpot>(faces: T[], at: number): T[] {
  const leftToRight = faces.every((f, i) => f.index === i);
  const rest = faces.filter((_, i) => i !== at);
  return leftToRight ? rest.map((f, i) => ({ ...f, index: i })) : rest;
}

/** Left-to-right position from the planner's words; "right" is the last of the people in the plan. */
export function personIndexFor(target: string, position: number, total: number): number {
  const t = target.toLowerCase();
  if (/\bleft\b/.test(t) && !/second|third|from the left/.test(t)) return 0;
  if (/\bright\b/.test(t)) return Math.max(0, total - 1);
  const nth = /\b(first|second|third|fourth)\b/.exec(t)?.[1];
  if (nth) return ["first", "second", "third", "fourth"].indexOf(nth);
  if (/\bmiddle|center|centre\b/.test(t)) return Math.floor(total / 2);
  return Math.min(position, 3);
}

export function withIndexes(plan: ReferencePlan): PlannedPerson[] {
  return plan.people.map((p, i) => ({ ...p, index: personIndexFor(p.target, i, plan.people.length) }));
}

/** Words a person can act on. A plan read by the local text model can hold a placeholder it copied from the
 *  request ("faceEdit": "...", "outfit": "...."), and the panel then sent "Face: ...; Wearing ...." to the
 *  preparation step: the picture came back as a generic person and the replacement had no identity to use
 *  (runs 389f5d60 and 0b04a736, 2026-10-27). A value with no two letters in it is not a change. */
export function realWords(value: string | undefined): string | undefined {
  const text = (value ?? "").trim();
  return /[\p{L}]{2}/u.test(text) ? text : undefined;
}

/** Do not silently substitute the known weak instruction-only route when reading
 * a reference failed. Descriptions supplement the image inputs; they never prove identity. */
export function requireReferenceLooks(labels:string[],looks:Record<string,string>):void {
  const missing=labels.filter(label=>!realWords(looks[label]));
  if(missing.length)throw new Error(`Could not read ${missing.join(", ")}. No replacement was started. Check the local image-reading model and try again.`);
}

const preparePrompt = (p: PlannedPerson) =>
  ["Full-body photo of the same person, same identity and skin tone, standing, plain light background.",
    p.faceEdit && `Face: ${p.faceEdit}; keep it recognizably the same person.`,
    p.outfit && `Wearing ${p.outfit}.`].filter(Boolean).join(" ");

const dressPrompt = (p: PlannedPerson) =>
  ["Put the clothes or product from the reference picture on the same person.",
    "Keep their face, hair and body. Full-body photo, standing, plain light background.",
    p.faceEdit && `Face: ${p.faceEdit}; keep it recognizably the same person.`,
    p.outfit && `Wearing ${p.outfit}.`].filter(Boolean).join(" ");

/** The user's own scene words. A replace sentence ("replace the 2nd person with @Image 2") is already
 *  carried by the identity clause and the person control; left in the text it reaches the model as an
 *  instruction with an empty spot ("replace the 2nd person with ."), and the model then replaces a
 *  person with nothing. */
export function sceneWords(request: string | undefined): string {
  const text = (request ?? "")
    .replace(/\b(?:replace|swap|put|change)\b[^.;!?]*?\bwith\b(?:\s*@\s*(?:image|img|video|vid)\s*\d{1,2}\s*(?:,|and|&)?)+/gi, " ")
    .replace(/@\s*(?:image|img|video|vid)\s*\d{1,2}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  // An instruction that named only references leaves punctuation behind; a scene word never is one.
  return text.split(" ").filter((word) => /[\p{L}\p{N}]/u.test(word)).join(" ").replace(/\s+([.,;])/g, "$1");
}

/** Where a face goes, in words: "person on the left", "person 2 from the left", "person on the right". */
function whereWords(index: number, total: number): string {
  return index === 0 ? "person on the left" : index === total - 1 ? "person on the right" : `person ${index + 1} from the left`;
}

/** This person's character picture: the face itself, after the face tweak and the outfit, then the
 *  clothes or product picture, so SCAIL still receives one image per person. */
function prepareCharacter(p: PlannedPerson, ordinal: number, steps: ReplaceStep[], media: Record<string, string>): StepInput {
  let character: StepInput = { asset: media[p.face!] };
  if (p.faceEdit || p.outfit) {
    const id = `prepare-${ordinal}`;
    steps.push({ id, label: `Prepare ${p.face}${p.outfit ? " in new outfit" : ""}`, ...cap(PREPARE_CAPABILITY), inputs: { source_image: character }, controls: { prompt: preparePrompt(p) } });
    character = { step: id };
  }
  if (p.clothes) {
    const id = `dress-${ordinal}`;
    steps.push({ id, label: `Dress ${p.face}`, ...cap(DRESS_CAPABILITY), inputs: { source_image: character, reference_image: { asset: p.clothes } }, controls: { prompt: dressPrompt(p) } });
    character = { step: id };
  }
  return character;
}

/** Steps in run order. Missing references stop the build with a readable reason instead of a partial chain.
 *  Two faces become ONE pass with both pictures, in the order the model paints them: the leftmost person
 *  keeps the first colour. One face, or three or more, keep the chained run the pack has always used.
 *  The prompt carries the user's own scene words (minus the @ references) plus a composition clause:
 *  SCAIL needs to know what the whole frame contains or it crops to the character.
 *  `looks` holds the words a vision model wrote for each picture (@Image 1 → "short dark hair, glasses,
 *  a grey jacket"); with a look for every replaced person the prompt describes them instead of telling
 *  the model to replace them, which is the wording the two-picture pass was measured with. */
export function buildReplaceSteps(plan: ReferencePlan, people: PlannedPerson[], media: Record<string, string>, request?: string, looks: Record<string, string> = {}): { steps: ReplaceStep[]; missing: string[] } {
  const missing = [plan.video, ...people.map((p) => p.face).filter((f): f is string => !!f)].filter((label) => !media[label]);
  if (missing.length) return { steps: [], missing: [...new Set(missing)] };
  // A placeholder is not a change and not a look: only words reach a step. One place, so no prompt and no
  // preparation step can carry "wears ...." again.
  const words = people.map((p) => ({ ...p, faceEdit: realWords(p.faceEdit), outfit: realWords(p.outfit) }));
  const read = Object.fromEntries(Object.entries(looks).flatMap(([label, look]) => { const said = realWords(look); return said ? [[label, said]] : []; }));
  const scene = sceneWords(request);
  const steps: ReplaceStep[] = [];
  let video: StepInput = { asset: media[plan.video] };
  const faced = words.filter((p) => p.face);
  // One pass for two faces only with words for both pictures: the instruction sentence alone put the
  // second picture on the FIRST person and left the first picture without an effect (prompt 04d5fdcc,
  // 219 s), while the same pass with both pictures described landed both (prompt cac8c1f5). Until a
  // picture has been read, the chained passes stay: they are what lands the first person today.
  const described = faced.length === 2 && faced.every((p) => read[p.face!]);
  // Pictures go to the model in person order: the first colour (blue) marks the leftmost person.
  const pair = described ? [...faced].sort((a, b) => a.index - b.index) : undefined;
  if (pair) {
    const characters = pair.map((p) => prepareCharacter(p, words.indexOf(p), steps, media));
    const [first, second] = pair;
    const where = pair.map((p) => whereWords(p.index, words.length));
    const instruction = [
      `Only the ${where[0]}'s face becomes ${first.face} and the ${where[1]}'s face becomes ${second.face}; everyone else keeps their face, clothes and position.`,
      ...pair.flatMap((p, i) => (p.outfit ? [`The ${where[i]} wears ${p.outfit}.`] : [])),
      scene,
      "Keep the source video's full frame, camera, background, other people and motion.",
      plan.keep && `Keep ${plan.keep.replace(/^keep\s+/i, "")}.`,
    ].filter(Boolean).join(" ");
    const described = describeReplacePrompt({
      people: pair.map((p, i) => ({ where: where[i], look: read[p.face!], outfit: p.outfit })),
      scene,
      keep: plan.keep,
    });
    steps.push({
      id: "replace-both", label: `Replace ${first.target} and ${second.target}`, ...cap(REPLACE_CAPABILITY),
      inputs: { source_video: video, character_image: characters[0], character_image_2: characters[1] },
      controls: { person: scailPersonIndices(pair.map((p) => p.index)), two_people: true, prompt: described ?? instruction },
    });
    return { steps, missing: [] };
  }
  words.forEach((p, i) => {
    if (!p.face) return;
    const where = whereWords(p.index, words.length);
    // The mask index alone does not tell SCAIL which face to change: without an explicit
    // identity clause naming the person, the reference face can land on someone else.
    const character = prepareCharacter(p, i, steps, media);
    const described = describeReplacePrompt({ people: [{ where, look: read[p.face], outfit: p.outfit }], scene, keep: plan.keep });
    const id = `replace-${i}`;
    steps.push({
      id, label: `Replace ${p.target} with ${p.face}`, ...cap(REPLACE_CAPABILITY),
      inputs: { source_video: video, character_image: character },
      controls: {
        person: String(p.index),
        prompt: described ?? [
          `Only the ${where}'s face becomes ${p.face}; everyone else keeps their face, clothes and position.`,
          p.outfit && `The ${where} wears ${p.outfit}.`,
          scene,
          "Keep the source video's full frame, camera, background, other people and motion.",
          plan.keep && `Keep ${plan.keep.replace(/^keep\s+/i, "")}.`,
        ].filter(Boolean).join(" "),
      },
    });
    video = { step: id };
  });
  return { steps, missing: [] };
}

const cap = (c: { id: string; version: string }) => ({ capabilityId: c.id, version: c.version });
