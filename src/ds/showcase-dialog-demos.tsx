import {useState} from "react";
import {Button,Meta,PresetCard,RotatingVideo} from "./index";
import {WelcomeDialog} from "./WelcomeDialog";
import welcomeLogo from "../assets/creativefield-logo-trim.png";

/* The welcome dialog demo for the #ds showcase (Showcase.tsx), in its own file so the showcase does not grow past its size. */

export function WelcomeDialogDemo(){
  const [open,setOpen]=useState(false);
  const pick=()=>setOpen(false);
  return <><Button onClick={()=>setOpen(true)}>Open welcome</Button><WelcomeDialog open={open} onClose={()=>setOpen(false)} logo={welcomeLogo} title="What will you make today?" text="Turn a few words, a photo or a clip into pictures, video and 3D." media={<RotatingVideo srcs={["/reels/mj-02.mp4"]}/>} picks={<>
    <PresetCard size="tool" featured label="FotoField" hint="Layers, masks and AI edits." thumb="/examples/fotofield.webp" onSelect={pick}/>
    <PresetCard size="tool" label="Make a video" hint="From a photo or a few words." thumb="/examples/video.webp" onSelect={pick}/>
    <PresetCard size="tool" label="Make a picture" hint="Describe it, get a picture." thumb="/examples/picture.webp" onSelect={pick}/>
    <PresetCard size="tool" label="New look" hint="Before / after: the line sweeps, or follows the pointer." before="/examples/fotofield.webp" thumb="/examples/picture.webp" onSelect={pick}/>
    <PresetCard size="tool" label="3D models" hint="Preview or browse 3D." thumb="/examples/model3d.webp" onSelect={pick}/>
  </>} note={<Meta>Local generation needs a connected ComfyUI worker and its models.</Meta>} action={<Button variant="primary" onClick={()=>setOpen(false)}>Let's create</Button>}/></>;
}
