/* What the hash asks for, and what to say when that screen cannot open yet.
   One place decides this (rule 26): a screen that is not ready, or a hash that names no
   screen, says in plain words what is missing and offers the one action that works now.
   It never quietly shows the Library instead. */

export type RouteNext = { label: string; href: string };

export type RouteState =
  /** A screen of its own handles this route. */
  | { kind: "screen" }
  /** The team server has not said what this computer can run yet. */
  | { kind: "checking" }
  /** This route cannot open: say why, and offer one working next action. */
  | { kind: "missing"; title: string; text: string; next?: RouteNext };

export type RouteInput = {
  /** First part of the hash, e.g. "video". */
  section: string;
  hash?: string;
  workflowIds?: string[];
  /** Video mode from the hash, e.g. "trim" for `#video/trim`. */
  mode?: string;
  /** This person may make things in this workspace. */
  canCreate: boolean;
  /** The workflow list has arrived, so readiness is known. */
  catalogueKnown: boolean;
  /** A video or motion workflow exists for this computer. Whether it can run right now is the
      screen's own problem to show, so a stopped ComfyUI never hides the screen. */
  video: boolean;
  motion: boolean;
  image: boolean;
  /** Audio requirements are known (the server answered). */
  audioKnown: boolean;
  audio: boolean;
  /** Video extension requirements are known. */
  trimKnown: boolean;
  trim: boolean;
};

/** Every hash this app opens a screen for. Anything else is a stale or mistyped link. */
export const ROUTES = ["make", "projects", "video", "motion", "image", "imageedit", "characters", "influencer", "marketing", "audio", "3d", "nodes", "catalogue", "library", "openjutsu", "workflow"];

/** The design system and node prototype are separate entry views. */
export function rootViewFromHash(hash: string): "app" | "showcase" | "node-design" {
  return hash==="#ds"?"showcase":hash==="#nodedesign"?"node-design":"app";
}

/** Keep old Models bookmarks useful when the catalogue moved. */
export function sectionFromHash(hash: string): string {
  const section=(hash.replace(/^#/,"")||"make").split("/")[0];
  return section==="models"?"catalogue":section;
}

const MODELS: RouteNext = { label: "Open Models", href: "#catalogue" };
const CHECKING: RouteState = { kind: "checking" };
const READ_ONLY: RouteState = { kind: "missing", title: "You cannot make this here yet", text: "Ask a workspace admin to let you make things." };
const unknown = (): RouteState => ({ kind: "missing", title: "This page does not exist", text: "The link may be old or misspelled. All tools shows what this computer can do.", next: { label: "All tools", href: "#make" } });
const notReady = (title: string, text: string): RouteState => ({ kind: "missing", title, text, next: MODELS });

/** The screen a hash opens, or the reason it cannot open yet. */
export function routeState(input: RouteInput): RouteState {
  const { section, mode = "create" } = input;
  if (!ROUTES.includes(section)) return unknown();
  const parts=input.hash?.replace(/^#/,"").split("/")??[];
  if(section==="workflow"||(section==="video"&&parts[1]&&!['create','storyboard','transform','trim','replace','edit','effects'].includes(parts[1]))){
    if(!input.catalogueKnown)return CHECKING;
    if(!parts[1]||!input.workflowIds?.includes(parts[1]))return unknown();
  }
  if(section==="video"&&parts[1]==="transform"&&parts[2]&&!['person','motion','restyle','swap'].includes(parts[2]))return unknown();
  if(section==="image"&&parts[1]&&input.catalogueKnown&&!input.workflowIds?.includes(parts[1]))return unknown();
  if(section==="3d"&&parts[1]==="image"&&parts[2]&&parts[2]!=="auto"&&input.catalogueKnown&&!input.workflowIds?.includes(parts[2]))return unknown();
  switch (section) {
    case "marketing":
      return {kind:"missing",title:"Marketing is unavailable",text:"This studio does not have an active screen here yet.",next:{label:"All tools",href:"#make"}};
    case "audio":
      if (!input.audioKnown) return CHECKING;
      if (!input.canCreate) return READ_ONLY;
      return input.audio ? { kind: "screen" } : notReady("Audio is not ready here", "This computer cannot make audio yet. Models shows what is ready.");
    case "video":
      if (mode === "trim") {
        if (!input.trimKnown) return CHECKING;
        if (!input.canCreate) return READ_ONLY;
        return input.trim ? { kind: "screen" } : notReady("Trimming is not ready here", "This computer cannot cut or extend a clip yet. Models shows what is ready.");
      }
      // Change, Storyboard, Edit and Effects mount their own screen once the list is known.
      if (mode !== "create") return input.catalogueKnown ? { kind: "screen" } : CHECKING;
      if (!input.catalogueKnown) return CHECKING;
      return input.video ? { kind: "screen" } : notReady("Video is not ready here", "This computer cannot make video yet. Models shows what is ready.");
    case "motion":
      if (!input.catalogueKnown) return CHECKING;
      return input.motion ? { kind: "screen" } : notReady("Motion is not ready here", "This computer cannot copy motion yet. Models shows what is ready.");
    case "image":
      if (!input.catalogueKnown) return CHECKING;
      return input.image ? { kind: "screen" } : notReady("Pictures are not ready here", "This computer cannot make pictures yet. Models shows what is ready.");
    default:
      return { kind: "screen" };
  }
}
