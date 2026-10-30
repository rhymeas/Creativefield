import {useEffect,useRef,useState} from "react";
import {Button,Checkbox,LevelMeter,LinkButton,Meta,Notice,PanelSection,Teleprompter,PromptField,Toolbar} from "../../ds";
import {assetUrl,workspacePath,type Call,type Project,type Workspace} from "../api";
import "./microphone.css";
import {LocalMicrophone} from "./microphone";

type Take={id:string;asset_id:string;record:{durationSeconds:number;sampleRate:number;frames:number;script:string;consent:{microphone:boolean}}};
export function MicrophonePanel({workspace,project,call,onSaved}:{workspace:Workspace;project:Project;call:Call;onSaved:(assetId:string)=>void}){
  const capture=useRef<LocalMicrophone|null>(null),mounted=useRef(true),epoch=useRef(0),url=useRef("");
  const [consent,setConsent]=useState(false),[script,setScript]=useState(""),[frozenScript,setFrozenScript]=useState(""),[state,setState]=useState<"idle"|"requesting"|"recording"|"review"|"uploading">("idle"),[level,setLevel]=useState(0),[seconds,setSeconds]=useState(0),[preview,setPreview]=useState(""),[blob,setBlob]=useState<Blob|null>(null),[key,setKey]=useState(""),[saved,setSaved]=useState<Take|null>(null),[error,setError]=useState("");
  const [recent,setRecent]=useState<Take[]>([]);
  const canEdit=workspace.role!=="viewer",active=state==="recording"||state==="requesting";
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;capture.current?.stop();if(url.current)URL.revokeObjectURL(url.current);};},[]);
  useEffect(()=>{let current=true;void call<Take[]>(workspacePath(workspace.id,`projects/${project.id}/microphone-takes`)).then(takes=>{if(current)setRecent(takes.slice(0,3));}).catch(e=>{if(current)setError((e as Error).message);});return()=>{current=false;};},[workspace.id,project.id,call]);
  function clearPreview(){if(url.current)URL.revokeObjectURL(url.current);url.current="";setPreview("");setBlob(null);}
  function stop(keep:boolean){
    epoch.current++;const result=capture.current?.stop(keep);setLevel(0);
    if(result){clearPreview();url.current=URL.createObjectURL(result.blob);setPreview(url.current);setBlob(result.blob);setSeconds(result.durationSeconds);setKey(crypto.randomUUID());setState("review");}
    else{setState("idle");setSeconds(0);}
  }
  async function start(){
    if(!consent||!canEdit||active||state==="uploading")return;
    clearPreview();setSaved(null);setError("");setFrozenScript(script);setState("requesting");setSeconds(0);const current=++epoch.current;
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw new Error("Microphone capture needs a supported browser and a secure local page.");
      const mic=new LocalMicrophone();capture.current=mic;
      const started=await mic.start((next,time)=>{if(mounted.current&&current===epoch.current){setLevel(next);setSeconds(time);}},()=>{if(mounted.current&&current===epoch.current)stop(true);},message=>{if(mounted.current&&current===epoch.current){setError(message);setState("idle");setLevel(0);}});
      if(mounted.current&&current===epoch.current&&started)setState("recording");
    }catch(e){if(mounted.current&&current===epoch.current){setError((e as Error).name==="NotAllowedError"?"Microphone permission was denied. Allow access for this local page or use an uploaded audio file.":(e as Error).message);setState("idle");}}
  }
  async function save(){
    if(!blob||!consent||!canEdit||state!=="review")return;setState("uploading");setError("");
    const form=new FormData();form.append("script",frozenScript);form.append("file",blob,"microphone-take.wav");
    try{const take=await call<Take>(workspacePath(workspace.id,`projects/${project.id}/microphone-takes?idempotencyKey=${key}&consent=true`),"POST",form);if(mounted.current){setSaved(take);setRecent(old=>[take,...old.filter(t=>t.id!==take.id)].slice(0,3));setState("review");onSaved(take.asset_id);}}
    catch(e){if(mounted.current){setError((e as Error).message);setState("review");}}
  }
  return <PanelSection label="Table read">
    <Meta>Record up to 60 seconds locally, review the take, then save it to this project. This records audio; speech synthesis and lip sync are unavailable.</Meta>
    <PromptField label="Table-read text (optional)" placeholder="Lines to read while recording" value={script} disabled={active||state==="uploading"||!!blob} onChange={value=>setScript(value.slice(0,4000))}/>
    {(active||blob)&&<Teleprompter lines={(active||blob?frozenScript:script).split(/\n/).filter(Boolean)}/>}
    <Checkbox checked={consent} disabled={!canEdit||active||state==="uploading"} onChange={setConsent}>I have permission to record this voice and save the take locally.</Checkbox>
    {active&&<><LevelMeter level={level}/><Meta>{state==="requesting"?"Waiting for microphone permission":`Recording · ${seconds.toFixed(1)} / 60 s`}</Meta></>}
    <Toolbar>{active?<><Button variant="secondary" disabled={state==="requesting"} onClick={()=>stop(true)}>Stop recording</Button><Button variant="ghost" onClick={()=>stop(false)}>Cancel recording</Button></>:<Button variant="secondary" disabled={!canEdit||!consent||state==="uploading"} onClick={()=>void start()}>{blob?"Record another take":"Record microphone"}</Button>}</Toolbar>
    {preview&&<><audio className="cf-microphone-audio" controls preload="metadata" src={preview}/><Meta>{seconds.toFixed(3)} seconds · mono PCM16 WAV · preview remains in this browser until saved</Meta><Toolbar><Button variant="secondary" disabled={!consent||!canEdit||state==="uploading"||!!saved} onClick={()=>void save()}>{saved?"Take saved":state==="uploading"?"Saving take":"Save audio take"}</Button><Button variant="ghost" disabled={state==="uploading"} onClick={()=>{clearPreview();setState("idle");setSaved(null);}}>Discard preview</Button></Toolbar></>}
    {saved&&<LinkButton variant="secondary" href={assetUrl(workspace.id,saved.asset_id,true)}>Download saved WAV</LinkButton>}
    {!active&&!blob&&recent.length>0&&<><Meta>Recent saved microphone takes</Meta>{recent.map(take=><div key={take.id}><audio className="cf-microphone-audio" controls preload="metadata" src={assetUrl(workspace.id,take.asset_id)}/><Meta>{take.record.durationSeconds.toFixed(3)} s · {take.record.sampleRate} Hz · consent recorded</Meta><Button variant="ghost" disabled={!canEdit||state==="uploading"} onClick={()=>onSaved(take.asset_id)}>Use this audio take</Button></div>)}</>}
    {error&&<Notice priority={60} title="The microphone didn't record" actions={<Button variant="secondary" disabled={!canEdit||!consent||state==="uploading"} onClick={()=>void start()}>Try again</Button>} details={error}>No audio was kept. Trying again asks for the microphone and starts one new take.</Notice>}
  </PanelSection>;
}
