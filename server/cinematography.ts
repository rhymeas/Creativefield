/* The cinematography layer (CONVE-2511): every planned shot is a motivated camera decision inside a sequence, never a
   posed picture. One place for the wording, so the storyboard planner and the video prompt assistant say the same. */

/** Director pass: decided once for the whole sequence, before any shot is written. */
export const DIRECTOR_PASS = [
  "First direct the whole sequence: decide the blocking, the action axis and keep every camera on one side of it unless a crossing is intended,",
  "state screen direction and eyelines (for example: she is screen-left looking screen-right, the robot screen-right facing screen-left),",
  "vary shot sizes in a deliberate rhythm (wide orientation, over-the-shoulder, insert, dirty close-up, low tracking, extreme close-up, new wide),",
  "and plan how each shot leads into the next by eyeline, motion direction, brightness or a graphic match of shapes.",
].join(" ");

/** DP pass: what every single shot prompt must decide, in words a picture model can follow. */
export const DP_PASS = [
  "Then write each shot as a director of photography: the camera's physical position relative to the action (distance, height, side, what it looks across),",
  "the shot size and what is deliberately cropped, foreground, midground and background with occlusion (shoot through a doorway, window or plants,",
  "or a dirty frame of the other character's soft shoulder taking 30 to 50 percent), the subject hierarchy, eyeline and screen direction,",
  "the lens as perspective (wide and close for spatial discovery, long and far for reactions), the focus plane with moderate depth of field,",
  "and the narrative intent: what the viewer understands or feels in this moment and what is held back.",
].join(" ");

/** What generators do by reflex and a film does not. */
export const NEVER_BY_REFLEX = [
  "Do not show people in full by reflex, do not turn faces to the camera, do not centre objects, do not stage poses:",
  "every frame should feel captured inside an unfolding scene. A reduced close-up can be stronger than a layered composition;",
  "choose by the shot's dramatic function, and give negative space and every crop a purpose.",
].join(" ");

/** Camera keys: what every keyframe prompt states explicitly, because a picture model falls back to a centred,
 *  eye-level, duplicated layout whenever these are left vague. */
export const CAMERA_KEYS = [
  "Every keyframe prompt states its camera keys explicitly:",
  "(1) the exact cast count once (for example: exactly one woman and one robot in the whole frame), each person and object described in one place only,",
  "and foreground occlusion made of props or architecture, never a second copy of a character;",
  "(2) camera height in centimetres or metres and tilt in degrees, never plain eye level except for an intimate dialogue close-up:",
  "choose floor, knee, hip, high or overhead by what the shot must say;",
  "(3) placement on the frame: the subject on a vertical third line or cut by a frame edge, never in the centre, with looking room toward the eyeline;",
  "(4) exposure for the highlights: sky and sea keep colour and detail, no clipped white areas.",
].join(" ");

/** Emotion decides the shot: size, lens, height and focus follow from what the viewer should feel. */
export const EMOTION_TO_CAMERA = [
  "Choose the shot from the emotion:",
  "awe and scale: extreme wide, the figure tiny against the world, 18-24mm from far or a long lens compressing layers, high or very low;",
  "discovery and curiosity: wide lens close to the ground or behind an obstruction, revealing by occlusion;",
  "intimacy and reaction: close-up on a long lens (85-135mm) from the side, shallow focus, a soft foreground element;",
  "tension and judgement: dirty over-the-shoulder on 50mm, slightly low, a few degrees of Dutch angle;",
  "comedy and physical action: medium wide on 28-35mm so cause and effect stay in one frame;",
  "triumph: low angle on a wide lens; isolation or calm: wide frame with purposeful negative space.",
].join(" ");

/** Scale cues: the eye reads distance and size only from things it already knows. */
export const SCALE_CUES = [
  "Give every wide or scale shot elements of known size that let the eye read distance and scale (a person, a palm tree, a door, a car, a boat, a railing, a cup),",
  "plus overlap and atmospheric haze that lightens and softens what is farther away.",
].join(" ");

/** The twelve film-still rules (user direction 2026-11-23), condensed: they apply to every cinematic image. */
export const FILM_STILL_RULES = [
  "Film still rules: motivated camera placement chosen for the emotion, physically present in the scene, never default eye-level straight-on three-quarter;",
  "strong depth with at least two clear planes, usually foreground, midground and background, foreground framing by architecture, objects or environment that may partly obscure;",
  "intentional asymmetry and purposeful negative space, symmetry only when it tells something;",
  "dynamic geometry with diagonals, converging lines and overlapping forms guiding the eye, one clear focal point;",
  "an unfinished moment: transitional gestures, shifting weight, cause and effect in clothing, hair, dust or water, reacting to something in or beyond the frame;",
  "selective information: overlap, partial framing, occlusion and depth of field, not everything equally visible;",
  "motivated light from plausible sources, some surfaces falling into shadow, believable exposure, no artificial rim light or bloom;",
  "lens discipline: depth of field consistent with focal length, distance and placement;",
  "environmental contact: feet on the ground, hands on surfaces, shadows, reflections, displaced dust or water, never composited-looking;",
  "controlled imperfection; frame economy, every element contributes;",
  "a frame from an ongoing scene, never character-sheet framing, hero poses, product-style centring or a scenic backdrop.",
  "Cinematic quality comes from decisions, not from added shallow focus, flares, grain or extreme angles.",
].join(" ");

