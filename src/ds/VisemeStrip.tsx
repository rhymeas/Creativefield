import {useEffect,useRef} from "react";
import {speechVisemeAt,type SpeechPlayback} from "../capabilities/speech-playback";
import "./viseme-strip.css";

// SAPI en-US mouth groups. Drawings are schematic keys, not measured video faces.
const LABELS=["Silence","AE · AX · AH","AA","AO","EY · EH · UH","ER","Y · IY · IH · IX","W · UW","OW","AW","OY","AY","H","R","L","S · Z","SH · CH · JH · ZH","TH · DH","F · V","D · T · N","K · G · NG","P · B · M"];
const HEIGHTS=[1,5,8,7,4,3,3,5,5,7,5,6,4,3,3,2,4,3,2,3,5,1];
export function VisemeStrip({playback,currentTime,onSeek,window}:{playback:SpeechPlayback;currentTime:number;onSeek:(seconds:number)=>void;window?:{startSample:number;endSample:number}}){
  const start=window&&Number.isFinite(window.startSample)?Math.max(0,Math.min(playback.frames-1,window.startSample)):0,end=window&&Number.isFinite(window.endSample)?Math.max(start+1,Math.min(playback.frames,window.endSample)):playback.frames;
  const events=(playback.visemes??[]).filter(v=>v.sample<end&&v.sample+v.duration>start),time=Number.isFinite(currentTime)?Math.max(0,Math.min((end-start)/playback.sampleRate,currentTime)):0,sample=start+Math.round(time*playback.sampleRate),active=sample<end?speechVisemeAt(events,sample):-1;
  const strip=useRef<HTMLDivElement>(null),buttons=useRef<(HTMLButtonElement|null)[]>([]);
  useEffect(()=>{const row=strip.current,button=buttons.current[active];if(!row||!button)return;const box=button.getBoundingClientRect(),bounds=row.getBoundingClientRect();if(box.left<bounds.left)row.scrollLeft+=box.left-bounds.left;else if(box.right>bounds.right)row.scrollLeft+=box.right-bounds.right;},[active]);
  if(!events.length||playback.visemeSource!=="windows-viseme-reached-v1")return null;
  const seek=(index:number)=>{const event=events[index];onSeek((Math.max(start,event.sample)-start)/playback.sampleRate);};
  return <div className="ds-visemestrip" ref={strip} role="group" aria-label="Speech mouth shapes">{events.map((event,index)=><button key={`${event.sample}:${event.id}`} ref={node=>{buttons.current[index]=node;}} type="button" className="ds-visemestrip__item" tabIndex={index===(active>=0?active:0)?0:-1} aria-current={index===active?"true":undefined} aria-label={`Seek to ${LABELS[event.id]} at ${((Math.max(start,event.sample)-start)/playback.sampleRate).toFixed(2)} seconds`} title={LABELS[event.id]} onClick={()=>seek(index)} onKeyDown={e=>{let next:number|undefined;if(e.key==="ArrowRight")next=Math.min(events.length-1,index+1);if(e.key==="ArrowLeft")next=Math.max(0,index-1);if(e.key==="Home")next=0;if(e.key==="End")next=events.length-1;if(next!==undefined){e.preventDefault();seek(next);buttons.current[next]?.focus();}}}><svg viewBox="0 0 32 24" aria-hidden="true">{event.id===0||event.id===21?<path d="M7 12 Q16 15 25 12"/>:<><ellipse cx="16" cy="12" rx={event.id===7||event.id===8?5:9} ry={HEIGHTS[event.id]}/>{[15,17,18,19].includes(event.id)&&<path d="M9 11 H23"/>}</>}</svg></button>)}</div>;
}
