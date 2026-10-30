/* The start screen: everything ComfyField can do, as tasks in plain words, each linking straight to its screen.
   Only tasks this computer can run now appear (rule 26); the rest are left out, never hinted. */
export type StartTaskId =
  | "swap-person" | "copy-moves" | "new-look" | "swap-thing" | "sharpen" | "video" | "film"
  | "picture" | "fix-picture" | "angles" | "character"
  | "talk" | "model3d";
export type StartGroup = "Video" | "Picture" | "More";
/** What a task needs on this computer, matching the app's own readiness flags. */
export type StartNeed = "replace" | "motion" | "effects" | "edit" | "vfx" | "video" | "image" | "audio" | "always";
/** `workflow` names the one workflow the task opens in the composer; without it the href alone picks the default. */
export type StartTask = { /** The product leads with this task: it comes first and wears the brand ring. */ featured?: boolean; /** A picture or loop from public/ that shows the result; the card shows the icon until there is one. */ thumb?: string; id: StartTaskId; group: StartGroup; label: string; text: string; href: string; needs: StartNeed; workflow?: string };

export const START_TASKS: StartTask[] = [
  { id: "fix-picture", group: "Picture", label: "FotoField", text: "Our free, open-source photo editor: layers, masks and AI edits.", href: "#imageedit", needs: "always", thumb: "/examples/fotofield.webp", featured: true },
  { id: "swap-person", group: "Video", label: "Replace character", text: "Put a face from a photo onto someone in a video.", href: "#video/replace", needs: "replace" },
  { id: "copy-moves", group: "Video", label: "Copy moves", text: "Make your character dance or move like someone in a video.", href: "#motion", needs: "motion" },
  { id: "new-look", group: "Video", label: "New look", text: "Same video as a cartoon, a painting or at night.", href: "#video/transform/restyle", needs: "effects", thumb: "/reels/feature-effects.png" },
  { id: "swap-thing", group: "Video", label: "Swap a thing", text: "Mark something in the clip and turn it into something else.", href: "#video/transform/swap", needs: "edit", thumb: "/reels/feature-swap.png" },
  { id: "sharpen", group: "Video", label: "Sharpen and upscale", text: "Make a clip bigger and sharper.", href: "#video/create", needs: "vfx", workflow: "nvidia-vfx-upscale" },
  { id: "video", group: "Video", label: "Make a video", text: "From a photo or from a few words.", href: "#video/create", needs: "video", thumb: "/reels/wan22-t2v-5b.png" },
  { id: "film", group: "Video", label: "Short film", text: "Write the shots, make each one, get one video.", href: "#video/storyboard", needs: "video", thumb: "/reels/wan22-flf-14b.png" },
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
