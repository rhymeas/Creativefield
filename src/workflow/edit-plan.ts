/* One edit sentence ("make his jacket red", "replace the mug with @Image 1", "remove the car in the back")
   read into two things: what SAM 3.1 should track, and what VACE should paint there. Rules answer first, so
   it works with no AI configured; the schema holds an optional text model's answer to the same shape. */
import { z } from "zod";
import { parseMentions } from "./reference-prompt";

/** What the area becomes when a picture supplies it. */
export const PICTURE_PROMPT = "The object in the picture.";
/** What is left where something was taken out. */
export const REMOVE_PROMPT = "Empty background that matches the scene.";
/** Said when the sentence cannot be read into a target and a change. */
export const UNREADABLE = "Say what to change, for example: make the jacket red.";

export const editPlanSchema = z
  .object({
    /** The short noun phrase SAM 3.1 tracks, at least two letters ("jacket", "car"). */
    target: z.string().trim().max(60),
    /** What that area becomes, as a full sentence for VACE. */
    prompt: z.string().trim().max(300),
    /** The @Image N used, 1-based. */
    reference: z.number().int().min(1).max(8).optional(),
  })
  .strict();
export type EditPlan = z.infer<typeof editPlanSchema>;

/** What the route answers: the plan, or plain words saying why it was not read. */
export type EditRead = EditPlan & { problems: string[] };

/** A picture the sentence names but this screen does not have. */
export function noPicture(index: number, images: number): string {
  return images ? `There is no @Image ${index} here.` : "Add a picture first, then say @Image 1.";
}

/** A target SAM can find: one to four words, at least two letters, and not a bare pronoun. */
export function trackable(target: string): boolean {
  const words = target.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 4 && /[a-z]{2}/i.test(target) && !VAGUE.has(target.trim().toLowerCase());
}

/** Problems that make a plan unusable, in words the user can act on. */
export function editPlanProblems(plan: EditPlan, images: number): string[] {
  const problems: string[] = [];
  if (!trackable(plan.target) || !plan.prompt.trim()) problems.push(UNREADABLE);
  if (plan.reference && plan.reference > images) problems.push(noPicture(plan.reference, images));
  return [...new Set(problems)];
}

/* ── Rules: enough for the sentences people actually write, no model needed ── */

const VAGUE = new Set([
  "it", "its", "them", "him", "her", "his", "this", "that", "these", "those", "me", "us", "you",
  "one", "ones", "thing", "things", "stuff", "anything", "something", "everything",
]);
const DETERMINERS = new Set([
  "the", "a", "an", "his", "her", "their", "its", "my", "your", "our",
  "this", "that", "these", "those", "some", "any",
]);
/** Words that end a noun phrase: where or with what it stands does not change what it is. */
const NOUN_TAIL = /\s+(?:in|on|at|from|near|behind|beside|above|below|under|inside|outside|next|with|and|or|that|which|who|to|for)\b[\s\S]*$/i;
const PHRASE_VERBS = new Set(["look", "looks", "looking", "appear", "appears", "become", "becomes", "be", "is", "are", "was", "were", "go", "stay", "feel", "feels"]);
/** Colours and looks: the words that say what a thing becomes. */
const STATE = new Set([
  "red", "orange", "yellow", "green", "blue", "purple", "pink", "brown", "black", "white", "grey", "gray",
  "gold", "golden", "silver", "neon", "teal", "cyan", "magenta", "beige", "navy", "violet", "turquoise",
  "maroon", "olive", "bronze", "copper", "cream", "ivory", "amber", "lime", "coral", "mint",
  "shiny", "matte", "glossy", "bright", "dark", "light", "pale", "deep", "clear", "transparent", "dirty",
  "clean", "broken", "new", "old", "big", "small", "large", "tiny", "huge", "short", "long", "wide",
  "narrow", "smooth", "rough", "metallic", "metal", "wooden", "leather", "wet", "dry", "dull", "vivid",
  "blurry", "sharp", "rusty", "worn", "torn", "ripped", "fancy", "plain", "warm", "cool", "cold", "hot",
  "very", "really", "super", "slightly", "bit", "kind", "sort", "more", "less", "too", "quite", "and",
]);
const ADJECTIVE_END = /(?:ish|ed|en|ous|ful|less|ive|er|est|y)$/i;
const BODY = ["face", "head", "eyes", "eye", "hands", "hand", "wrist", "neck", "ears", "ear", "nose", "mouth", "lips", "hair", "feet", "arms", "arm", "legs", "leg", "shoulders", "shoulder", "back", "chest", "waist", "fingers", "finger", "toes", "knees", "ankle", "ankles"];

