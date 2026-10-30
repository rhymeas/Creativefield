import {createHash} from "node:crypto";
import {voiceWav} from "./voice-wav";
import {speechWords,speechVisemes,type SpeechMark,type SpeechVisemeMark,type SpeechPlayback} from "../src/capabilities/speech-playback";
/** Peaks are decoded PCM magnitudes, not a decorative/random waveform. */
export function makeSpeechPlayback(bytes:Buffer,text:string,marks?:SpeechMark[],visemeMarks?:SpeechVisemeMark[]):SpeechPlayback{
  const facts=voiceWav(bytes),peaks=Array<number>(96).fill(0);let offset=12,dataOffset=-1;
  while(offset<bytes.length){const size=bytes.readUInt32LE(offset+4);if(bytes.toString("ascii",offset,offset+4)==="data"){dataOffset=offset+8;break;}offset+=8+size+(size%2);}
  if(dataOffset<0)throw Error("Validated PCM data required");
  for(let sample=0;sample<facts.frames;sample++){const bin=Math.min(peaks.length-1,Math.floor(sample*peaks.length/facts.frames));peaks[bin]=Math.max(peaks[bin],Math.abs(bytes.readInt16LE(dataOffset+sample*2))/32768);}
  const visemes=speechVisemes(visemeMarks,facts.sampleRate,facts.frames);
  return {version:1,source:"windows-speech-progress-v1",audioSha256:createHash("sha256").update(bytes).digest("hex"),text,sampleRate:facts.sampleRate,frames:facts.frames,peaks,words:speechWords(text,marks,facts.sampleRate,facts.frames),...(visemes.length?{visemeSource:"windows-viseme-reached-v1" as const,visemes}:{})};
}
