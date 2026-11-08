/** Decorative loops shown behind model cards and section surfaces. Generated promo clips are
    illustrative, while docs/REELS.md describes the separately recorded workflow examples. */

import {isOpenJutsuSingleSwap} from "../capabilities/tasks";

/** Feature cards, by the workflow they run. Restyle and Effects share the VACE family: the reference
    route is the restyle card, the canny presets are the effects looks. */
const REELS = {
  "h3-t2v": "/examples/promo/video-studio.mp4",
  "h3-i2v": "/examples/promo/video-studio.mp4",
  "h3-flf2v": "/examples/promo/video-studio.mp4",
  "h3-effects": "/examples/promo/effects-lab.mp4",
  "h3-effects-hyperflow": "/examples/promo/effects-lab.mp4",
  "h3-object-swap": "/examples/promo/swap-thing.mp4",
  "h3-object-swap-hyperflow": "/examples/promo/swap-thing.mp4",
  "openjutsu-h3-swap": "/examples/squarehead/jutsu-01.mp4",
  "openjutsu-h3-swap-hyperflow": "/examples/squarehead/jutsu-01.mp4",

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

/** Newest finished video examples appear first in the shared feed and Library. */
export const FEATURED_VIDEO_EXAMPLES = ["/examples/promo/beach-portrait.mp4"];

/** Squarehead's OpenJutsu examples and stills extracted from those actual renders. */
export const SQUAREHEAD_EXAMPLE_VIDEOS = Array.from({length:5},(_,i)=>`/examples/squarehead/jutsu-0${i+1}.mp4`);
export const SQUAREHEAD_EXAMPLE_IMAGES = Array.from({length:5},(_,i)=>`/examples/squarehead/jutsu-0${i+1}.webp`);

/** Actual local OpenJutsu renders, with their corresponding input assets. */
export const OPENJUTSU_SHOWCASE = Array.from({length:4},(_,index)=>{
  const number=index+1;
  return {result:`/examples/showcase/result-${number}.mp4`,original:`/examples/showcase/original-${number}.mp4`,source:`/examples/showcase/source-${number}.mp4`,character:`/examples/showcase/character-${number}.png`,number};
});

/** The early test clips: grey-backdrop studio tests, colour gradients, the first ocean take and one plain promo.
    They stay available, but every feed shows them last and never rotates them to the top. */
export const LOW_PRIORITY_EXAMPLES:readonly string[] = [
  ...["persona-studio"].map(name=>`/examples/promo/${name}.mp4`),
  ...["feature-effects","feature-motion","feature-replace","feature-restyle","feature-swap","wan22-flf-14b","wan22-i2v-14b","wan22-i2v-5b","wan22-t2v-5b"].map(name=>`/reels/${name}.mp4`),
];

/** All bundled video examples, in the order feeds show them: the OpenJutsu renders, the best promo clips, the
    Midjourney loops, then the early test clips. Available in the Library and media picker. */
export const LIBRARY_EXAMPLE_VIDEOS = [...FEATURED_VIDEO_EXAMPLES,...SQUAREHEAD_EXAMPLE_VIDEOS,...OPENJUTSU_SHOWCASE.map(item=>item.result),
  ...["reshoot","effects-lab","copy-moves","film-studio","block-shot","swap-thing","new-look","video-studio","ad-studio"].map(name=>`/examples/promo/${name}.mp4`),
  ...POOL_VIDEOS,...LOW_PRIORITY_EXAMPLES];

/** These clips illustrate each area; they are not claims that the named workflow made the clip. */
export function promoReelForCapability(ids?:string|string[]){
  const map:Record<string,string>={"h3-t2v":"video-studio","h3-i2v":"video-studio","h3-flf2v":"video-studio","h3-effects":"effects-lab","h3-effects-hyperflow":"effects-lab","h3-object-swap":"swap-thing","h3-object-swap-hyperflow":"swap-thing","openjutsu-h3-swap":"reshoot"};
  if([ids??""].flat().some(isOpenJutsuSingleSwap))return SQUAREHEAD_EXAMPLE_VIDEOS[0];
  const name=[ids??""].flat().map(id=>map[id]).find(Boolean);
  return name?`/examples/promo/${name}.mp4`:undefined;
}

/** A thematic still for an image workspace, not an example of a specific edit. */
export function promoStillForImage(id:string,ad=false,remix=false){
  const name=ad?"ad-studio":remix?"remix-studio":/angles/.test(id)?"angles":/edit|inpaint/.test(id)?"photofield":/t2i/.test(id)?"identity-studio":undefined;
  return name?`/examples/promo/${name}.webp`:undefined;
}

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