/** Master rules V3 (user direction 2026-11-23): generic words like "layered foreground" are not enforceable, so each
 *  shot is first constructed concretely (A-J) and the prompt carries those visible, spatial decisions. */
export const SHOT_CONSTRUCTION = [
  "Construct every shot before writing its prompt and put the decisions in the prompt as visible spatial instructions, not adjectives:",
  "A dramatic intention; B camera location (height, distance, angle, what restricts its view);",
  "C foreground anchor when the place offers one: the object's identity, the frame edge or corner it enters from, about 10 to 35 percent of the frame, its distance and how defocused it is;",
  "D subject placement: screen region, what is cropped, where the visual weight sits; E how foreground, action plane and deep background overlap;",
  "F the lines, shapes or contrasts that guide the eye; G light: key source and direction, fill, practicals, and where a subtle broken rim of light from a window, the sun or a bright surface catches hair, shoulder or profile;",
  "H lens: focal length, distance, depth of field and one or two restrained optical traits that fit (gentle halation on practicals, slight veiling glare, soft vignetting, organic bokeh, fine grain);",
  "I the exact instant of action; J how it connects to the shots before and after.",
  "Example of the required precision: camera 60 cm behind a dark window frame, angled across the street; the frame cuts into the upper left 20 percent, heavily defocused; the subject in the lower right third overlapping distant practical lights; a warm storefront behind her draws a narrow uneven highlight on her hair and shoulder; subtle halation on the lights.",
].join(" ");

/** Reject and recompose; and never turn the rules into a new formula. */
export const QUALITY_GATE = [
  "Reject and recompose a frame that is centred without reason, lacks depth, skips a natural foreground opportunity, looks like a promotional or character-presentation angle,",
  "shows posed characters, flat lighting unconnected to sources, a sterile or exaggerated lens, everything evenly spaced and fully visible, or repeats the previous shot.",
  "Fix the camera position, foreground relationship, placement, geometry, light direction and timing first, never by adding atmosphere, blur or effects.",
  "Do not mechanically put an object in front of every shot or push every subject off-centre; vary it by purpose so no new formula appears.",
].join(" ");

/** The block that goes in front of every cinematic image prompt (user's wording, 2026-11-23): short enough for a
 *  picture model to follow, while the planner above carries the long rules. */
export const IMAGE_CINEMATOGRAPHY = [
  "Compose the image as an authentic still frame extracted from an ongoing feature film, not a promotional render, character showcase or posed illustration.",
  "Establish a clear narrative focal point and intentional visual hierarchy. Position the camera according to the emotional and narrative purpose of the scene, rather than simply maximizing subject visibility.",
  "Create meaningful foreground, midground and background separation through perspective, overlapping silhouettes, environmental framing, occlusion and selective depth of field.",
  "Use asymmetric visual balance, motivated negative space, natural eyelines, directional composition and intentional cropping. Allow characters and environmental elements to extend beyond the frame when appropriate. Avoid unnecessary full-body visibility.",
  "Capture characters in the middle of a believable action, reaction or interaction. Their posture, gestures, facial expressions and spatial relationships should communicate narrative subtext without requiring dialogue.",
  "Maintain physical scale, spatial continuity and logical relationships between characters, props and their surroundings. Every visible object should have a plausible position and purpose within the scene.",
  "Use motivated lighting, natural material responses and controlled contrast to support the emotional focal point rather than decorating the entire frame.",
  "The composition should imply a larger world beyond the frame, a preceding event and an anticipated next moment.",
  "Avoid static character presentation, artificial symmetry, disconnected subjects, excessive empty space, arbitrary foreground objects, exaggerated bokeh and unmotivated dramatic lighting.",
].join(" ");

/** The shot-sheet prompt (user-approved 2026-11-23, "das muss zementiert werden"): a picture model follows concrete
 *  screen positions and physical contact, not composition principles. Only the topic changes between shots; the
 *  structure stays. Every object touches something; small things are sized against a known object beside them. */
