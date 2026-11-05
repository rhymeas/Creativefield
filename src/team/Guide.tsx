import {useState} from "react";
import {Cloud,Cpu,Download,Image as ImageIcon,KeyRound,MessageCircle,Monitor,Sparkles,Wand2} from "lucide-react";
import {Button,Dialog,HowItWorks,LinkButton,SegmentedTabs,StatusText,Toolbar} from "../ds";

/** Where the source lives; there are no packaged releases yet, so the ZIP is the main branch. */
export const GITHUB_URL="https://github.com/rhymeas/Creativefield";
export const GITHUB_ZIP=`${GITHUB_URL}/archive/refs/heads/main.zip`;

type Section="start"|"run"|"worker"|"data"|"download";
const SECTIONS:{id:Section;label:string}[]=[{id:"start",label:"Start"},{id:"run",label:"Where it runs"},{id:"worker",label:"Workers"},{id:"data",label:"Your data"},{id:"download",label:"Download"}];

/* A plain-words guide for people who are not technical: what a worker is, how the cloud and ChatGPT
   fit in, where their things are kept, and the download. It is part of the page itself: nothing is
   fetched or sent to open it. `hosted` is the online try-out, where renders run on the visitor's own
   Comfy Cloud account; otherwise CreativeField runs on this computer. */
