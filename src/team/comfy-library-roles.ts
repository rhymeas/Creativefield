import type { ComfyNodeInfo } from "../capabilities/types";

export type LibraryFilter = "all" | "generation" | "support" | "control" | "enhance" | "audio" | "other";

export type LibraryRole = {
  id: string;
  label: string;
  purpose: string;
  filter: Exclude<LibraryFilter, "all">;
};

export const libraryFilters: Array<{ id: LibraryFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "generation", label: "Generation" },
  { id: "support", label: "Support" },
  { id: "control", label: "Control" },
  { id: "enhance", label: "Enhance" },
  { id: "audio", label: "Audio" },
  { id: "other", label: "Other" }
];

const videoModel = /(^|[_\-. ])(wan|ltx|hunyuan|cog|mochi|animate|svd|video)/i;

const role = (id: string, label: string, purpose: string, filter: LibraryRole["filter"]): LibraryRole => ({ id, label, purpose, filter });

const roles = {
  video: role("video", "Video models", "Generate or animate video. The workflow picks the one that matches your task.", "generation"),
  image: role("image", "Image models", "Generate or edit still images from a prompt or reference.", "generation"),
  prompt: role("prompt", "Prompt encoders", "Translate your words into the language the generation model understands.", "support"),
  decoder: role("decoder", "VAEs and decoders", "Turn the model's internal result into a visible image or video.", "support"),
  reference: role("reference", "Reference vision", "Read a reference image for identity, style or composition.", "support"),
  control: role("control", "Control models", "Guide the result with edges, depth, pose or a reference image.", "control"),
  lora: role("lora", "Style and character add-ons", "Small add-ons that change style, a character or a motion effect.", "control"),
  upscale: role("upscale", "Upscalers", "Make a finished image or video larger and sharper.", "enhance"),
  interpolation: role("interpolation", "Frame interpolation", "Add in-between frames so motion looks smoother.", "enhance"),
  audio: role("audio", "Audio models", "Generate or condition voice, music and sound.", "audio"),
  config: role("config", "Configuration files", "Settings that tell ComfyUI how to load a model.", "other"),
  nodes: role("nodes", "Custom node files", "Installed ComfyUI extensions and their support files.", "other"),
  other: role("other", "Support files", "Extra files an installed workflow may need.", "other")
} satisfies Record<string, LibraryRole>;

const byFolder: Record<string, LibraryRole> = {
  checkpoints: roles.image,
  diffusion_models: roles.image,
  unet: roles.image,
  text_encoders: roles.prompt,
  clip: roles.prompt,
  clip_vision: roles.reference,
  vae: roles.decoder,
  vae_approx: roles.decoder,
  controlnet: roles.control,
  controlnet_aux: roles.control,
  gligen: roles.control,
  photomaker: roles.control,
  instantid: roles.control,
  ipadapter: roles.control,
  style_models: roles.control,
  loras: roles.lora,
  upscale_models: roles.upscale,
  frame_interpolation: roles.interpolation,
  audio_encoders: roles.audio,
  audio: roles.audio,
  configs: roles.config,
  custom_nodes: roles.nodes
};

/** What a model file is for, in product language. */
export function modelRole(folder: string, file: string): LibraryRole {
  const base = byFolder[folder] ?? roles.other;
  if (base === roles.image && /(^|[_\-. ])sam[0-9.]*/i.test(file)) return roles.control;
  if (base === roles.image && (folder === "diffusion_models" || folder === "unet" || folder === "checkpoints") && videoModel.test(file)) return roles.video;
  return base;
}

const nodeRoles: Array<{ prefix: RegExp; role: LibraryRole }> = [
  { prefix: /^video/i, role: roles.video },
  { prefix: /^image/i, role: roles.image },
  { prefix: /^audio/i, role: roles.audio },
  { prefix: /^conditioning/i, role: roles.control },
  { prefix: /^(controlnet|instantid|ipadapter)/i, role: roles.control },
  { prefix: /^(upscale|model_patches|frame_interpolation)/i, role: roles.upscale },
  { prefix: /^(loaders|sampling|latent|mask|_for_testing)/i, role: roles.prompt },
  { prefix: /^(api node|utils|advanced|text|logic)/i, role: roles.nodes }
];

/** A node class grouped by the job it performs. */
export function nodeRole(node: ComfyNodeInfo): LibraryRole {
  const category = node.category || "";
  return nodeRoles.find(entry => entry.prefix.test(category))?.role ?? roles.other;
}

export function groupModels(folders: Array<{ name: string; files: string[] }>) {  const groups = new Map<string, { role: LibraryRole; files: Array<{ folder: string; file: string; role: LibraryRole }> }>();
  for (const folder of folders) {
    for (const file of folder.files) {
      const fileRole = modelRole(folder.name, file);
      const current = groups.get(fileRole.id) ?? { role: fileRole, files: [] };
      current.files.push({ folder: folder.name, file, role: fileRole });
      groups.set(fileRole.id, current);
    }
  }
  return [...groups.values()].sort((a, b) => a.role.label.localeCompare(b.role.label));
}

export function groupNodes(nodes: ComfyNodeInfo[]) {
  const groups = new Map<string, { role: LibraryRole; nodes: ComfyNodeInfo[] }>();
  for (const node of nodes) {
    const nodeRoleValue = nodeRole(node);
    const current = groups.get(nodeRoleValue.id) ?? { role: nodeRoleValue, nodes: [] };
    current.nodes.push(node);
    groups.set(nodeRoleValue.id, current);
  }
  return [...groups.values()].sort((a, b) => a.role.label.localeCompare(b.role.label));
}