export type ShotSheet = {
  /** e.g. "handheld 35mm camera at seated chest height, slightly tilted, 50mm lens, shot through a monstera plant in the loft at golden hour" */
  camera: string;
  /** Near to far. region: "Near, left 30 percent", "Middle, right half", "On the table next to her laptop", "Far" */
  frame: Array<{region: string; content: string}>;
  /** Key source and direction, plus where a thin rim of light falls. */
  light: string;
  /** The exact instant: what just happened, what is about to happen. */
  moment: string;
  /** Optional override of the film look line. */
  look?: string;
  /** The dominant read: "Kip is the main read; Maya is secondary." One focal priority per frame. */
  focus?: string;
  /** Relational scale, never only metres or another object's name: "Kip is no larger than her espresso glass." */
  scale?: string;
  /** Plain reference roles: "@Image 1 gives only Maya's identity, face, hair and outfit, never her pose, size or framing." */
  references?: string[];
  /** The shot formula: one framing, one angle, one composition technique, one lighting treatment, two moods
   *  (e.g. Medium Close-Up, Low-Angle, Dirty Foreground Occlusion, Subtle Warm Rim Light; intimate, mysterious). */
  shot?: ShotFormula;
  /** The cast in this frame. Their look lines and reference roles are generated from it, so a character who is not in
   *  the shot can never leak into it through a look sentence. */
  cast?: Array<CastReference & {look?: string}>;
};
export type ShotFormula = {framing: string; angle: string; composition: string; lighting: string; mood?: string[]};

/** Searchable shot vocabulary (user library 2026-11-23). Pick one of each; do not stack effects. */
export const SHOT_VOCABULARY = {
  framing: ["Extreme Wide Shot", "Wide Establishing Shot", "Long Shot", "Full Shot", "Medium Long Shot", "Medium Shot", "Medium Close-Up", "Close-Up", "Extreme Close-Up", "Insert Shot", "Over-the-Shoulder", "Dirty Over-the-Shoulder", "Point-of-View", "Two-Shot", "Profile Shot", "Silhouette Shot"],
  angle: ["Worm's-Eye View", "Ground-Level Shot", "Low-Angle Shot", "Hip-Level Shot", "Eye-Level Shot", "High-Angle Shot", "Bird's-Eye View", "Top-Down Shot", "Dutch Angle", "Canted Low-Angle Shot", "Oblique Angle", "Rear Three-Quarter Shot", "Overhead POV", "Under-Object Shot", "Trunk Shot", "Frame-Within-a-Frame Shot"],
  lens: ["Ultra-Wide Close-Up 14mm", "Wide-Angle Perspective 24mm", "Natural Perspective 35mm", "Normal Lens 50mm", "Portrait Telephoto 85mm", "Long-Lens Shot 135mm", "Super-Telephoto Shot 400mm", "Extreme Telephoto 800mm", "Macro Shot 100mm", "Fisheye Shot", "Split-Diopter Shot", "Deep-Focus Shot", "Shallow-Focus Shot", "Rack-Focus Shot", "Tilt-Shift Shot", "Vintage Soft-Focus Shot", "Anamorphic Flare Shot"],
  composition: ["Shoot-Through Shot", "Foreground Occlusion", "Dirty Frame Composition", "Layered Depth Composition", "Extreme Negative Space", "Edge-Framed Subject", "Off-Center Composition", "Deep Corridor Shot", "Symmetrical One-Point Perspective", "Asymmetrical Balance", "Leading-Line Composition", "Reflection Shot", "Through-Glass Shot", "Through-Doorway Shot", "Backlit Silhouette", "Foreground Bokeh", "Extreme Scale Contrast", "Forced Perspective"],
  lighting: ["Subtle Warm Rim Light", "Hard Backlight Silhouette", "Window Light with Blind Stripes", "Low Golden Sun Flare", "Practical Light Pools", "Overcast Soft Light", "Deep Shadow with One Source"],
  movement: ["Slow Dolly-In", "Slow Dolly-Out", "Push-In Close-Up", "Tracking Shot", "Lateral Tracking Shot", "Whip Pan", "Crash Zoom", "Dolly Zoom", "Arc Shot", "Orbit Shot", "Handheld Tracking", "Steadicam Follow", "Snorricam", "Low-Angle Tracking", "Crane Reveal", "Tilt-Up Reveal", "Slow Pan Reveal", "Static Long Take"],
} as const;
/** A small style pack: too many style labels dilute the structure (user analysis, 2026-11-23). */
export const SHOT_SHEET_LOOK = "a frame from a feature film, handheld 35mm, fine grain, gentle halation in the highlights, a subtle rim of light, not a stock photo, no posing; the camera is never at standing eye level unless stated; characters keep the stylised look of their reference pictures.";

/** Render a shot sheet in the approved format. Pure. Shot first, theory never: it reads like a DP talking to a
 *  storyboard artist. One strong idea per depth layer; small objects get only the few details that read at that size,
 *  or the model enlarges them to show the detail. */
export function shotSheetPrompt(sheet: ShotSheet): string {
  const formula = sheet.shot
    ? [`SHOT: ${[sheet.shot.framing, sheet.shot.angle, sheet.shot.composition, sheet.shot.lighting].join(", ")}${sheet.shot.mood?.length ? `; ${sheet.shot.mood.join(", ")}` : ""}.`]
    : [];
  const looks = (sheet.cast ?? []).map(member => member.look).filter((look): look is string => !!look);
  const roles = sheet.cast?.length ? referenceRoles(sheet.cast) : sheet.references ?? [];
  return [
    `FILM STILL from a feature film, ${sheet.camera}.`,
    ...formula,
    "FRAME, near to far:",
    ...sheet.frame.map(part => `- ${part.region}: ${part.content}`),
    ...(sheet.focus ? [`FOCUS: ${sheet.focus}`] : []),
    ...(sheet.scale ? [`SCALE: ${sheet.scale}`] : []),
    `LIGHT: ${sheet.light}`,
    `MOMENT: ${sheet.moment}`,
    `LOOK: ${[sheet.look ?? SHOT_SHEET_LOOK, ...looks].join(" ")}`,
    ...(roles.length ? ["REFERENCES:", ...roles] : []),
  ].join("\n");
}

