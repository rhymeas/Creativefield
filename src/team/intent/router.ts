export type IntentTarget =
  | "image"
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
  { target: "motion", pattern: /\b(motion|camera move|move like|animate the character|mimic)\b/i },
  { target: "edit", pattern: /\b(edit|replace|remove|swap|inpaint|restyle|mask)\b/i },
  { target: "audio", pattern: /\b(audio|voice|speech|music|soundtrack|sound)\b/i },
];

const videoCue = /\b(video|clip|footage|camera|walk|walking|run|running|pan|zoom|orbit|moving|animation|animate|seconds?|fps)\b/i;
const imageCue = /\b(image|picture|photo|portrait|illustration|poster|render|logo|thumbnail)\b/i;

export function classifyIntent(text: string, override: IntentOverride = "auto"): IntentTarget {
  const value = text.trim();
  if (!value) return "unknown";
  if (override === "image") return "image";
  if (override === "video") return "video";
  for (const rule of rules) {
    if (rule.pattern.test(value)) return rule.target;
  }
  if (videoCue.test(value) && !imageCue.test(value)) return "video";
  return "image";
}

/** One name per destination, the word the screen itself uses: the Change card is "Copy moves",
 *  Create/Edit/Trim are tabs inside Video, and making something is always "make". */
export function intentLabel(target: IntentTarget) {
  switch (target) {
    case "image": return "Image";
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
    case "video": return "Open Create in Video with this prompt filled in.";
    case "motion": return "Open Copy moves with this character prompt filled in.";
    case "edit": return "Open Edit in Video and keep this prompt for the masked area.";
    case "trim": return "Open Trim in Video for an exact frame range.";
    case "storyboard": return "Open Storyboard to split the idea into shots.";
    case "audio": return "Open Audio for local audio work.";
    default: return "Type what you want to make.";
  }
}
