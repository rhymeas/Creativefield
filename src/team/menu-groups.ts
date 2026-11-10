/*
 * The Video and Image menus by function (IDEA-1656). Every entry is a workflow; the menu groups them by what they
 * do, names the model that runs each one, and gives each a short hover clip. Rough previews, not results of that
 * exact workflow: the clip only has to show the kind of change.
 */
import type {MenuGroup,MenuTile} from "../ds";

/** Model names, longest first, so "Qwen Image 2.1" wins over "Qwen". */
const MODELS=["Bria Remove Background","Bria Upscale","Kling Lip Sync","HyperFlow H3 Flash","MiniMax H3","FLUX 3 Klein","FLUX 2 Pro","Qwen Image 2.1","Fibo 2.0","Pruna P-H3","Wan 2.1 VACE 1.3B","Wan 2.1 VACE","Wan Animate 2","SCAIL-2","Real-ESRGAN","FILM","Seedance 2.5","Kling"];
/** What a few bare remainders mean. */
const NAMES:Record<string,string>={"X4":"Upscale ×4",Distilled:"Animate a character",Effects:"Effect clips"};
/** Splits "FLUX 3 Klein text to image" into the model and what it does. */
export function splitModel(title:string):{model?:string;rest:string}{
  const clean=title.split(" (")[0].trim();
  const model=MODELS.find(m=>clean===m||clean.startsWith(`${m} `));
  if(!model)return {rest:clean};
  const rest=clean.slice(model.length).trim();
  const named=rest?rest[0].toUpperCase()+rest.slice(1):"";
  return {model,rest:NAMES[named]??named};
}

type Group={id:string;title:string;text:string;match:RegExp;clip:string;poster:string;fallback:string;/** More previews of the same kind, taken in turn so a row does not repeat one picture. */more?:string[]};
const P="/examples/promo/",M="/examples/menu/";
/** A preview by name: its poster, and its clip (a promo clip, or a slow loop made from the poster). */
const PROMO=new Set(["ad-studio","block-shot","copy-moves","effects-lab","film-studio","new-look","persona-studio","reshoot","swap-thing","video-studio"]);
const MADE:Record<string,string>={photofield:"fotofield","flow-studio":"edit",angles:"angles",sharpen:"upscale","identity-studio":"identity",director:"director",talk:"talk","remix-studio":"remix-studio",model3d:"model3d"};
const preview=(name:string):[string,string]=>name.startsWith("f:")?[`/examples/features/${name.slice(2)}.mp4`,`/examples/features/${name.slice(2)}.jpg`]:[PROMO.has(name)?`${P}${name}.mp4`:`${M}${MADE[name]}.mp4`,`${P}${name}.webp`];
const VIDEO:Group[]=[
  {id:"make",more:"f:create-video video-studio f:block-shot film-studio director".split(" "),title:"Make a video",text:"from words, a picture or two frames",match:/^create$|text to video|first and last|^hyperflow h3 flash$|storyboard|i2v|t2v/i,clip:`${P}video-studio.mp4`,poster:`${P}video-studio.webp`,fallback:"Video from a picture"},
  {id:"people",more:"copy-moves persona-studio talk identity-studio".split(" "),title:"People and motion",text:"recast a person, copy a move",match:/openjutsu|motion|character|animate|scail|replace|talk|lip ?sync/i,clip:`${P}copy-moves.mp4`,poster:`${P}copy-moves.webp`,fallback:"Recast a person"},
  {id:"change",more:"new-look swap-thing flow-studio remix-studio".split(" "),title:"Change a video",text:"new look, swap a thing, edit an area",match:/edit|transform|restyle|swap|background|region/i,clip:`${P}new-look.mp4`,poster:`${P}new-look.webp`,fallback:"Change a video"},
  {id:"effects",title:"Effects",text:"one photo, one effect",match:/effect/i,clip:`${P}effects-lab.mp4`,poster:`${P}effects-lab.webp`,fallback:"Effect clips"},
  {id:"finish",more:"sharpen reshoot block-shot video-studio".split(" "),title:"Finish",text:"trim, join, smoother and sharper",match:/trim|join|upscale|sharpen|esrgan|interpolation|frame interpolation|quality/i,clip:`${M}upscale.mp4`,poster:`${P}sharpen.webp`,fallback:"Finish a clip"},
];
const IMAGE:Group[]=[
  {id:"create",more:"ad-studio persona-studio remix-studio director film-studio video-studio effects-lab".split(" "),title:"Create a picture",text:"from a few words",match:/create image|text to image/i,clip:`${P}ad-studio.mp4`,poster:`${P}ad-studio.webp`,fallback:"Picture from words"},
  {id:"change",more:"f:edit photofield swap-thing new-look f:new-look f:swap-thing".split(" "),title:"Change a picture",text:"say what should be different",match:/fotofield|edit/i,clip:`${M}edit.mp4`,poster:`${P}flow-studio.webp`,fallback:"Edit with a sentence"},
  {id:"turn",more:"f:angles f:relight model3d reshoot f:upscale".split(" "),title:"Turn, light and finish",text:"new angle, new light, sharper, cut out",match:/angle|relight|upscale|sharper|cut out|cutout/i,clip:`${M}angles.mp4`,poster:`${P}angles.webp`,fallback:"New angle"},
];
const THREE_D:Group[]=[
  {id:"make",title:"Make a 3D model",text:"from a picture or a few words",match:/image|text|workflow/i,clip:`${M}model3d.mp4`,poster:`${P}model3d.webp`,fallback:"Make a 3D model",more:"model3d angles director".split(" ")},
  {id:"work",title:"Work on a model",text:"look at it, paint it, fix its size",match:/viewer|texture|mesh/i,clip:`${M}model3d.mp4`,poster:`${P}model3d.webp`,fallback:"Work on a model",more:"model3d photofield angles".split(" ")},
];
/** A closer clip for a few well-known kinds, over the group's own. */
/** The 3-second feature clips: a slider from the input to the result in the same frame (README tiles too). */
const F="/examples/features/",feature=(name:string):[string,string]=>[`${F}${name}.mp4`,`${F}${name}.jpg`];
const CLIPS:[RegExp,string,string][]=([
  [/storyboard/i,"storyboard"],
  [/openjutsu/i,"openjutsu"],
  [/swap|edit area|region|masked/i,"swap-thing"],
  [/relight/i,"relight"],
  [/angle/i,"angles"],
  [/fotofield/i,"fotofield"],
  [/upscale|sharpen|sharper|esrgan|seedvr/i,"upscale"],
  [/effect/i,"effects"],
  [/previs|block|make it real|grey/i,"block-shot"],
  [/restyle|new look|transform/i,"new-look"],
  [/motion|animate|scail|copy/i,"copy-moves"],
  [/image edit|^edit|picture edit|fibo|qwen image/i,"edit"],
] as [RegExp,string|null][]).map(([re,name])=>name?[re,...feature(name)]:[re,`${P}persona-studio.mp4`,`${P}persona-studio.webp`]);

