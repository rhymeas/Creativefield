/*
 * One shot direction for every video app that turns a guide clip into a shot (Make it real today,
 * storyboard and keyframe shots next). An app describes WHAT the shot is - camera move, lens, who
 * stands where, which picture is whom - and this module writes it in the structured section format
 * MiniMax H3 reads (subject_definitions / summary / retention_analysis / ...), in one strict voice:
 * the guide clip's camera and blocking are kept, only the grey surfaces become real.
 *
 * Camera-POV idea (only what the camera sees is described, with entries and exits) after the
 * prompt compiler of ComfyUI Motion Previs Studio (MIT, navarisun1982/comfyui-motion-previs-studio,
 * povVisibilityEngine.ts / minimaxAdapter.ts); the wording and format here are our own.
 */

export type ScreenSide = "left" | "left of centre" | "centre" | "right of centre" | "right";
export type Framing = "full body" | "waist up" | "close-up";

export type ShotSubject = {
  /** The figure's name on the stage, for example "Ada". */
  label: string;
  /** The H3 picture slot that shows this person (1-based), when one is bound. */
  picture?: number;
  side: ScreenSide;
  framing: Framing;
  /** What the figure does during the shot, in screen terms ("walks toward the camera"). */
  action?: string;
  /** Seconds into the shot when the figure enters or leaves the frame. */
  entersAtSec?: number;
  exitsAtSec?: number;
};

export type ShotBrief = {
  durationSec: number;
  camera: {
    /** "a slow dolly in", "a locked-off static frame", ... (already in plain words). */
    move: string;
    lensMm: number;
    /** "eye level", "a high angle", "a low angle". */
    angle: string;
  };
  subjects: ShotSubject[];
  /** The picture that shows the location, when one is bound. */
  placePicture?: number;
  /** Pictures that are neither a subject nor the place (a prop, a style frame). */
  otherPictures?: number[];
  /** The person's own words; they win over everything generic. */
  direction?: string;
  /** Generated sound on or off. */
  sound: boolean;
};

const seconds = (value: number) => `${(Math.round(value * 10) / 10).toFixed(1)} s`;
const picture = (slot: number) => `<Picture ${slot}>`;
const sideWords: Record<ScreenSide, string> = {
  left: "on the left of frame",
  "left of centre": "just left of centre",
  centre: "in the centre of frame",
  "right of centre": "just right of centre",
  right: "on the right of frame",
};

function subjectLine(subject: ShotSubject, label?: string): string {
  const who = label ? `${label}, ${subject.label}` : "a person who fits the scene";
  const timing = [
    subject.entersAtSec !== undefined ? `enters the frame at ${seconds(subject.entersAtSec)}` : "",
    subject.exitsAtSec !== undefined ? `leaves the frame at ${seconds(subject.exitsAtSec)}` : "",
  ].filter(Boolean).join(" and ");
  return `The grey figure ${sideWords[subject.side]} becomes ${who}, framed ${subject.framing}${subject.action ? `, and ${subject.action}` : ""}${timing ? `; the figure ${timing}` : ""}.`;
}

/**
 * The H3 prompt for a shot, in MiniMax's full-reference rewrite format (VIDEO_PROMPT_WRITING_GUIDE_ref_en):
 * six "name:" sections in order, <Subject N> labels for content taken from a picture, a [task type] prefix
 * on the summary, one retention line per label with a fixed marker, and detailed_description as the main
 * body opened by a style sentence and [Shot 1]. Every sentence states what to keep or what to replace.
 */