/** Named shot recipes (user library, 2026-11-23): the director picks one by intent instead of writing a centred medium
 *  shot with adjectives. Each recipe fixes the physical camera, the near plane, the crop and the light, in words a
 *  picture model can stage. Perspective comes from camera position and distances; the lens sets the field of view. */
export type ShotRecipe = {id: string; name: string; use: string; camera: string; near: string; subject: string; light: string};
export const SHOT_RECIPES: ShotRecipe[] = [
  {id: "telephoto-compression", name: "Telephoto compression", use: "arrival, pursuit, threat that feels close",
    camera: "camera very far away on a 600mm telephoto lens, eye line of the street, heat shimmer between camera and subject",
    near: "nothing near the lens; distant layers stacked flat on top of each other", subject: "the subject advancing straight toward the camera, stacked against enormous background objects that look adjacent", light: "backlight through haze, low contrast in the distance"},
  {id: "wide-closeup", name: "Wide close-up", use: "energy, intimacy with tension, a character dominating space",
    camera: "18mm lens a hand's width from the face", near: "the face filling a third of the frame, slightly distorted", subject: "the room or landscape stretching away dramatically behind the face", light: "a practical source behind the head, rim on hair"},
  {id: "fisheye-architecture", name: "Fisheye architecture", use: "absurdity, chaos, a place larger than the people",
    camera: "8mm fisheye lens very low or very high", near: "furniture or architecture bending and looming larger than the actors", subject: "people small inside a curved space", light: "mixed practicals, uneven"},
  {id: "macro-insert", name: "Macro insert", use: "a decisive detail, a reaction of an object",
    camera: "100mm macro lens centimetres from the detail", near: "one small surface filling the whole frame", subject: "a single detail sharp on a razor-thin plane, everything else melting soft", light: "one specular highlight shaping the detail"},
  {id: "doorway-observation", name: "Doorway observation", use: "secrecy, watching, private moments",
    camera: "50mm lens behind a door frame or another person's shoulder", near: "the dark door frame or a soft shoulder covering 30 to 40 percent of one side", subject: "the subject seen through the remaining gap, unaware", light: "the subject's room brighter than the camera side"},
  {id: "deep-focus-three-planes", name: "Deep focus, three planes", use: "two stories at once, consequence in the background",
    camera: "24mm lens at f11, everything readable", near: "a large figure or object in the near foreground", subject: "a separate action in the midground and a third subject far behind, all sharp", light: "even daylight with a bright window or opening far behind"},
  {id: "split-diopter", name: "Split diopter", use: "confrontation across distance, two attentions",
    camera: "split-field diopter, the optical seam hidden on an architectural edge", near: "a huge sharp face on one side", subject: "a smaller person far behind on the other side, also sharp", light: "separate pools of light for both"},
  {id: "silhouette-backlight", name: "Silhouette backlight", use: "menace, heroism, arrival out of light",
    camera: "low camera into the light, 50mm", near: "dust, spray or smoke catching the light", subject: "the figure almost black, readable by a broken outline", light: "one strong source behind the subject, deep shadow everywhere else"},
  {id: "object-pov", name: "Object POV", use: "surprise, a non-human point of view",
    camera: "camera inside or under an object (a glass, a glovebox, a car footwell), 24mm", near: "the object's opening framing the image", subject: "the character leaning toward the opening", light: "light falling in through the opening"},
  {id: "tunnel-frame", name: "Frame within a frame", use: "isolation, smallness, a passage",
    camera: "deep inside an architectural opening, 35mm", near: "the dark structure covering most of the frame", subject: "small figures in the bright opening", light: "bright exterior, dark interior, reflections on wet surfaces"},
  {id: "elevated-vertigo", name: "Elevated vertigo", use: "scale, power, decisions above a world",
    camera: "right behind a character standing at a height, 24mm, looking down past them", near: "the character's dark silhouette dominating the near plane", subject: "the city, coast or crowd dropping away far below", light: "backlight with atmospheric haze below"},
  {id: "low-action-track", name: "Low action track", use: "speed, chases, momentum",
    camera: "tracking a hand's width above the ground right beside a moving vehicle or runner, 24mm", near: "the wheel, foot or bumper rushing past, motion-blurred", subject: "the subject cutting diagonally across the frame, the road receding in strong perspective", light: "low sun flaring, streaks of reflected light"},
  {id: "small-against-event", name: "Small against the event", use: "awe, overwhelming scale, a turning point",
    camera: "wide 18mm from far behind and below", near: "a tiny figure at the bottom edge", subject: "a huge natural or architectural event filling the sky", light: "warm and cool layers of light scattering in the air"},
  {id: "vintage-imperfect", name: "Imperfect vintage optics", use: "memory, dream, nostalgia",
    camera: "vintage lens with soft, uneven edges, 50mm", near: "edges smeared and darkened unevenly", subject: "a clear central subject", light: "soft halation, slight colour fringing at high contrast"},
  {id: "inverted-perspective", name: "Inverted perspective", use: "a fall, a flip of fortune, disorientation",
    camera: "the whole frame rotated so the world hangs above, 24mm", near: "the environment upside down overhead", subject: "the character falling or floating in large negative space", light: "light from below the frame"},
  {id: "intimate-portrait", name: "Intimate portrait", use: "emotion, a quiet reaction",
    camera: "85-100mm lens from the side at a lower or higher angle, never frontal", near: "a soft out-of-focus edge of another character or object", subject: "the face cropped at the chest, eyes off-camera", light: "window or practical key from the side, a thin rim"},
];

