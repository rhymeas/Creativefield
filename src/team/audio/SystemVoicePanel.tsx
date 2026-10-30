import {useEffect,useRef,useState} from "react";
import {Button,Dialog,InfoButton,LinkButton,Notice,PromptField,SegmentedTabs,Toolbar} from "../../ds";
import {ApiError,assetUrl,workspacePath,type Asset,type Call,type Project,type Run,type Worker,type Workspace} from "../api";
import {activeRun} from "../state";
import {capability} from "../../capabilities/lookup";
import {TeamChoice} from "../TeamChoice";
import {SpeechAudioPlayer} from "./SpeechAudioPlayer";
type Intent={requestId:string;text:string;voice:string;delivery:"natural"|"calm"|"brisk"};
type Voice={name:string;culture:string};
/** The neural voice: a ComfyUI run of Chatterbox (local model, default voice, no cloning). */
const CHATTERBOX="chatterbox:default";
const EXPRESSIVENESS:Record<Intent["delivery"],number>={calm:0.35,natural:0.5,brisk:0.8};
/** The run ended without speech (failed or cancelled); the frozen request is done and a new one may start. */
class FinishedWithoutSpeech extends Error {}
export function SystemVoicePanel({workspace,project,userId,call,onSaved,onLipSync}:{workspace:Workspace;project:Project;userId:string;call:Call;onSaved:(id:string)=>void;onLipSync?:(id:string)=>void}){
  const key=`comfyfield:system-voice:v1:${userId}:${workspace.id}:${project.id}`,alive=useRef(true);
  const [open,setOpen]=useState(false),[voices,setVoices]=useState<Voice[]>([]),[loading,setLoading]=useState(false),[voice,setVoice]=useState(""),[text,setText]=useState(""),[delivery,setDelivery]=useState<Intent["delivery"]>("natural"),[pending,setPending]=useState<Intent|null>(null),[asset,setAsset]=useState<Asset|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const locked=busy||!!pending,canEdit=workspace.role!=="viewer";
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(!open)return;let current=true;const abort=new AbortController();setLoading(true);void call<{voices:Voice[]}>(workspacePath(workspace.id,`projects/${project.id}/system-voice`),"GET",undefined,{signal:abort.signal}).then(v=>{if(current){setVoices(v.voices);setVoice(old=>old||CHATTERBOX);}}).catch(e=>{if(current)setError((e as Error).message);}).finally(()=>{if(current)setLoading(false);});return()=>{current=false;abort.abort();};},[open,workspace.id,project.id,call]);
  function show(){setError("");try{const saved=JSON.parse(sessionStorage.getItem(key)??"null") as Intent|null;if(saved&&typeof saved.requestId==="string"&&typeof saved.text==="string"&&saved.text.trim()&&saved.text.length<=400&&typeof saved.voice==="string"&&["natural","calm","brisk"].includes(saved.delivery)){setPending(saved);setText(saved.text);setVoice(saved.voice);setDelivery(saved.delivery);}}catch{setError("Browser recovery storage is unavailable. Keep this dialog open after generating.");}setOpen(true);}
  /** Queues the Chatterbox run under a key derived from the request, so a retry never speaks twice, and waits for its audio. */
  async function speakWithChatterbox(intent:Intent):Promise<Asset>{
    const worker=(await call<Worker[]>(workspacePath(workspace.id,"workers"))).find(w=>w.enabled);
    if(!worker)throw new Error("No ComfyUI worker is enabled for this workspace.");
    let run:Run;
    try{run=await call<Run>(workspacePath(workspace.id,"runs"),"POST",{projectId:project.id,workerId:worker.id,idempotencyKey:`speech-${intent.requestId}`,...capability("chatterbox-tts"),routeId:"local",inputs:{},elementInputs:{},controls:{prompt:intent.text,exaggeration:EXPRESSIVENESS[intent.delivery]},audioPolicy:"mute"});}
    // The same request key answers with a conflict once its run has ended; that request is done.
    catch(e){if(e instanceof ApiError&&e.status===409)throw new FinishedWithoutSpeech(`${e.message} Generate again to start a new take.`);throw e;}
    const until=Date.now()+10*60_000;
    while(activeRun(run.state)&&Date.now()<until&&alive.current){await new Promise(resolve=>setTimeout(resolve,2000));run=await call<Run>(workspacePath(workspace.id,`runs/${run.id}`));}
    if(activeRun(run.state))throw new Error("Speech is still being generated. Confirm the same request again in a moment.");
    if(run.state!=="succeeded"||!run.output_ids[0])throw new FinishedWithoutSpeech(`${run.error??"Speech generation did not finish."} Generate again to start a new take.`);
    return await call<Asset>(workspacePath(workspace.id,`assets/${run.output_ids[0]}`));
  }
  async function generate(){if(busy||!canEdit)return;setBusy(true);setError("");try{const intent=pending??{requestId:crypto.randomUUID(),text:text.trim(),voice,delivery};sessionStorage.setItem(key,JSON.stringify(intent));setPending(intent);const result=intent.voice===CHATTERBOX?await speakWithChatterbox(intent):await call<Asset>(workspacePath(workspace.id,`projects/${project.id}/system-voice`),"POST",intent,{timeoutMs:60000});if(!alive.current)return;if(result.project_id!==project.id||result.media_type!=="audio")throw Error("The generated voice does not match this project.");sessionStorage.removeItem(key);setPending(null);setAsset(result);onSaved(result.id);}catch(e){if(alive.current){setError((e as Error).message);if(e instanceof FinishedWithoutSpeech||e instanceof ApiError&&e.status>=400&&e.status<500&&![408,409,429].includes(e.status)){setPending(null);try{sessionStorage.removeItem(key);}catch{}}}}finally{if(alive.current)setBusy(false);}}
  return <><Button variant="secondary" disabled={!canEdit} onClick={show}>Create local voice</Button><Dialog open={open} title="Local voice" onClose={()=>{if(!busy)setOpen(false);}} footer={<Toolbar>{!asset&&<Button variant="primary" disabled={!canEdit||busy||!pending&&(!text.trim()||!voice||loading)} onClick={()=>void generate()}>{busy?"Generating…":pending?"Confirm same request":"Generate voice"}</Button>}{asset&&<Button variant="secondary" onClick={()=>setAsset(null)}>New take</Button>}<Button variant="ghost" disabled={busy} onClick={()=>setOpen(false)}>Close</Button></Toolbar>}><div className="cf-form">
    {!asset?<><PromptField compact label="Text to speak" placeholder="Write a short line" value={text} onChange={v=>setText(v.slice(0,400))} disabled={locked}/><TeamChoice label="Voice" display={voice===CHATTERBOX?"Chatterbox · natural":voice||"Choose a voice"} value={voice} disabled={locked||loading} options={[{value:CHATTERBOX,label:"Chatterbox · natural",note:"Local model in ComfyUI"},...voices.map(v=>({value:v.name,label:v.name,note:v.culture}))]} onChange={setVoice}/><SegmentedTabs quiet label="Delivery" value={delivery} onChange={v=>setDelivery(v as Intent["delivery"])} items={[{id:"natural",label:"Natural",disabled:locked},{id:"calm",label:"Calm",disabled:locked},{id:"brisk",label:"Brisk",disabled:locked}]}/>{loading&&<Notice inline priority={10} tone="info">Checking installed voices…</Notice>}</>:<><SpeechAudioPlayer key={asset.id} workspace={workspace.id} asset={asset}/><Toolbar><LinkButton href={assetUrl(workspace.id,asset.id,true)}>Download audio</LinkButton>{onLipSync&&<Button variant="secondary" onClick={()=>{setOpen(false);onLipSync(asset.id);}}>Animate a portrait</Button>}</Toolbar></>}
    <InfoButton title="Local speech">Chatterbox · natural runs Resemble AI's Chatterbox (MIT) in ComfyUI on this machine, in its built-in voice; delivery changes how expressive it sounds, and a short line takes about a minute. The other voices are this server’s installed Windows speech voices; delivery changes their speaking speed. No voice is cloned and no paid service is used. Portrait lip sync lets you choose a short window from this take.</InfoButton>{pending&&<Notice inline priority={70} title="Voice request awaiting confirmation">Text and voice are frozen. Confirming reuses the original request.</Notice>}{error&&<Notice inline priority={60} title="Voice generation needs attention">{error}</Notice>}
  </div></Dialog></>;
}
