/* AI edits in the image editor. Every action works on what is visible (the flattened layers), on the whole picture
   or on a padded crop around the selection, runs a ComfyUI workflow and comes back as a new layer on top.
   Pure helpers live here so they can be tested without a canvas. */

export type AiMode = "modify" | "harmonize" | "fill";
export type EditIntent=AiMode|"auto";
export type EditScope="auto"|"layer"|"image";
/** Scene-wide requests must not be silently clipped by an old selection. */
export function resolveEditScope(scope:EditScope,prompt:string,hasSelection=false):"layer"|"image"{
  if(scope!=="auto")return scope;
  if(hasSelection&&/\b(?:selected|selection|masked|markierten?|ausgewählten?)\b/i.test(prompt))return "layer";
  const scene=/\b(?:this|the|whole|entire)\s+(?:image|picture|scene)\b|\b(?:scene|szene|jahreszeit|season)\b/i.test(prompt)
    ||(!hasSelection&&/\b(?:background|hintergrund)\b/i.test(prompt));
  const seasonal=/\b(?:summer|winter|spring|autumn|fall|sommer|frühling|herbst)\s+(?:instead of|statt)\b|\b(?:as|als|in|to|into|im)\s+(?:summer|winter|spring|autumn|sommer|frühling|herbst)\b/i.test(prompt);
  return scene||seasonal?"image":"layer";
}
/** One submit action; explicit contextual intent takes precedence over prompt hints. */
export function resolveEditMode(intent:EditIntent,prompt:string,hasSelection:boolean):AiMode{
  if(intent!=="auto")return intent==="fill"&&!hasSelection?"modify":intent;
  if(/\bharmoni[sz]e\b|\bmatch\s+(?:the\s+)?(?:lighting|colou?rs?)\b/i.test(prompt))return "harmonize";
  if(hasSelection&&(/\b(fill|add|insert|extend|outpaint|ersetze|fülle|hinzufügen)\b/i.test(prompt)||/\b(?:replace|change|remove)\b.*\bbackground\b|\bhintergrund\b.*\b(?:ersetzen|ändern|entfernen)\b/i.test(prompt)))return "fill";
  return "modify";
}
export type Rect = { x: number; y: number; w: number; h: number };

export const AI_LABELS: Record<AiMode, string> = { modify: "Modify", harmonize: "Harmonize", fill: "Generative fill" };
export const AI_BUSY: Record<AiMode, string> = { modify: "Modifying…", harmonize: "Harmonizing…", fill: "Filling…" };

const HARMONIZE =
  "Harmonize this composite into one coherent photograph. Integrate the inserted foreground element: correct its perspective, orientation and scale to fit the scene, match lighting direction, color temperature, contrast, contact shadows, reflections and grain. Preserve the element's identity and preserve surrounding objects and text. The second image, when supplied, is the visual reference for the target element; use the first image as the scene context.";

/** The instruction Qwen Image Edit receives for an action. */
export function aiInstruction(mode: AiMode, prompt: string): string {
  const p = prompt.trim().replace(/\.$/, "");
  const targetSeason=p.match(/\b(?:as|als|in|to|into|im)\s+(summer|sommer|winter)\b/i)?.[1]
    ??p.match(/\b(summer|sommer|winter)\s+(?:instead of|statt)\b/i)?.[1];
  const season=mode==="modify"&&resolveEditScope("auto",p)==="image"&&/^(summer|sommer)$/i.test(targetSeason??"")
    ?" Transform the entire environment to summer: remove all snow and frost, melt all lake and river ice into visibly open liquid water, and replace winter ground and vegetation with natural summer foliage. Preserve the buildings, composition and camera position, but do not preserve winter surfaces."
    :mode==="modify"&&targetSeason?.toLowerCase()==="winter"?" Transform the entire environment to winter, including seasonal ground cover, vegetation and water surfaces, while preserving the buildings, composition and camera position.":"";
  if (mode === "harmonize") return p ? `${HARMONIZE} Also: ${p}.` : HARMONIZE;
  if (mode === "fill") return `${p}. Blend it naturally into the surrounding image with matching light, perspective and texture.`;
  /* A request to swap a subject must not be answered with the same subject, so say that the original look goes. */
  const swap = /\b(?:different|another|new|other)\s+(?:character|person|face|man|woman)\b|\b(?:replace|swap)\s+(?:the\s+)?(?:character|person|face|man|woman)\b/i.test(p) ? " Do not keep the original face, hairstyle, identity or appearance of the changed subject; the result must look clearly like someone or something else." : "";
  return `${p}. Make the change clearly visible, and keep everything that is not mentioned unchanged.${season}${swap}`;
}

/** Grow a rectangle by a share of its longer side (context for the model), clamped to the picture, in whole pixels. */
export function padRect(r: Rect, width: number, height: number, share: number): Rect {
  const pad = Math.round(Math.max(r.w, r.h) * share);
  const x = Math.max(0, Math.floor(r.x - pad));
  const y = Math.max(0, Math.floor(r.y - pad));
  const x2 = Math.min(width, Math.ceil(r.x + r.w + pad));
  const y2 = Math.min(height, Math.ceil(r.y + r.h + pad));
  return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
}

/** Where to draw a result of size iw×ih into a target rect without distortion: fill it, cropping the overflow (cover). */
export function coverSource(iw: number, ih: number, target: Rect): Rect {
  const scale = Math.max(target.w / iw, target.h / ih);
  const sw = target.w / scale;
  const sh = target.h / scale;
  return { x: (iw - sw) / 2, y: (ih - sh) / 2, w: sw, h: sh };
}