/** Find a recipe by id; undefined for an unknown id. Pure. */
export function shotRecipe(id: string): ShotRecipe | undefined { return SHOT_RECIPES.find(recipe => recipe.id === id); }

/** A reference picture in a shot and what it may give. Generated roles replace hand-written ones in every project. */
export type CastReference = {
  /** The @Image number of this picture in the run's input order. */
  image: number;
  name: string;
  kind: "character" | "location" | "vehicle" | "prop" | "layout";
  /** Optional extra, e.g. "his cap has no text" or "no badges". */
  note?: string;
  /** Relational size anchor for small characters, e.g. "no larger than an espresso glass". */
  size?: string;
};

/** One plain line per reference: what it gives and what it never gives (MiniMax copies pose, size and framing from a
 *  reference unless told not to). Pure. */
export function referenceRoles(cast: CastReference[]): string[] {
  return cast.map(ref => {
    const at = `@Image ${ref.image}`;
    const extra = ref.note ? ` ${ref.note}` : "";
    if (ref.kind === "layout") return `${at} is only a rough grey layout sketch: use it ONLY for the camera angle, where things stand and how big they are; copy none of its shapes, the real designs come from the other pictures.${extra}`;
    if (ref.kind === "location") return `${at} is the location: keep its architecture, materials and real scale, framed as described.${extra}`;
    if (ref.kind === "vehicle") return `${at} gives only the design of ${ref.name}, never its position or framing; no badges or logos.${extra}`;
    const size = ref.size ? `; ${ref.name} stays ${ref.size}` : "";
    return `${at} gives only ${ref.name}'s identity and look, never the pose, size or framing of the reference picture${size}.${extra}`;
  });
}

/** Checks a shot sheet before it is rendered. Each problem is a sentence; an empty list means it may render.
 *  `characters` are the names used in the frame lines. Pure. */
export function lintShotSheet(sheet: ShotSheet, characters: string[], referenceCount = 0): string[] {
  const problems: string[] = [];
  for (const name of characters) {
    const lines = sheet.frame.filter(part => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(part.content));
    if (lines.length > 1) problems.push(`${name} is named in ${lines.length} FRAME lines; one character belongs in one line, or the picture model draws them twice.`);
  }
  if (referenceCount > 4) problems.push(`${referenceCount} reference pictures; MiniMax H3-Image takes at most 4.`);
  if (sheet.scale !== undefined && /\b\d+(\.\d+)?\s?(cm|m|metres|meters)\b/i.test(sheet.scale) && !/\b(than|as|times|twice|half|reaching|next to|beside)\b/i.test(sheet.scale))
    problems.push("SCALE gives only a measurement; compare it to something in the frame (no larger than her glass, twice her height).");
  return problems;
}

/** A rough grey blockout prompt for the same shot (2026-11-23, user-approved): rendered first, then given to the shot as
 *  the LAST reference with kind "layout". As picture 1 it would be repainted literally (a box became a box car); as the
 *  last reference it only fixes camera, placement and sizes. `shapes` turns each cast name into a primitive. Pure. */
export function blockoutPrompt(sheet: ShotSheet, shapes: Record<string, string>): string {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // longest names first, so "Theo's convertible" is replaced before "Theo"
  const swap = (text: string) => Object.entries(shapes).sort(([a], [b]) => b.length - a.length)
    .reduce((out, [name, shape]) => out.replace(new RegExp(`\\b${escape(name)}\\b`, "gi"), shape), text);
  return [
    "Very rough low-poly grey previs blockout of a film shot, like an early 3D layout pass: only primitive shapes, no design details, no textures, no faces, no colour, matte grey.",
    `Camera: ${swap(sheet.camera)}.`,
    ...sheet.frame.map(part => `${part.region}: ${swap(part.content)}.`),
    ...(sheet.scale ? [`Sizes: ${swap(sheet.scale)}`] : []),
    `Light: ${sheet.light}`,
  ].join("\n");
}

