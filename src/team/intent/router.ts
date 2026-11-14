export type IntentTarget =
  | "image"
  | "image-edit"
  | "video"
  | "motion"
  | "edit"
  | "trim"
  | "storyboard"
  | "audio"
  | "unknown";

export type IntentOverride = "auto" | "image" | "video";

const rules: Array<{ target: Exclude<IntentTarget, "unknown" | "image" | "video">; pattern: RegExp }> = [
  { target: "trim", pattern: /\b(trim|cut|shorten|crop clip|frame range)\b/i },
  { target: "storyboard", pattern: /\b(storyboard|scene list|scenes|multi[- ]shot|shot list)\b/i },
  { target: "motion", pattern: /\b(?:motion transfer|transfer (?:the )?motion|copy (?:the )?(?:motion|moves|movement)|move like|mimic (?:the )?(?:motion|moves|movement))\b/i },
  { target: "edit", pattern: /\b(edit|replace|remove|swap|inpaint|restyle|mask)\b/i },
];

const videoCue = /\b(video|clip|footage|camera|walk|walking|run|running|pan|zoom|orbit|moving|motion|animation|animate|seconds?|fps)\b/i;
const imageCue = /\b(image|picture|photo|portrait|illustration|poster|render|logo|thumbnail)\b/i;
const explicitVideo = /\b(?:animate|animation|(?:make|create|generate|produce)\s+(?:(?:me|us)\s+)?(?:(?:a|an|the)\s+)?(?:video|clip|animation))\b/i;
const audioCue = /\b(audio|voice|speech|music|soundtrack|sound)\b/i;

export function classifyIntent(text: string, override: IntentOverride = "auto"): IntentTarget {
  const value = text.trim();
  if (!value) return "unknown";
  if (override === "image") return "image";
  if (override === "video") return "video";
  for (const rule of rules) {
    if (rule.pattern.test(value)) return rule.target;
  }
  if (explicitVideo.test(value)) return "video";
  if (audioCue.test(value)) return "audio";
  if (videoCue.test(value) && !imageCue.test(value)) return "video";
  return "image";
}

/** Resolve an ambiguous edit against the active workspace without overriding explicit modes. */
export function contextualIntent(text:string,override:IntentOverride,hasReference:boolean,imageWorkspace:boolean,videoWorkspace=false):IntentTarget{
  const target=classifyIntent(text,override);
  if(override!=="auto")return target;
  if(target==="image"&&videoWorkspace&&!imageCue.test(text))return "video";
  if(target!=="edit")return target;
  if(hasReference)return "image";
  return imageWorkspace&&!/\b(?:video|clip|footage)\b/i.test(text)?"image-edit":target;
}

/** One name per destination, the word the screen itself uses: the Change card is "Copy moves",
 *  Create/Edit/Trim are tabs inside Video, and making something is always "make". */
export function intentLabel(target: IntentTarget) {
  switch (target) {
    case "image": return "Image";
    case "image-edit": return "Image edit";
    case "video": return "Video";
    case "motion": return "Copy moves";
    case "edit": return "Edit video";
    case "trim": return "Trim video";
    case "storyboard": return "Storyboard";
    case "audio": return "Audio";
    default: return "Describe a result";
  }
}

export function intentPurpose(target: IntentTarget) {
  switch (target) {
    case "image": return "Make a still image with the best ready image workflow.";
    case "image-edit": return "Open image editing with this instruction ready for a source picture.";
    case "video": return "Open Create in Video with this prompt filled in.";
    case "motion": return "Open Copy moves with this character prompt filled in.";
    case "edit": return "Open Edit in Video and keep this prompt for the masked area.";
    case "trim": return "Open Trim in Video for an exact frame range.";
    case "storyboard": return "Open Storyboard to split the idea into shots.";
    case "audio": return "Open Audio for local audio work.";
    default: return "Type what you want to make.";
  }
}
