/* @-reference prompts ("replace the face from @Image 1 onto the person in @Video 1 …"): mention parsing, the
   per-person plan they turn into, and a rule-based planner used when no local text model is available.
   A plan may only use references that appear in the prompt; the user reviews it before anything runs. */
import { z } from "zod";

export type MentionKind = "image" | "video";
export type Mention = { kind: MentionKind; index: number; label: string; start: number; end: number };

/** "@Image 1", "@image1", "@Img 2", "@Video 1", "@vid2" — case and spacing are forgiven, numbering starts at 1. */
const MENTION = /@\s*(image|img|video|vid)\s*(\d{1,2})\b/gi;

export const mentionLabel = (kind: MentionKind, index: number) => `@${kind === "image" ? "Image" : "Video"} ${index}`;

export function parseMentions(prompt: string): Mention[] {
  const out: Mention[] = [];
  for (const m of prompt.matchAll(MENTION)) {
    const kind: MentionKind = /^v/i.test(m[1]) ? "video" : "image", index = Number(m[2]);
    if (index >= 1) out.push({ kind, index, label: mentionLabel(kind, index), start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** Distinct references in first-use order. */
export function referencedLabels(prompt: string): string[] {
  return [...new Set(parseMentions(prompt).map((m) => m.label))];
}

const label = z.string().regex(/^@(Image|Video) \d{1,2}$/);
export const referencePersonSchema = z.object({
  /** Which person in the video, as a short spatial description SAM 3 can track ("person on the left"). */
  target: z.string().trim().min(1).max(120),
  /** Face to put on this person, if any. */
  face: label.optional(),
  /** Small change to that face before it is used ("slightly slimmer, sharper jawline"). */
  faceEdit: z.string().trim().max(300).optional(),
  /** What this person wears afterwards. */
  outfit: z.string().trim().max(300).optional(),
});
export const referencePlanSchema = z.object({
  video: label,
  people: z.array(referencePersonSchema).min(1).max(4),
  /** What must stay as in the source, in the user's words. */
  keep: z.string().trim().max(300).optional(),
}).strict();
export type ReferencePlan = z.infer<typeof referencePlanSchema>;
export type ReferencePerson = z.infer<typeof referencePersonSchema>;

/** Problems that make a plan unusable: unknown references, a non-video source, a face that is a video. */
export function planProblems(plan: ReferencePlan, prompt: string): string[] {
  const known = new Set(referencedLabels(prompt)), problems: string[] = [];
  if (!plan.video.startsWith("@Video")) problems.push("The source must be a video reference.");
  if (!known.has(plan.video)) problems.push(`${plan.video} is not in the prompt.`);
  for (const p of plan.people) {
    if (p.face && !p.face.startsWith("@Image")) problems.push(`A face must be an image reference, not ${p.face}.`);
    if (p.face && !known.has(p.face)) problems.push(`${p.face} is not in the prompt.`);
    if (!p.face && !p.outfit && !p.faceEdit) problems.push(`Nothing changes for "${p.target}".`);
  }
  return problems;
}

const POSITIONS = ["person on the left", "person on the right", "third person from the left", "fourth person from the left"];
const ORDINAL_WORDS: Record<string, string> = { "1st": "first", first: "first", "2nd": "second", second: "second", "3rd": "third", third: "third", "4th": "fourth", fourth: "fourth" };
/** Where a sentence says a person stands: "the 2nd person from the left", "the person on the right". */
export function namedPosition(text: string): string | undefined {
  const nth = /\b(1st|2nd|3rd|4th|first|second|third|fourth)\s+person\b/i.exec(text)?.[1];
  if (nth) return `${ORDINAL_WORDS[nth.toLowerCase()]} person from the left`;
  const side = /\b(?:on|at) the (left|right)\b|\b(leftmost|rightmost)\b/i.exec(text);
  if (side) return (side[1] ?? side[2]).toLowerCase().startsWith("l") ? "person on the left" : "person on the right";
  if (/\b(?:in|at) the (?:middle|center|centre)\b/i.test(text)) return "person in the middle";
  return undefined;
}
const sentences = (text: string) => text.split(/(?<=[.!?;])\s+|\s+(?:and then|and make|but besides that|besides that|also)\s+/i).map((s) => s.trim()).filter(Boolean);

/** Rule-based plan: faces map to people left to right in mention order; a wardrobe clause applies to everyone;
 * a clause that names one image and its face becomes that face's edit. Good enough to start; the user corrects it. */
export function heuristicPlan(prompt: string): ReferencePlan | null {
  const mentions = parseMentions(prompt);
  const video = mentions.find((m) => m.kind === "video")?.label;
  if (!video) return null;
  const faces = [...new Set(mentions.filter((m) => m.kind === "image").map((m) => m.label))].slice(0, 4);
  const clauses = sentences(prompt.replace(/\s+/g, " "));
  const outfitClause = clauses.find((c) => /\b(wear|wearing|clothes|clothing|outfit|dress(ed)?|jacket|jewel)/i.test(c));
  const outfit = outfitClause ? (/(?:wear|wearing|in)\s+(.+?)(?:\s+and make\b|$)/i.exec(outfitClause)?.[1] ?? outfitClause).replace(/@\s*(image|img|video|vid)\s*\d+/gi, "").trim().slice(0, 300) : undefined;
  const people: ReferencePerson[] = (faces.length ? faces : [undefined]).map((face, i) => {
    const edit = face && clauses.find((c) => referencedLabels(c).includes(face) && /\bface\b/i.test(c) && /\b(skinn|slim|thin|jaw|younger|older|smil|less|more)\w*/i.test(c) && !/\breplac/i.test(c));
    return {
      target: (face && namedPosition(clauses.filter((c) => referencedLabels(c).includes(face)).join(" "))) || POSITIONS[i] || `person ${i + 1}`,
      ...(face ? { face } : {}),
      ...(edit ? { faceEdit: (/\b(?:slightly|a (?:little )?bit|somewhat|more|less|skinn|slim|thin|sharper|younger|older)\w*\b.*$/i.exec(edit)?.[0] ?? edit).slice(0, 300) } : {}),
      ...(outfit ? { outfit } : {}),
    };
  });
  const keep = clauses.find((c) => /\bkeep\b/i.test(c));
  return { video, people, ...(keep ? { keep: keep.slice(0, 300) } : {}) };
}

/** Instruction for a local text model; the answer is validated against the schema and the prompt's references. */
export function plannerInstruction(prompt: string): string {
  return [
    "You turn a video editing request into strict JSON. Return only JSON, no markdown.",
    'Shape: {"video":"@Video N","people":[{"target":"person on the left","face":"@Image N","faceEdit":"...","outfit":"..."}],"keep":"..."}.',
    "Rules: use only references written in the request, exactly as @Image N or @Video N. One people entry per person who changes.",
    "target is a short spatial description of that person in the video (person on the left, person on the right, person in the middle).",
    "If several faces go onto several people and no order is given, map them left to right in the order they are mentioned.",
    "faceEdit only when the request changes the face itself (for example slimmer, sharper jawline); keep it small and in the user's words.",
    "outfit when the request changes clothing; apply a shared clothing request to every person it covers. Omit fields that do not apply.",
    `Request: ${prompt}`,
  ].join("\n");
}

/* ── The look words: SCAIL-2 re-renders the whole frame from the prompt, so a request that only
   names pictures ("replace him with @Image 1") moves nothing (measured: 3e24470e, 2dec4cac).
   A sentence that SAYS how each person looks is what puts both pictures on the right people. ── */

/** What the vision model is asked about one character picture. */
export function lookInstruction(): string {
  return [
    "Look at the picture and describe only how this person looks.",
    "One short sentence, no names, no place, no camera words, at most 30 words.",
    "Name the hair (length, colour, style), any beard or moustache, glasses, and the clothes with their colours.",
    "Answer with the sentence alone.",
  ].join("\n");
}

/** One short line from what the vision model answered, or undefined when it gave nothing usable.
 *  The words go after "has", so a lead-in ("the picture shows", "a bearded man with") is dropped and
 *  the first letter is lowered: "bearded man with short brown hair" becomes "short brown hair". */
export function lookWords(answer: string): string | undefined {
  const joined = answer.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ");
  const line = joined
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "")
    .replace(/^(?:the picture shows|this picture shows|in the picture|this is|a photo of|an image of|the person is|the man is|the woman is)\s+/i, "")
    .replace(/^(?:(?:a|an|the)\s+)?(?:\w+\s+)?(?:man|woman|person|guy|lady|male|female)\s+(?:with|wearing|in)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^(.{8,}?[.!?])(?:\s|$)/.exec(line)?.[1] ?? line;
  const words = sentence.replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim().replace(/^([A-Z])(?=[a-z])/, (letter) => letter.toLowerCase());
  return words.length >= 8 ? words.slice(0, 200) : undefined;
}

const PEOPLE_COUNT = ["", "One person.", "Two people.", "Three people.", "Four people."];
export type LookedPerson = { where: string; look?: string; outfit?: string };

/** The user's own scene words as one sentence of the describing prompt. */
const sceneSentence = (scene: string) => {
  const text = scene.trim().replace(/[.,;:\s]+$/, "");
  if (!text) return undefined;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
};

/** The sentence a two-picture pass runs on: what the frame holds and how each replaced person
 *  looks, then the user's own scene words. Without a look for every person there is nothing to
 *  describe, so the caller keeps the instruction sentence it would have sent anyway. */
export function describeReplacePrompt(input: { people: readonly LookedPerson[]; scene?: string; keep?: string }): string | undefined {
  if (!input.people.length || input.people.some((person) => !person.look)) return undefined;
  return [
    PEOPLE_COUNT[input.people.length] ?? `${input.people.length} people.`,
    ...input.people.map((person) => `The ${person.where} has ${person.look}${person.outfit ? ` and wears ${person.outfit}` : ""}.`),
    input.scene && sceneSentence(input.scene),
    "Keep the source video's full frame, camera, background and motion.",
    input.keep && `Keep ${input.keep.replace(/^keep\s+/i, "")}.`,
  ].filter(Boolean).join(" ");
}