/** The lock prompt (user-approved skeleton, 2026-11-23): fixed blocks in a fixed order, only the slots change.
 *  REPLICA only when a master frame exists; then SUBJECT LOCK near to far, CAMERA, LIGHT (with the anti-silhouette
 *  clause), STYLE (subtle game-cinematic look), IDENTITY AND LOCATION (what each picture gives, take nothing else),
 *  EXCLUDE. */
export type LockShot = {
  /** Shot size and the subject's share of the frame as a number: "Extreme Wide Shot, low-angle; Maya occupies about 8-10 percent of the frame height." */
  size?: string;
  /** The exact instant, mid-gesture; never a pose for the camera. */
  moment?: string;
  /** Near-to-far positional bullets with body mechanics: "FOREGROUND RIGHT: the lead henchman crouching ...".
   *  Concrete beats abstract (A/B concrete.jpg, 2026-11-23): name what touches the lens (a hand slapping the floor, spray),
   *  each subject's share of the frame, where it is cropped by the edge and which diagonal links them. The COMPOSITION
   *  block alone barely moves the model. */
  subjects: string[];
  /** Height above the ground, tilt, focal length, perspective behaviour, what fills the bottom third. */
  camera: string;
  /** Source position relative to the subjects, flare and haze. The anti-silhouette clause is added automatically. */
  light: string;
  /** One line per reference picture (referenceRoles output) plus anything to keep from the location. */
  identity: string[];
  /** Extra exclusions for this shot (the failure being corrected). */
  exclude?: string[];
  /** When a master frame is picture 1: lock its camera, composition and grade (role anchor EXACT FRAME). */
  master?: boolean;
  /** When picture 1 is an approved frame from ANOTHER scene used only for its look (role anchor NEW IMAGE): name its
   *  subjects and setting so none of them leak, e.g. "no woman, no beach, no white city". GPT ten-block template, 2026-11-23. */
  styleAnchor?: {exclude: string};
  style?: string;
  /** The shot's hierarchy, placed in the COMPOSITION block: "the primary focal point is ..., the secondary focal point is ...; everything else is subordinate: ..." */
  focus?: string;
  /** How this shot reads beyond the standard style, placed in STYLE before the negative list: "Speed reads through motion-blur streaks ...". */
  styleNote?: string;
  /** A LIGHT_PACKS key, usually the project look. */
  lightPack?: string;
  /** A CAMERA_PACKS key; "low" unless the shot asks for "high" or "none". */
  cameraPack?: string;
  /** A shot without any person (a drone view, a car alone on the road). The standard blocks talk about heads, faces,
   *  shoes and eyelines; with no person named, H3 invents a dark figure to carry them (heist gaps 1 and 10, 2026-11-23,
   *  twice, even with "no people" in EXCLUDE). True drops every body line and excludes people outright. */
  noPeople?: boolean;
};
/** Body wording in the standard blocks and its people-free replacement (noPeople). */
const PEOPLE_FREE: [string, string][] = [
  ["heads, shoulders, limbs, objects and architecture may run past", "objects, foliage and architecture may run past"],
  ["Guide the eye with diagonals, eyelines, body orientation and leading lines.", "Guide the eye with diagonals and leading lines."],
  ["Strong backlight draws bright golden rim light along heads, shoulders, arms and hands.", "Strong backlight draws bright golden rim light along palm fronds, edges and car bodies."],
  ["the subjects are foreshortened toward their feet", "tall things are foreshortened toward the ground"],
  ["; people further back look small and far", ""],
];
const unpeopled = (text: string) => PEOPLE_FREE.reduce((t, [from, to]) => t.replace(from, to), text);
const NO_PEOPLE_EXCLUDE = "No people at all: no person, figure, silhouette, walker or passer-by anywhere in the frame.";
export const LOCK_STYLE = "Premium real-time-rendered feature-film game cinematic (Unreal Engine 5 quality): stylised realism, sharp defined features, clean material response, physically plausible light, a subtle soft blur in the out-of-focus areas, subtle fine noise and film grain, subtle lens bloom and halation in the highlights, slight natural handheld imperfection. Not photoreal, not cartoon, not Disney, not a stock photo, not a posed portrait, not a game screenshot.";
/** COMPOSITION block (user-approved, 2026-11-23): how the frame is built, independent of subject, place and style.
 *  Answers "objects placed on a canvas" with deliberate camera composition: asymmetric masses, cropping, overlap,
 *  depth layers, one primary and one secondary focal point. */
export const LOCK_COMPOSITION = "Compose the image as a deliberately framed still from a feature film, not a staged render or subject showcase. Strong hierarchy: one primary focal point, one secondary focal point, subordinate supporting elements; asymmetric balance, with one large visual mass countered by a smaller contrasting one. Subjects fill meaningful parts of the frame instead of floating in empty space. Foreground, middle ground and background are built through perspective, overlapping silhouettes, partial occlusion and depth of field. Use intentional frame intersections and natural cropping: heads, shoulders, limbs, objects and architecture may run past the frame edges. Guide the eye with diagonals, eyelines, body orientation and leading lines. Negative space is deliberate; no dead space, no evenly spaced subjects. Not everything is fully visible, equally sharp or equally lit. Believable perspective, physical scale and spatial continuity. Decide what the camera reveals, conceals, emphasises and excludes.";
export const LOCK_EXCLUDE = ["No text, no captions, no watermark, no logo.", "No extra people beyond the ones named.", "No duplicated, malformed or extra limbs or fingers.", "No eye-level camera unless stated.", "No flat featureless black silhouettes.", "No studio backdrop, no character-sheet layout.", "No warped architecture, no floating objects.", "No loose or severed body parts.", "No flat staging, no symmetrical or evenly spaced subjects, no arbitrary foreground props, no excess headroom, no needlessly wide framing, nothing that looks like a character sheet or promotional render."];

