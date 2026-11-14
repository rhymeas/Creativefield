import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {MediaCard,Notice,WordWave,VisemeStrip} from "../../ds";
import {readSpeechPlayback} from "../../capabilities/speech-playback";
import {assetUrl,type Asset} from "../api";
import {voiceWindow} from "./voice-window";

/** One media clock owns the waveform, transcript, pause and seek state. No autoplay. */
type Props={workspace:string;asset:Asset;startSeconds?:number;durationSeconds?:number;video?:{src:string;fps:number}};
export function SpeechAudioPlayer(props:Omit<Props,"video">){return <SpeechPlaybackPlayer {...props}/>;}
export function SpeechVideoPlayer(props:Props&{video:{src:string;fps:number}}){return <SpeechPlaybackPlayer {...props}/>;}
function SpeechPlaybackPlayer({workspace,asset,startSeconds=0,durationSeconds,video}:Props){
  const mediaSrc=video?.src??assetUrl(workspace,asset.id);
  const audio=useRef<HTMLMediaElement|null>(null),setMedia=useCallback((node:HTMLMediaElement|null)=>{audio.current=node;},[]),raf=useRef<number|null>(null),alive=useRef(true),[time,setTime]=useState(0),[ready,setReady]=useState(false),[mediaDuration,setMediaDuration]=useState(0);
  const range=voiceWindow(video?0:startSeconds,durationSeconds,mediaDuration),rangeRef=useRef(range);rangeRef.current=range;
  const playback=useMemo(()=>{const voice=asset.metadata?.systemVoice as {text?:unknown;playback?:unknown}|undefined;return readSpeechPlayback(voice?.playback,{sha256:asset.sha256,text:voice?.text,sampleRate:asset.metadata?.sampleRate,frames:asset.metadata?.frames});},[asset.sha256,asset.metadata]);
  const stop=useCallback(()=>{if(raf.current!==null)cancelAnimationFrame(raf.current);raf.current=null;},[]);
  const sync=useCallback(()=>{const a=audio.current,r=rangeRef.current;if(!a||!alive.current||!r)return;if(a.currentTime<r.start)a.currentTime=r.start;if(a.currentTime>=r.end){stop();a.pause();if(a.currentTime>r.end)a.currentTime=r.end;}setTime(Math.max(0,Math.min(r.end,a.currentTime)-r.start));},[stop]);
  const start=useCallback(()=>{stop();const a=audio.current,r=rangeRef.current;if(!a||a.paused||document.hidden)return;if(!r){a.pause();return;}if(a.currentTime>=r.end||a.currentTime<r.start)a.currentTime=r.start;const tick=()=>{const current=audio.current;if(!current||!alive.current||current.paused||current.ended||document.hidden){raf.current=null;return;}sync();if(!current.paused)raf.current=requestAnimationFrame(tick);};tick();},[stop,sync]);
  useEffect(()=>{const visibility=()=>document.hidden?stop():start();document.addEventListener("visibilitychange",visibility);return()=>{document.removeEventListener("visibilitychange",visibility);stop();};},[start,stop]);
  useEffect(()=>{alive.current=true;const a=audio.current;if(a&&a.getAttribute("src")!==mediaSrc)a.setAttribute("src",mediaSrc);setReady(false);setMediaDuration(0);setTime(0);return()=>{alive.current=false;stop();a?.pause();a?.removeAttribute("src");a?.load();};},[stop,mediaSrc]);
  const events={controls:true,preload:"metadata",ref:setMedia,onLoadedMetadata:()=>{const a=audio.current;if(!a)return;setMediaDuration(a.duration);const r=voiceWindow(video?0:startSeconds,durationSeconds,a.duration);rangeRef.current=r;if(r)a.currentTime=r.start;
    const sourceWindow=playback&&voiceWindow(startSeconds,durationSeconds,playback.frames/playback.sampleRate),matches=playback&&(video?Number.isFinite(durationSeconds)&&Math.abs(a.duration-durationSeconds!)<=1/video.fps+.025:Math.abs(a.duration-playback.frames/playback.sampleRate)<=1/playback.sampleRate+.001);setReady(!!r&&!!sourceWindow&&!!matches);},onPlay:start,onPause:()=>{stop();sync();},onEnded:()=>{stop();sync();},onTimeUpdate:sync,onSeeking:sync,onSeeked:sync};
  const cueStart=playback?Math.floor(startSeconds*playback.sampleRate):0,cueEnd=playback?Math.min(playback.frames,Math.floor((startSeconds+(durationSeconds??mediaDuration))*playback.sampleRate)):0;
  const window=startSeconds!==0||durationSeconds!==undefined?{startSample:cueStart,endSample:cueEnd}:undefined;
  const seek=(seconds:number)=>{const a=audio.current;if(a&&range&&Number.isFinite(seconds)){a.currentTime=Math.max(range.start,Math.min(range.end,range.start+seconds));sync();}};
  return <div className="cf-form">{video?<MediaCard quiet media={<video aria-label="Portrait table read" playsInline src={mediaSrc} {...events}/>}/>:<audio aria-label="Voice take" src={mediaSrc} {...events}/>}{mediaDuration>0&&!range&&<Notice inline priority={20} title="Choose an earlier audio window">This start or duration is outside the selected take.</Notice>}{playback&&ready&&range&&<><WordWave playback={playback} window={window} currentTime={time} onSeek={seek}/><VisemeStrip playback={playback} window={window} currentTime={time} onSeek={seek}/></>}</div>;
}
