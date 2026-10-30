import {useMemo} from "react";
import "./word-wave.css";
import {speechSegments,speechWordAt,type SpeechPlayback} from "../capabilities/speech-playback";
/** Measured PCM peaks and engine word onsets; the caller owns media and playback. */
export function WordWave({playback,currentTime,onSeek,disabled=false,window}:{playback:SpeechPlayback;currentTime:number;onSeek:(seconds:number)=>void;disabled?:boolean;window?:{startSample:number;endSample:number}}){
  const start=window?Math.max(0,Math.min(playback.frames-1,window.startSample)):0,end=window?Math.max(start+1,Math.min(playback.frames,window.endSample)):playback.frames;
  const duration=(end-start)/playback.sampleRate,time=Number.isFinite(currentTime)?Math.max(0,Math.min(duration,currentTime)):0;
  const current=playback.words[time>=duration?-1:speechWordAt(playback.words,start+Math.round(time*playback.sampleRate))];
  const segments=useMemo(()=>{const all=speechSegments(playback.text,playback.words);if(!window||!playback.words.length)return all;const active=Math.max(0,speechWordAt(playback.words,start)),included=playback.words.slice(active).filter(w=>w.sample<end);if(!included.length)return [];const first=included[0].start,last=included.at(-1)!;return all.filter(s=>s.start>=first&&s.start<=last.start+last.length);},[playback.text,playback.words,start,end,!!window]);
  const path=useMemo(()=>playback.peaks.map((peak,i)=>{const x=(i+.5)*1000/playback.peaks.length,h=Math.max(.25,peak*23);return `M${x},${24-h}V${24+h}`;}).join(" "),[playback.peaks]);
  return <div className="ds-wordwave" role="group" aria-label="Speech transcript and waveform">
    {playback.words.length>0&&<div className="ds-wordwave__text">{segments.map(segment=>segment.sample===undefined?<span key={segment.start}>{segment.text}</span>:<button key={segment.start} type="button" className="ds-wordwave__word" disabled={disabled} aria-label={`Seek to ${segment.text}`} aria-current={current?.start===segment.start&&current.length===segment.length?"true":undefined} onClick={()=>onSeek((Math.max(start,segment.sample!)-start)/playback.sampleRate)}>{segment.text}</button>)}</div>}
    <div className="ds-wordwave__wave"><svg viewBox={`${start/playback.frames*1000} 0 ${(end-start)/playback.frames*1000} 48`} preserveAspectRatio="none" aria-hidden="true"><path className="ds-wordwave__peaks" d={path}/><path className="ds-wordwave__position" d={`M${(start+time*playback.sampleRate)/playback.frames*1000},0V48`}/></svg><input type="range" aria-label="Speech position" min={0} max={duration} step={0.01} value={time} disabled={disabled} onChange={e=>onSeek(Number(e.target.value))}/></div>
  </div>;
}