/** Light packs a project picks as its look: appended to the shot's own LIGHT line. The golden-hour pack is the
 *  user's approved target (2026-11-23): coloured sky, big soft flare and haze, strong rim, warm floor reflections,
 *  glittering dust, rich warm contrast. Without it H3 renders a blunt, washed-out white sky. */
export const LIGHT_PACKS: Record<string, string> = {
  "golden-hour": "The sky holds rich sunset colour, peach, rose and amber with soft scattered clouds, never flat white. A large soft sun flare and a warm golden haze wash across the frame. Strong backlight draws bright golden rim light along heads, shoulders, arms and hands. Warm reflections and specular streaks glow on glossy and polished surfaces. Dust, spray or grit in the air glitters in the sunbeam. Deep warm shadows and rich contrast, the whole frame bathed in warm orange-gold light.",
};

/** Camera packs: picture models trained on eye-level material lift the camera unless the VISIBLE consequences of a
 *  low camera are named (user observation 2026-11-23). "low" is the default; "high" for overhead shots. */
export const CAMERA_PACKS: Record<string, string> = {
  low: "Seen from close to the ground: the horizon line sits low, in the lower third of the frame, the camera looks slightly up so sky and architecture rise above the subjects, and subtle wide-angle foreshortening makes whatever is nearest the lens (a hand, a foot, a knee, a bumper) noticeably larger than what is behind it.",
  /** Stronger than "low" (A/B lockfs, 2026-11-23): sizes and converging lines as visible consequences, not only a lens number. */
  foreshortened: "An ultra-wide 14mm lens very close to the nearest object, about one metre from it and a hand's width above the ground, tilted up: strong but natural wide-angle foreshortening. What is nearest the lens looks two to three times larger than its real size and leans out toward the viewer; the ground plane stretches away in long converging lines; tall verticals (palms, towers, posts) converge upward and lean slightly inward toward the top of the frame; people further back look small and far. The horizon sits in the bottom quarter. No fisheye curvature, straight lines stay straight.",
  high: "Seen from well above: the camera looks down, the horizon is high or out of frame, the ground and long shadows fill most of the picture, and the subjects are foreshortened toward their feet.",
};

/** Checks a lock shot before rendering: a near, a middle and a far line (the empty middle is where the model invents),
 *  a shot size with a number, and a moment. Pure. */
export function lintLockShot(shot: LockShot): string[] {
  const problems: string[] = [];
  const has = (re: RegExp) => shot.subjects.some(line => re.test(line));
  if (!has(/^(FOREGROUND|NEAR)/i)) problems.push("No FOREGROUND or NEAR line.");
  else if (!has(/^(FOREGROUND|NEAR)[^:]*(NEAR|CLOSE TO) THE LENS/i)) problems.push("No foreground object NEAR THE LENS: name a concrete rock, post, leaf or edge close to the camera (lockv4, 2026-11-23).");
  if (!has(/^MIDDLE|^BETWEEN/i)) problems.push("No MIDDLE line: describe what sits between the foreground and the far background.");
  if (!has(/^FAR/i)) problems.push("No FAR line.");
  if (!shot.size || !/\d/.test(shot.size)) problems.push("SHOT needs a shot size with the subject's share of the frame as a number.");
  if (!shot.moment) problems.push("No MOMENT: name the exact instant.");
  return problems;
}

/** What a style anchor gives (user-approved chase template, 2026-11-23): the first IDENTITY line, not a header. */
export const STYLE_ANCHOR_LINE = "Picture 1 gives only the rendering style and the camera feel: the low wide-angle perspective and foreground exaggeration, the golden flare through haze, the colour grade, the grain and the halation. Take NONE of its subjects or setting.";

