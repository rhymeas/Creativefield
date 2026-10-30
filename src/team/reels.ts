/** Decorative 640p loops shown behind the model card and section surfaces. Each feature loop is a
    real before → after from cleared QA material; docs/REELS.md lists the source clips and how to rebuild them. */

/** Feature cards, by the workflow they run. Restyle and Effects share the VACE family: the reference
    route is the restyle card, the canny presets are the effects looks. */
const REELS = {
  "scail2-character-replace": "/reels/mj-00.mp4",
  "wan-animate2-distilled": "/reels/mj-07.mp4",
  "wan21-vace-masked-edit": "/reels/feature-swap.mp4",
  "wan21-vace-masked-edit-reference": "/reels/feature-swap.mp4",
  "wan21-vace-two-region-edit": "/reels/feature-swap.mp4",
  "vace-reference-restyle": "/reels/mj-04.mp4",
  "vace-canny-restyle": "/reels/feature-effects.mp4",
  "vace-canny-restyle-14b": "/reels/feature-effects.mp4",
  "vace-depth-restyle": "/reels/feature-effects.mp4",
  /* Create Video models: the ocean take of wan22-ti2v-5b-t2v, and placeholder loops (Midjourney clips) until each model has its own. */
  "wan22-flf2v-14b": "/reels/mj-01.mp4",
  "wan22-i2v-14b": "/reels/mj-02.mp4",
  "camera": "/reels/mj-03.mp4",
  "wan22-ti2v-5b": "/reels/wan22-t2v-5b.mp4",
  "wan22-ti2v-5b-t2v": "/reels/wan22-t2v-5b.mp4",
} as const;

/** The placeholder clips that take turns behind heroes (Midjourney set). */
export const POOL_VIDEOS = Array.from({ length: 8 }, (_, i) => `/reels/mj-0${i}.mp4`);

/** The one loop behind a whole section's surfaces. */
const SECTION_REELS: Record<string, string> = {
  video: REELS["wan22-ti2v-5b-t2v"],
  image: "/reels/mj-05.mp4",
  characters: "/reels/mj-06.mp4",
  influencer: "/reels/mj-00.mp4",
};

/** A card without a reel of its own shows none: it never borrows a gradient. */
export const NO_REEL = "";

export function reelForManifest(id?: string): string | undefined {
  return id && id in REELS ? REELS[id as keyof typeof REELS] : undefined;
}

export function reelForSection(section: string): string | undefined {
  return SECTION_REELS[section];
}
