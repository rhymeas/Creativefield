import {useState} from "react";
import {Button,Dialog,InfoButton} from "../../ds";
import type {Asset} from "../api";
import {SpeechAudioPlayer} from "./SpeechAudioPlayer";
export function VoicePreview({workspace,asset,startSeconds,durationSeconds}:{workspace:string;asset:Asset;startSeconds:number;durationSeconds:number}){
  const [open,setOpen]=useState(false);return <><Button variant="secondary" onClick={()=>setOpen(true)}>Preview voice</Button><Dialog open={open} title="Voice window" onClose={()=>setOpen(false)} footer={<Button variant="ghost" onClick={()=>setOpen(false)}>Close</Button>}><SpeechAudioPlayer key={`${asset.id}:${startSeconds}:${durationSeconds}`} workspace={workspace} asset={asset} startSeconds={startSeconds} durationSeconds={durationSeconds}/><InfoButton title="Voice window">This preview uses the selected audio start and the frame-rounded generation duration. Word cues appear only when the take contains verified engine timing. Seeking stays inside the selected window. Closing stops playback; generating the portrait is still a separate action.</InfoButton></Dialog></>;
}
