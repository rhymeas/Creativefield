/** What each video effect needs and does, in plain words. Technical notes stay in the manifest description. */
export type EffectGuide={
  summary:string;
  steps:Array<{title:string;text:string}>;
  /** The longest part of the source clip a run takes, said in the drop zone's own hint. Absent when the whole clip goes through. */
  clipHint?:string;
};

/** The graph stops after 81 frames on the edge-guided restyle routes: about 5 s at 16 fps. */
const SHORT_CLIP="Drop a video, up to 5 s";

const GUIDES:Record<string,EffectGuide>={
  "vace-canny-restyle":{
    summary:"Gives your clip a new look. Its motion and outlines stay.",
    clipHint:SHORT_CLIP,
    steps:[
      {title:"Choose a clip",text:"Drop or pick a short clip, about 1 to 5 seconds."},
      {title:"Describe the look",text:"For example “watercolor painting” or “neon night”."},
      {title:"Queue video",text:"Colors and style change; shapes and movement follow your clip."},
    ],
  },
  "vace-reference-restyle":{
    summary:"Gives your clip a look taken from a picture.",
    clipHint:SHORT_CLIP,
    steps:[
      {title:"Choose a clip",text:"The video you want to restyle."},
      {title:"Add a picture",text:"An image with the look you want, like a painting or a photo."},
      {title:"Queue video",text:"The clip keeps its motion and takes on the look."},
    ],
  },
  "vace-depth-restyle":{
    summary:"Like restyle, but follows the depth of the scene. Needs a depth video.",
    steps:[
      {title:"Choose the clip",text:"The video you want to restyle."},
      {title:"Add its depth video",text:"A gray copy of the same clip where near is bright. The app does not make it for you."},
      {title:"Describe and queue",text:"Write the new look, then queue the video."},
    ],
  },
};

export function effectGuide(capabilityId:string):EffectGuide|undefined{return GUIDES[capabilityId];}

/** Label and placeholder for the prompt field of an effect screen; undefined when the manifest label already fits. */
export function effectPromptCopy(guide:EffectGuide|undefined):{label:string;placeholder:string}|undefined{
  return guide?{label:"Describe the new look",placeholder:"Say the new look, for example a watercolor painting"}:undefined;
}