export type MenuEntry={id:string;title:string;text?:string;hint?:string;onSelect:()=>void};
/** Places menu entries into function rows. Entries no row matches go to the last row. Empty rows are left out. */
export function groupMenu(kind:"video"|"image"|"3d",entries:MenuEntry[]):MenuGroup[]{
  const groups=kind==="video"?VIDEO:kind==="3d"?THREE_D:IMAGE;
  const rows=new Map<string,MenuTile[]>(groups.map(g=>[g.id,[]]));
  const seen=new Set<string>();
  for(const e of entries){
    if(seen.has(e.id))continue;seen.add(e.id);
    const {model,rest}=splitModel(e.title);
    const key=`${e.id} ${e.title}`;
    const group=groups.find(g=>g.match.test(e.title)||g.match.test(e.id)||(!!e.hint&&g.match.test(e.hint)))??groups[groups.length-1];
    const close=CLIPS.find(([re])=>re.test(key)),row=rows.get(group.id)!;
    // Image workflows need distinct previews even when several have the same function name.
    const [clip,poster]=kind==="image"&&group.more?preview(group.more[row.length%group.more.length]):close?[close[1],close[2]]:group.more?preview(group.more[row.length%group.more.length]):[group.clip,group.poster];
    const fillPortrait = poster === `${F}edit.jpg` ? "upper" : poster === `${F}relight.jpg` || poster === `${F}swap-thing.jpg` ? "center" : undefined;
    row.push({id:e.id,title:rest||(model?group.fallback:e.title),model,text:model?undefined:e.text,clip,poster,fillPortrait,onSelect:e.onSelect});
  }
  return groups.map(g=>({id:g.id,title:g.title,text:g.text,tiles:rows.get(g.id)!})).filter(g=>g.tiles.length>0);
}