export function Guide({hosted,cloudConnected,onClose,onCloudSignIn,onOpenWorkers}:{hosted:boolean;cloudConnected:boolean;onClose:()=>void;onCloudSignIn?:()=>void;onOpenWorkers?:()=>void}){
  const [section,setSection]=useState<Section>("start");
  const download=<><LinkButton variant="primary" href={GITHUB_URL} target="_blank" rel="noreferrer">Open on GitHub</LinkButton><LinkButton variant="ghost" href={GITHUB_ZIP} rel="noreferrer">Download ZIP</LinkButton></>;
  return <Dialog open wide title="How CreativeField works" onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Got it</Button>}>
    <div className="cf-form">
      <SegmentedTabs label="Guide section" quiet value={section} onChange={setSection} items={SECTIONS}/>
      {section==="start"&&<HowItWorks title="Make something in three steps" lead="CreativeField turns a few words, a photo or a clip into pictures, video and 3D. You don't need to know anything about AI models."
        steps={[
          {icon:<Wand2 size={20}/>,title:"Pick a tool",text:"Video, Image, FotoField or 3D in the top bar. Each tool does one thing, such as a new picture or a moving clip."},
          {icon:<ImageIcon size={20}/>,title:"Add words or a picture",text:"Describe what you want, or drop in a photo or clip to start from."},
          {icon:<Sparkles size={20}/>,title:"Press Generate",text:hosted?"Comfy Cloud makes it, and the result appears right there and in the Library.":"Your computer makes it, and the result appears right there and in the Library."},
        ]}/>}
      {section==="run"&&<>
        <HowItWorks title="Who does the work" lead={'Making pictures and video needs a strong graphics card. "Run on" in the top bar picks who does it.'}
          steps={[
            {icon:<Cloud size={20}/>,title:"Comfy Cloud",text:"Renders on your own Comfy account and uses its credits. Comfy allows this on paid plans only. You sign in once with an API key from your Comfy account."},
            {icon:<Cpu size={20}/>,title:"Your own computer",text:hosted?"Free and fully private: download CreativeField and run it on a PC with a recent NVIDIA graphics card. A website can't do this part.":'Free and fully private: ComfyUI on this PC makes everything. Pick "This computer" under Run on.'},
            {icon:<MessageCircle size={20}/>,title:"ChatGPT",text:hosted?"In the downloaded app, FotoField can edit pictures through your own ChatGPT sign-in and plan. It isn't offered on this website.":"FotoField can edit pictures through your own ChatGPT sign-in and plan. Pick ChatGPT under Run on, then sign in once in Settings, ChatGPT."},
          ]}/>
        {hosted&&<Toolbar>{cloudConnected?<StatusText tone="ok">Signed in to Comfy Cloud</StatusText>:onCloudSignIn&&<Button variant="primary" onClick={onCloudSignIn}>Sign in to Comfy Cloud</Button>}<LinkButton variant="secondary" href={GITHUB_URL} target="_blank" rel="noreferrer">Download the app</LinkButton></Toolbar>}
      </>}
      {section==="worker"&&<>
        <HowItWorks title="What a worker is" lead="A worker is the computer that actually makes your pictures and videos. It runs ComfyUI, a free program that holds the AI models. CreativeField is the simple front: it sends your words and pictures to the worker and shows you what comes back."
          steps={hosted
            ?[{icon:<Cloud size={20}/>,title:"Here, it is Comfy Cloud",text:"On this website your worker is Comfy Cloud. Sign in with your Comfy Cloud key and it is set up; there is nothing to install."},
              {icon:<Cpu size={20}/>,title:"Or your own PC",text:"Download CreativeField and install ComfyUI, and both run on your computer. A website can't reach a program on your computer."}]
            :[{icon:<Download size={20}/>,title:"Install ComfyUI",text:"Get ComfyUI from comfy.org and start it. It answers at http://127.0.0.1:8188."},
              {icon:<Cpu size={20}/>,title:"Add it here",text:"Settings, Workers: enter that address, then Probe. Its models then appear in Models."},
              {icon:<Sparkles size={20}/>,title:"Make something",text:"A tool that needs a missing model says which one, and Models shows where it goes."}]}/>
        {(hosted?!cloudConnected&&onCloudSignIn:onOpenWorkers)&&<Toolbar>{hosted?<Button variant="primary" onClick={onCloudSignIn}>Sign in to Comfy Cloud</Button>:<Button variant="secondary" onClick={onOpenWorkers}>Open Workers</Button>}</Toolbar>}
      </>}
      {section==="data"&&<HowItWorks title="Where your things are kept" lead={hosted?"Here is exactly where each thing lives.":"CreativeField runs on this computer, so your things stay here."}
        steps={hosted
          ?[{icon:<KeyRound size={20}/>,title:"Your Comfy Cloud key",text:"Saved in this browser only. The site holds it in memory while you use it and forgets it when it restarts; it is never written to disk or a database."},
            {icon:<Monitor size={20}/>,title:"Drafts and choices",text:"Prompt drafts and choices such as this guide stay in this browser."},
            {icon:<ImageIcon size={20}/>,title:"Pictures and videos",text:"Files you add and results you make sit in your own private workspace on this site, because Comfy Cloud needs them to render. No other visitor can open it. The downloaded app keeps every file on your computer."}]
          :[{icon:<Monitor size={20}/>,title:"On this computer",text:"Projects, pictures, videos and keys are stored on this computer. Prompt drafts stay in this browser."},
            {icon:<Cloud size={20}/>,title:"Cloud runs",text:"Only when you pick Comfy Cloud, Comfy Router or ChatGPT is a run's input sent to that service, on your own account."}]}/>}
      {section==="download"&&<>
        <HowItWorks title="Get CreativeField" lead="Free and open source. Run it on your own computer to keep everything private and render without cloud credits."
          steps={[
            {icon:<Download size={20}/>,title:"Download",text:"Get the app from GitHub. The page explains how to install it; the ZIP holds the whole app."},
            {icon:<Cpu size={20}/>,title:"Install ComfyUI",text:"CreativeField needs ComfyUI and a recent NVIDIA graphics card to make things on your computer."},
            {icon:<Sparkles size={20}/>,title:"Start creating",text:"Open CreativeField in your browser. Everything stays on your computer."},
          ]}/>
        <Toolbar>{download}</Toolbar>
      </>}
    </div>
  </Dialog>;
}