export function compileShotDirection(brief: ShotBrief): string {
  const definitions = ["<Video 1> is the source video for the target video edit: a grey-block previsualisation clip whose untextured grey shapes stand for the people, props and places of the shot, and whose camera path, lens, framing and timing define the shot."];
  const retention = ["<Video 1> (camera, blocking and timing of [Shot 1]): partially_preserved - the camera path, lens, framing, timing, the position, size and screen side of every figure and object and each movement are kept exactly; every grey untextured surface is replaced with real people, materials, light and detail."];
  let next = 0;
  const subjectLabels = brief.subjects.map((subject) => {
    if (!subject.picture) return undefined;
    const label = `<Subject ${++next}>`;
    definitions.push(`${label} is ${subject.label}, the person in ${picture(subject.picture)}, with the same face, hair, body and clothes; in <Video 1> this person is the grey figure ${sideWords[subject.side]}.`);
    retention.push(`${label} (appears in [Shot 1]): fully_preserved - the face, hair, body and clothes of the person in ${picture(subject.picture)} are retained.`);
    return label;
  });
  let placeLabel: string | undefined;
  if (brief.placePicture) {
    placeLabel = `<Subject ${++next}>`;
    definitions.push(`${placeLabel} is the location in ${picture(brief.placePicture)}.`);
    retention.push(`${placeLabel} (appears in [Shot 1]): fully_preserved - the location's architecture, materials and light are retained, laid out where <Video 1> has its walls, floor and open space.`);
  }
  const otherLabels = (brief.otherPictures ?? []).map((slot) => {
    const label = `<Subject ${++next}>`;
    definitions.push(`${label} is the prop or look shown in ${picture(slot)}.`);
    retention.push(`${label} (appears in [Shot 1]): partially_preserved - its appearance as ${picture(slot)} shows it.`);
    return label;
  });

  const people = brief.subjects.length === 0
    ? "No person is in this shot; do not add one."
    : `${brief.subjects.length === 1 ? "Exactly one person is" : `Exactly ${brief.subjects.length} people are`} in this shot, no more. ${brief.subjects.map((subject, index) => subjectLine(subject, subjectLabels[index])).join(" ")}`;
  const place = placeLabel
    ? `The grey surroundings become ${placeLabel}, built where <Video 1> has its walls, floor and open space.`
    : "The grey surroundings become a real place built where <Video 1> has its walls, floor and open space; the blocks keep their size and position.";
  const extras = otherLabels.length ? `${otherLabels.join(", ")} appear${otherLabels.length === 1 ? "s" : ""} where the matching grey blocks stand.` : "";
  const named = [...subjectLabels.filter(Boolean), placeLabel, ...otherLabels].filter(Boolean) as string[];

  const sections = [
    ["subject_definitions", definitions.join("\n")],
    ["summary", `[video editing + reference generation] The target video is an edited version of <Video 1>: one continuous live-action shot of ${seconds(brief.durationSec)} with the camera and blocking of <Video 1>${named.length ? `, in which the grey shapes become ${named.join(", ")}` : ""}.`],
    ["retention_analysis", retention.join("\n")],
    ["detailed_description", [
      "Live-action, cinematic, photoreal, with natural light, real textures, believable shadows and reflections and slight film grain.",
      `[Shot 1] The camera keeps the move of <Video 1> exactly: ${brief.camera.move}, with a lens of about ${Math.round(brief.camera.lensMm)} mm, ${brief.camera.angle}. There are no cuts, no reframing and no other camera motion.`,
      people,
      place,
      extras,
      "Faces, wardrobe and props stay consistent for the whole shot.",
      brief.direction?.trim() ?? "",
    ].filter(Boolean).join(" ")],
    ["overall_soundscape", brief.sound ? "Natural sound of the scene: footsteps, room tone and ambience that fit the action." : "N/A"],
    ["non_diegetic_music", "N/A"],
  ];
  return sections.map(([title, body]) => `${title}:\n${body}`).join("\n");
}

/** The workflow's aspect option closest to the clip's own aspect, so the model never has to invent picture. */
export function closestAspectOption(ratio: number, options: readonly string[]): string | undefined {
  const parsed = options.map((option) => {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)/.exec(option);
    return match ? {option, ratio: Number(match[1]) / Number(match[2])} : null;
  }).filter((entry): entry is {option: string; ratio: number} => entry !== null);
  return parsed.sort((left, right) => Math.abs(Math.log(left.ratio / ratio)) - Math.abs(Math.log(right.ratio / ratio)))[0]?.option;
}

/** What a studio hands to a guide-clip video workflow besides the clip: the shot direction and the clip's aspect. */
export type VideoHandoff = {prompt: string; aspectRatio?: number};

/**
 * The prompt format MiniMax's base H3 video models (T2VA/I2VA/FL2VA) were trained on, written by the
 * rewriter: an optional picture-alignment instruction, then integrated_multimodal_description with the
 * first shot, then overall_soundscape and non_diegetic_music. The user's words stay verbatim inside
 * [Shot 1]; nothing is added to what the shot shows.
 */
export type H3BaseAlignment = "none" | "first" | "first-last";

export function shapeH3BasePrompt(prompt: string, options: { alignment: H3BaseAlignment; seconds?: number; sound?: boolean }): string {
  const text = prompt.trim();
  if (!text) return text;
  /* Already in the official shape (for example the Make it real writer): leave it alone. */
  if (/^integrated_multimodal_description:/m.test(text)) return text;
  const instruction = options.alignment === "first"
    ? "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."
    : options.alignment === "first-last"
      ? `How the reference pictures align with the target video — Picture 1 (from [Shot 1]) aligns with the 0.00-second mark of the target video; Picture 2 (from [Shot 1]) aligns with the ${(options.seconds ?? 0).toFixed(2)}-second mark of the target video.`
      : "";
  const fields = [
    `integrated_multimodal_description: [Shot 1] ${text}`,
    "",
    `overall_soundscape: ${options.sound === false ? "N/A" : "Natural ambience and action sounds that fit the action."}`,
    "",
    "non_diegetic_music: N/A",
  ].join("\n");
  return instruction ? `${instruction}\n\n${fields}` : fields;
}