/** Render the lock prompt. Pure. */
export function lockPrompt(shot: LockShot): string {
  const body = shot.noPeople ? unpeopled : (text: string) => text;
  return [
    ...(shot.master ? ["EXACT FRAME OF PICTURE 1: keep its camera position, lens and perspective, composition, placement, poses, lighting and grade; do not redesign, restage or re-frame it.", ""] : []),
    ...(shot.size ? ["SHOT", shot.size, ""] : []),
    "COMPOSITION",
    body(shot.focus ? LOCK_COMPOSITION.replace(/(not a staged render or subject showcase. )/, `$1Strong hierarchy: ${shot.focus.replace(/.$/, "")}. `).replace("Strong hierarchy: one primary focal point, one secondary focal point, subordinate supporting elements; asymmetric", "Asymmetric") : LOCK_COMPOSITION),
    "",
    "SUBJECT LOCK, NEAR TO FAR",
    ...shot.subjects.map(line => `- ${line}`),
    "",
    "CAMERA",
    body(`${shot.camera} ${CAMERA_PACKS[shot.cameraPack ?? "low"] ? `${CAMERA_PACKS[shot.cameraPack ?? "low"]} ` : ""}Never at standing eye level unless stated.`),
    "",
    "LIGHT",
    body(`${shot.light}${shot.lightPack && LIGHT_PACKS[shot.lightPack] ? ` ${LIGHT_PACKS[shot.lightPack]}` : ""}`) + (shot.noPeople ? "" : " Subjects are strongly backlit but never flat black silhouettes: faces, skin, hair, fabric folds and shoes stay readable, with a warm rim light tracing heads, shoulders, arms and legs."),
    "",
    "STYLE",
    shot.styleNote ? (shot.style ?? LOCK_STYLE).replace(/ Not photoreal/, ` ${shot.styleNote} Not photoreal`) : shot.style ?? LOCK_STYLE,
    "",
    ...(shot.moment ? ["MOMENT", shot.noPeople ? shot.moment : `${shot.moment} Not a pose for the camera.`, ""] : []),
    "IDENTITY AND LOCATION",
    ...(!shot.master && shot.styleAnchor ? [STYLE_ANCHOR_LINE] : []),
    ...shot.identity,
    "",
    "EXCLUDE",
    [...(shot.noPeople ? [NO_PEOPLE_EXCLUDE, ...LOCK_EXCLUDE.filter(line => !/people|limbs|body parts|silhouettes/.test(line))] : LOCK_EXCLUDE), ...(shot.exclude ?? []), ...(!shot.master && shot.styleAnchor ? [`From Picture 1: ${shot.styleAnchor.exclude}.`] : [])].join(" "),
  ].join("\n");
}

/** How a planner writes each keyframe prompt: the shot-sheet format above, filled for the topic. */
export const SHOT_SHEET_FORMAT = [
  "Write each prompt as a shot sheet in exactly this format and nothing else:",
  "write a SHOT line with exactly one framing, one camera angle, one composition technique and one lighting treatment from the shot vocabulary plus two mood words (e.g. SHOT: Medium Close-Up, Low-Angle Shot, Dirty Frame Composition, Subtle Warm Rim Light; intimate, mysterious) and never stack more effects;",
  "first choose one named shot recipe per shot by its intent and vary the recipes across the sequence (telephoto compression, wide close-up, fisheye architecture, macro insert, doorway observation, deep focus three planes, split diopter, silhouette backlight, object POV, frame within a frame, elevated vertigo, low action track, small against the event, imperfect vintage optics, inverted perspective, intimate portrait), and build the camera and near plane from it;",
  "line 1 'FILM STILL from a feature film, <camera: handheld 35mm camera, its height and position, lens, tilt, place, time of day>.';",
  "then 'FRAME, near to far:' and one line per element '- <region with frame share, e.g. Near, left 30 percent | Middle, right half | Far>: <what is there>';",
  "give every person and object physical contact (sits at, leans on, holds, rests on, stands on) and set any small character's size against a known object of similar size right beside it;",
  "one strong idea per depth layer; name each person or object in one FRAME line only (two lines make two copies);",
  "vary the camera height decisively across the sequence (floor, knee, clearly from above) and use standing eye level only on purpose;",
  "then 'FOCUS: <the one dominant read, e.g. the robot is the main read, she is secondary>', 'SCALE: <relational scale against things in the frame, e.g. no larger than her espresso glass, reaching above the door frame; never metres alone and never another object's name>',",
  "'LIGHT: <source, direction, where a thin rim of light falls>', 'MOMENT: <the exact instant>', 'LOOK: a frame from a feature film, handheld 35mm, fine grain, gentle halation, a subtle rim of light, not a stock photo, no posing',",
  "and 'REFERENCES:' with one plain line per reference picture saying what it gives and what it never gives (identity only, never pose, size or framing).",
  "Small objects get only the few details that read at their size. No general rules or adjectives about composition in the prompt itself: the positions are the composition.",
].join(" ");

/** The whole layer for a planner that writes a sequence of shots. */
export const CINEMATOGRAPHY_LAYER = `${DIRECTOR_PASS} ${DP_PASS} ${NEVER_BY_REFLEX} ${CAMERA_KEYS} ${EMOTION_TO_CAMERA} ${SCALE_CUES} ${FILM_STILL_RULES} ${SHOT_CONSTRUCTION} ${QUALITY_GATE}`;

/** For an image-to-video prompt: the start picture already fixes the framing, so only the camera's move needs a reason. */
export const CAMERA_MOVE_WITH_PURPOSE =
  "Give any camera movement a purpose (reveal what is occluded, follow the action along its axis, push in on a reaction) and keep the start picture's framing, eyelines and screen direction.";
