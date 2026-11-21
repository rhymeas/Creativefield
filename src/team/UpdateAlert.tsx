import {useEffect,useState} from "react";
import {createPortal} from "react-dom";
import {Download,Sparkles} from "lucide-react";
import {Button,Dialog,LinkButton,Meta,Notice,Pill,StatusText} from "../ds";
import {GITHUB_URL,GITHUB_ZIP} from "./Guide";
import "./update-alert.css";

/** The app's own update check (server/update-check.ts). States: Pad. */
type Info={current:string;latest?:string;available:boolean;notesUrl?:string;title?:string;canSelfUpdate:boolean;reason?:string};
type Phase={kind:"closed"}|{kind:"open"}|{kind:"updating"}|{kind:"restart"}|{kind:"failed";error:string};

/** "Update" beside the GitHub icon while a newer release exists; the dialog says what is new and updates a git clone
    in place or shows the ZIP steps. Nothing shows when the app is current, offline or hosted. */
export function UpdateAlert({hosted}:{hosted:boolean}){
  const [info,setInfo]=useState<Info>();
  const [phase,setPhase]=useState<Phase>({kind:"closed"});
  useEffect(()=>{
    if(hosted)return;
    let live=true;
    const load=()=>fetch("/api/v1/app-update").then(r=>r.ok?r.json():undefined).then((value:Info|undefined)=>{if(live&&value)setInfo(value);}).catch(()=>{});
    load();const timer=setInterval(load,6*60*60*1000);
    return()=>{live=false;clearInterval(timer);};
  },[hosted]);
  /* The running version, quietly in the bottom right corner on every screen, so a screenshot always says which build it shows. */
  const version=info&&typeof document!=="undefined"?createPortal(<div className="cf-app-version" aria-label={`CreativeField ${info.current}`}><Meta parts={[`v${info.current}`]}/></div>,document.body):null;
  if(hosted||!info?.available)return version;
  const update=async()=>{
    setPhase({kind:"updating"});
    try{
      const response=await fetch("/api/v1/app-update",{method:"POST"});
      const body=await response.json().catch(()=>({})) as {state?:string;error?:string;message?:string};
      if(!response.ok)throw new Error(body.error??body.message??"The update did not finish.");
      setPhase({kind:"restart"});
    }catch(error){setPhase({kind:"failed",error:(error as Error).message});}
  };
  const close=()=>{if(phase.kind!=="updating")setPhase({kind:"closed"});};
  return <>
    {version}
    <Pill quiet title={`CreativeField ${info.latest} is out`} onClick={()=>setPhase({kind:"open"})}><Sparkles size={14}/>Update</Pill>
    <Dialog open={phase.kind!=="closed"} title={`CreativeField ${info.latest} is out`} onClose={close}
      footer={phase.kind==="restart"?<Button variant="primary" onClick={close}>Got it</Button>:
        info.canSelfUpdate?<>{info.notesUrl&&<LinkButton href={info.notesUrl} target="_blank" rel="noreferrer">What is new</LinkButton>}<Button variant="primary" disabled={phase.kind==="updating"} onClick={update}>{phase.kind==="failed"?"Try again":"Update now"}</Button></>:
        <>{info.notesUrl&&<LinkButton href={info.notesUrl} target="_blank" rel="noreferrer">What is new</LinkButton>}<LinkButton variant="primary" href={GITHUB_ZIP} rel="noreferrer"><Download size={14}/>Download ZIP</LinkButton></>}>
      <Meta parts={[`You have ${info.current}`,info.title]}/>
      {phase.kind==="updating"&&<StatusText tone="active">Updating: getting the new version, installing, building. This takes a few minutes.</StatusText>}
      {phase.kind==="restart"&&<StatusText tone="ok">Updated to {info.latest}. Close the black CreativeField window and start it again to use the new version.</StatusText>}
      {phase.kind==="failed"&&<Notice inline priority={20} title="Update stopped" details={phase.error}>Your current version keeps working. Try again, or download the ZIP.</Notice>}
      {!info.canSelfUpdate&&phase.kind==="open"&&<p>{info.reason} Unzip it into a new folder and start <b>Start CreativeField.bat</b> there. Keep this folder until the new one works; the steps are in <a href={GITHUB_URL} target="_blank" rel="noreferrer">the README</a>.</p>}
    </Dialog>
  </>;
}