const bare = (word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'-]+$/gu, "").toLowerCase();
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
const stripMentions = (text: string) => text.replace(/@\s*(?:image|img|video|vid)\s*\d{1,2}\b/gi, " ");
const imageIn = (text: string) => parseMentions(text).find((mention) => mention.kind === "image")?.index;

/** The noun phrase inside a wrapped phrase: "his jacket" -> "jacket", "the car in the back" -> "car". */
export function nounPhrase(text: string): string {
  let rest = stripMentions(text).replace(/\s+/g, " ").replace(/[.!?;,]+$/, "").trim();
  rest = rest.replace(/^[^\p{L}\p{N}]+/u, "");
  for (;;) {
    const first = /^([\p{L}'’-]+)\s+/u.exec(rest);
    if (!first || !DETERMINERS.has(first[1].toLowerCase())) break;
    rest = rest.slice(first[0].length);
  }
  // A determiner in the middle starts a new phrase: the noun phrase ended before it.
  rest = rest.replace(/\s+(?:the|a|an|his|her|their|its|my|your|our|this|that|these|those)\s+[\s\S]*$/i, "");
  rest = rest.replace(NOUN_TAIL, "");
  const words = rest.split(/\s+/).filter(Boolean);
  while (words.length && (DETERMINERS.has(bare(words[words.length - 1])) || PHRASE_VERBS.has(bare(words[words.length - 1])))) words.pop();
  return words.slice(0, 4).join(" ").replace(/[^\p{L}\p{N}'-]+$/u, "").trim();
}

/** The words that say what something becomes, taken off the end: "the wall dark blue" -> "dark blue". */
function stateOf(text: string): { state: string; rest: string } | undefined {
  const words = text.split(/\s+/).filter(Boolean);
  let start = words.length;
  while (start > 0 && STATE.has(bare(words[start - 1]))) start--;
  if (start === words.length && words.length > 1 && ADJECTIVE_END.test(bare(words[words.length - 1]))) start = words.length - 1;
  if (start === words.length) return undefined;
  const state = words.slice(start).join(" ").replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").replace(/^(?:a|an)\s+/i, "").replace(/^(?:bit|kind of|sort of)\s+/i, "").replace(/\s+(?:and|or)$/i, "");
  return state ? { state, rest: words.slice(0, start).join(" ") } : undefined;
}

/** The target as the change is said: a look the target already has ("red car") is not repeated in the new
 *  look, so "make the red car blue" reads "A blue car." */
function headOf(target: string): string {
  const words = target.split(/\s+/).filter(Boolean);
  while (words.length > 1 && STATE.has(bare(words[0]))) words.shift();
  return words.join(" ");
}

function unread(problem: string): EditRead {
  return { target: "", prompt: "", problems: [problem] };
}

function planEdit(target: string, prompt: string, reference?: number): EditRead {
  if (!trackable(target)) return unread(UNREADABLE);
  return { target, prompt, problems: [], ...(reference ? { reference } : {}) };
}

const REMOVE = /\b(?:remove|delete|erase|get rid of|take out|take away|drop)\b\s+(.+)$/i;
const REPLACE = /\b(?:replace|swap)\b\s+(.+?)\s+(?:with|by|for|using)\s+(.+)$/i;
const PUT = /\b(?:put|place|add|stick)\b\s+(.+?)\s+(on|onto|over|in|into|inside|at|to)\s+(.+)$/i;
const MAKE = /\b(?:make|turn|paint|dye|change|recolor|recolour|give)\b\s+(.+)$/i;

/** Reads one sentence against the pictures on screen. Never invents a picture or a target. */
export function heuristicEditPlan(said: string, images = 0): EditRead {
  const text = said.replace(/\s+/g, " ").trim();
  const named = parseMentions(text).filter((mention) => mention.kind === "image").map((mention) => mention.index);
  const outside = named.find((index) => index > images);
  if (outside) return unread(noPicture(outside, images));
  const reference = named[0];
  if (!images && !reference && /\b(?:picture|image|photo|pic)\b/i.test(stripMentions(text))) return unread("Add a picture first.");
  if (!text) return unread(UNREADABLE);

  const remove = REMOVE.exec(text);
  if (remove) return planEdit(nounPhrase(remove[1]), REMOVE_PROMPT, reference);

  const replace = REPLACE.exec(text);
  if (replace) {
    const target = nounPhrase(replace[1]), source = replace[2], picture = imageIn(source);
    if (picture || /\b(?:picture|image|photo|pic)\b/i.test(source)) return planEdit(target, PICTURE_PROMPT, picture ?? reference);
    const state = stateOf(stripMentions(source))?.state ?? stripMentions(source).replace(/^(?:the|a|an)\s+/i, "").replace(/\s+(?:one|ones)$/i, "").trim();
    return state ? planEdit(target, cap(`${article(state)} ${state} ${headOf(target)}.`), reference) : unread(UNREADABLE);
  }

  const put = PUT.exec(text);
  if (put) {
    const thing = nounPhrase(put[1]), place = put[3].replace(/[.!?;,]+$/, "").trim();
    const body = BODY.find((part) => new RegExp(`\\b${part}\\b`, "i").test(place));
    const preposition = bare(put[2]) === "to" ? "on" : bare(put[2]).replace(/^(?:onto)$/i, "on").replace(/^(?:into|inside)$/i, "in");
    return planEdit(body ?? thing, cap(`${thing} ${preposition} ${place}.`), reference);
  }

  const make = MAKE.exec(text);
  if (make) {
    const rest = make[1].trim(), picture = imageIn(rest);
    if (picture) return planEdit(nounPhrase(stripMentions(rest)), PICTURE_PROMPT, picture);
    const split = /\b(?:in)?to\s+(.+)$/i.exec(rest);
    const read = split ? { state: split[1], rest: rest.slice(0, split.index) } : stateOf(rest);
    if (!read) return unread(UNREADABLE);
    const target = nounPhrase(read.rest), state = stateOf(read.state)?.state ?? read.state.trim();
    return planEdit(target, cap(`${article(state)} ${state} ${headOf(target)}.`), reference);
  }

  return unread(UNREADABLE);
}

/** Instruction for a local text model; its answer is held to the schema and to the pictures on screen. */
export function editPlannerInstruction(images: number): string {
  return [
    "You read one sentence about changing a video and return only strict JSON, no markdown.",
    'Shape: {"target":"jacket","prompt":"A red jacket.","reference":1}.',
    "target is the short noun phrase SAM 3.1 can find in every frame: the thing that is already there and changes, without the, a, his or her (his jacket -> jacket, the car in the back -> car). At least two letters.",
    "prompt says what that area becomes, as one short sentence ending in a full stop. For a removal write: Empty background that matches the scene.",
    images ? `reference is the @Image N the sentence uses, from 1 to ${images}; leave it out when no picture is used.` : "There are no pictures here: leave reference out and never use @Image.",
    "Never invent a picture or a reference the sentence does not name.",
  ].join("\n");
}
