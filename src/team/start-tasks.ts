/* The start screen: everything ComfyField can do, as tasks in plain words, each linking straight to its screen.
   Only tasks this computer can run now appear (rule 26); the rest are left out, never hinted. */
export type StartTaskId =
  | "block" | "effect-clips" | "swap-person" | "copy-moves" | "new-look" | "swap-thing" | "sharpen" | "video" | "film"
  | "picture" | "fix-picture" | "angles" | "character" | "ad" | "remix"
  | "talk" | "model3d";
export type StartGroup = "Video" | "Picture" | "More";
/** What a task needs on this computer, matching the app's own readiness flags. */
export type StartNeed = "replace" | "motion" | "effects" | "h3effects" | "adimage" | "remiximage" | "edit" | "vfx" | "video" | "image" | "audio" | "always";
/** `workflow` names the one workflow the task opens in the composer; without it the href alone picks the default. */
export type StartTask = { /** One of a few promoted tiles: picture edge to edge, name in bold on it. */ promo?: boolean; /** A loop that plays on a promoted tile. */ video?: string; /** The product leads with this task: it comes first and wears the brand ring. */ featured?: boolean; /** A picture or loop from public/ that shows the result; the card shows the icon until there is one. */ thumb?: string; id: StartTaskId; group: StartGroup; label: string; text: string; href: string; needs: StartNeed; workflow?: string };

export const START_TASKS: StartTask[] = [
  { promo: true, video: "/examples/welcome-fotofield.mp4", id: "fix-picture", group: "Picture", label: "FotoField", text: "Our free, open-source photo editor: layers, masks and AI edits.", href: "#imageedit", needs: "always", thumb: "/examples/fotofield.webp", featured: true },
  { promo: true, video: "/examples/promo/reshoot.mp4", id: "swap-person", group: "Video", label: "Replace character", text: "Put a face from a photo onto someone in a video.", href: "#video/replace", needs: "replace" },
  { id: "effect-clips", group: "Video", label: "Effect clips", text: "One photo, one effect: breathe fire, call a storm, let flowers bloom.", href: "#video/effects", needs: "h3effects", workflow: "h3-effects" },
  { id: "block", group: "Video", label: "Block a shot", text: "Draw a grey layout with a camera move, then make it a shot.", href: "#block", needs: "effects" },
  { id: "copy-moves", group: "Video", label: "Copy moves", text: "Make your character dance or move like someone in a video.", href: "#motion", needs: "motion" },
  { id: "new-look", group: "Video", label: "New look", text: "Same video as a cartoon, a painting or at night.", href: "#video/transform/restyle", needs: "effects", thumb: "/reels/feature-effects.png" },
  { id: "swap-thing", group: "Video", label: "Swap a thing", text: "Mark something in the clip and turn it into something else.", href: "#video/transform/swap", needs: "edit", thumb: "/reels/feature-swap.png" },
  { id: "sharpen", group: "Video", label: "Sharpen and upscale", text: "Make a clip bigger and sharper.", href: "#video/create", needs: "vfx", workflow: "nvidia-vfx-upscale" },
  { promo: true, video: "/examples/promo/video-studio.mp4", id: "video", group: "Video", label: "Make a video", text: "From a photo or from a few words.", href: "#video/create", needs: "video", thumb: "/reels/wan22-t2v-5b.png" },
  { id: "film", group: "Video", label: "Short film", text: "Write the shots, make each one, get one video.", href: "#video/storyboard", needs: "video", thumb: "/reels/wan22-flf-14b.png" },
  { id: "remix", group: "Picture", label: "Remix Studio", text: "Make variations of a picture with different looks, products or scenes.", href: "#remix", needs: "remiximage" },
  { id: "ad", group: "Picture", label: "Ad Studio", text: "Create a product shot and turn it into a video.", href: "#marketing", needs: "adimage" },
  { id: "picture", group: "Picture", label: "Make a picture", text: "Describe it in words and get a picture.", href: "#image", needs: "image", thumb: "/reels/wan22-i2v-5b.png" },
  { id: "angles", group: "Picture", label: "Turn it around", text: "Turn a photo of an object to new angles.", href: "#image", needs: "image", thumb: "/reels/wan22-i2v-14b.png" },
  { id: "character", group: "Picture", label: "My characters", text: "Save a person once, then use them to replace a face, make a picture or fill a shot.", href: "#characters", needs: "always" },
  { id: "talk", group: "More", label: "Make it talk", text: "Type the words, get a voice and moving lips.", href: "#audio", needs: "audio" },
  { id: "model3d", group: "More", label: "3D models", text: "Preview a model you have or browse 3D templates.", href: "#3d", needs: "always" },
];

export const START_GROUPS: StartGroup[] = ["Video", "Picture", "More"];

/** Tasks this computer can run now, in screen order. A task that is not set up here is left out. */
export function startTasks(ready: Partial<Record<StartNeed, boolean>>): StartTask[] {
  return START_TASKS.filter((task) => task.needs === "always" || !!ready[task.needs]);
}

/** The tasks whose name or line contains what was typed; an empty search keeps them all. */
export function matchTasks<T extends { label: string; text: string }>(tasks: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  return needle ? tasks.filter((task) => `${task.label} ${task.text}`.toLowerCase().includes(needle)) : tasks;
}

/** "#video/transform/swap" opens the Change page with that card chosen. */
export function changeChoiceFromHash(hash: string): "motion" | "swap" | "restyle" | "person" | undefined {
  const choice = hash.replace(/^#/, "").split("/")[2];
  return choice === "motion" || choice === "swap" || choice === "restyle" || choice === "person" ? choice : undefined;
}
