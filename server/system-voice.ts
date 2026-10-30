import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdir,mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import path from "node:path";
import {voiceWav} from "./voice-wav";
import {HttpError} from "./auth";
import type {SpeechMark,SpeechVisemeMark} from "../src/capabilities/speech-playback";
export type SystemVoice={name:string;culture:string};
export type SystemVoiceEngine={voices:()=>Promise<SystemVoice[]>;synthesize:(input:{text:string;voice:string;rate:number},tempRoot:string)=>Promise<{bytes:Buffer;marks?:SpeechMark[];visemes?:SpeechVisemeMark[]}>};
const capture=`Add-Type -ReferencedAssemblies ([System.Speech.Synthesis.SpeechSynthesizer].Assembly.Location) -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Speech.Synthesis;
public class ComfyFieldSpeechCues {
 public class Mark { public long ticks; public int start; public int length; public string text; }
 public class Viseme { public long ticks; public long durationTicks; public int id; }
 public class Result { public Mark[] marks; public Viseme[] visemes; public string culture; }
 public static Result Capture(SpeechSynthesizer s,string text) {
  var marks=new List<Mark>();var visemes=new List<Viseme>();var gate=new object();
  EventHandler<SpeakProgressEventArgs> h=delegate(object sender,SpeakProgressEventArgs e) {lock(gate) {marks.Add(new Mark {ticks=e.AudioPosition.Ticks,start=e.CharacterPosition,length=e.CharacterCount,text=e.Text});}};
  EventHandler<VisemeReachedEventArgs> v=delegate(object sender,VisemeReachedEventArgs e) {lock(gate) {visemes.Add(new Viseme {ticks=e.AudioPosition.Ticks,durationTicks=e.Duration.Ticks,id=e.Viseme});}};
  s.SpeakProgress+=h;s.VisemeReached+=v;try {s.Speak(text);} finally {s.SpeakProgress-=h;s.VisemeReached-=v;}lock(gate) {return new Result {marks=marks.ToArray(),visemes=visemes.ToArray(),culture=s.Voice.Culture.Name};}
 }
}
"@
`;
const execute=promisify(execFile);
const intro="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Speech;$synth=New-Object System.Speech.Synthesis.SpeechSynthesizer;";
async function speech(script:string,env?:NodeJS.ProcessEnv){
  try{return (await execute("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(intro+"try {"+script+"} finally {$synth.Dispose()}","utf16le").toString("base64")],{windowsHide:true,timeout:20000,maxBuffer:65536,env:env??process.env})).stdout.trim().replace(/^\uFEFF/,"");}catch{throw new HttpError(503,"Local system speech is unavailable. Record a take or upload a WAV instead.");}
}
export const windowsSystemVoice:SystemVoiceEngine={
  async voices(){if(process.platform!=="win32")return [];const raw=JSON.parse(await speech("@($synth.GetInstalledVoices() | Where-Object Enabled | ForEach-Object {[pscustomobject]@{name=$_.VoiceInfo.Name;culture=$_.VoiceInfo.Culture.Name}}) | ConvertTo-Json -Compress"));return (Array.isArray(raw)?raw:raw?[raw]:[]).filter(v=>typeof v.name==="string"&&typeof v.culture==="string");},
  async synthesize(input,tempRoot){if(process.platform!=="win32")throw new HttpError(503,"Local system speech requires an installed Windows speech voice.");await mkdir(tempRoot,{recursive:true});const dir=await mkdtemp(path.join(tempRoot,"system-voice-"));try{
    const output=path.join(dir,"voice.wav"),request=path.join(dir,"request.json");await writeFile(request,JSON.stringify({...input,output}));
    // User text, paths and voice names are data in a UTF-8 JSON file, never PowerShell code or SSML.
    const raw=await speech(capture+"$r=Get-Content -LiteralPath $env:COMFYFIELD_SYSTEM_VOICE_REQUEST -Raw -Encoding UTF8 | ConvertFrom-Json;$synth.SelectVoice([string]$r.voice);$synth.Rate=[int]$r.rate;$format=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);$synth.SetOutputToWaveFile([string]$r.output,$format);$cues=[ComfyFieldSpeechCues]::Capture($synth,[string]$r.text);ConvertTo-Json -InputObject $cues -Depth 4 -Compress",{...process.env,COMFYFIELD_SYSTEM_VOICE_REQUEST:request});
    const bytes=await readFile(output);voiceWav(bytes);const cues=JSON.parse(raw||"{}");return {bytes,marks:cues.marks,visemes:cues.culture==="en-US"?cues.visemes:undefined};
  }finally{await rm(dir,{recursive:true,force:true});}},
};
