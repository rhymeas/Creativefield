import {Hero,RotatingVideo} from "../ds";
import {POOL_VIDEOS,reelForManifest} from "./reels";
import {LOAD_TURN} from "./reload-turn";

/** The encouraging line over each tool's results, by what the tool does. Words only from this table. */
const LINES:Record<string,{title:string;text:string}>={
  model3d:{title:"From a picture to a 3D model",text:"Choose a subject image and a compatible local workflow. Review requirements before generating a model."},
  replace:{title:"Put anyone in any video",text:"Swap a person for your character and keep every move, the light and the place."},
  swap:{title:"Swap anything in a video",text:"Name a thing, show what it becomes, and the rest of the clip stays as it is."},
  motion:{title:"Turn one video into many",text:"Take the motion and recast it with your characters, places and products."},
  remix:{title:"Make more from one picture",text:"Choose a picture, describe each variation, and generate them together."},
  ad:{title:"Create your product shot",text:"Add a product image, describe the scene and animate a result."},
  effects:{title:"Bring your photo to life",text:"Choose an effect, add a photo and create a short video."},
  restyle:{title:"Give any video a new look",text:"Same moves and timing, a whole new style."},
  reframe:{title:"Give your clip more room",text:"Choose a new format and extend the scene beyond its original edges."},
  edit:{title:"Change anything with one sentence",text:"Drop a clip, say what should change, and only that part changes."},
  picture:{title:"Make a picture from a few words",text:"Describe it, pick a look, and get a picture. Turn objects to new angles or change the light."},
  angles:{title:"See it from every side",text:"Pick the angles you want, from high to low and left to right, and turn your subject around."},
  relight:{title:"Change the light",text:"Move the light, warm it up or cool it down, and keep everything else as it is."},
  imageedit:{title:"Change a picture with one sentence",text:"Say what should be different. The rest of the picture stays."},
  library:{title:"Everything you made, in one place",text:"Pictures, clips and runs of this project. Drop media in, pick it anywhere."},
  cast:{title:"Save a person once, use them everywhere",text:"A character keeps the same face across replacements, pictures and shots."},
  scenes:{title:"From a character to a scene",text:"Write the shot, make the frames, then bring them to life."},
  voice:{title:"Type the words, get a voice",text:"Speech and moving lips from plain text, on your computer."},
  film:{title:"Write the shots, get one film",text:"Make each shot on its own, then join them into one video."},
  keyframes:{title:"Bring keyframes to life",text:"Choose the moments, describe each transition, and make one animation."},
  enhance:{title:"Sharper, bigger, smoother",text:"Add a clip, pick the steps, and they run one after the other."},
  trim:{title:"Cut and extend a clip",text:"Trim a take, or let the model continue where it stops."},
  create:{title:"Make a video from an idea",text:"Write what should happen, add a picture if you have one, and press Generate."},
};
export type HeroKind=keyof typeof LINES;
export function ToolHero({kind,workflowId,latest,compact}:{kind:HeroKind;workflowId?:string;/** Half height, title on one line: the tool has its input and the work area gets the room. */compact?:boolean;/** The newest finished clip, used when the tool has no reel of its own. */latest?:string}){
  /* Every kind starts the placeholder set at a different clip, so neighbouring areas do not open on the same loop. */
  const start=(Object.keys(LINES).indexOf(kind)+LOAD_TURN)%POOL_VIDEOS.length;
  const line=LINES[kind],reel=(workflowId?reelForManifest(workflowId):undefined)??latest;
  /* Rule 11/49: motion is off when the system asks for less. The clip stays in place as its first
     frame instead of looping, so the tool still shows what it makes. */
  return <Hero stage compact={compact} title={line.title} text={line.text} media={<RotatingVideo srcs={reel?[reel,...POOL_VIDEOS.filter(v=>v!==reel)]:POOL_VIDEOS.slice(start).concat(POOL_VIDEOS.slice(0,start))}/>}/>;
}
