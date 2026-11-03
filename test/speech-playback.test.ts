import {describe,it,expect} from "vitest";
import {createHash} from "node:crypto";
import {encodeMonoWav} from "../src/team/audio/microphone";
import {makeSpeechPlayback} from "../server/speech-playback";
import {readSpeechPlayback,speechSegments,speechWordAt,speechWords,type SpeechMark} from "../src/capabilities/speech-playback";
import measured from "../src/ds/fixtures/speech-playback.json";

describe("source-bound speech onset playback",()=>{
  const text="Hi 👋 30%.",marks:SpeechMark[]=[{ticks:1000000,start:0,length:2,text:"Hi"},{ticks:2000000,start:3,length:2,text:"👋"},{ticks:3000000,start:6,length:3,text:"30%"},{ticks:5000000,start:6,length:3,text:"30%"}];
  it("uses actual onset samples and preserves repeated spans without duplicating the transcript",()=>{
    const words=speechWords(text,marks,16000,16000);expect(words.map(w=>w.sample)).toEqual([1600,3200,4800,8000]);
    const segments=speechSegments(text,words);expect(segments.map(s=>s.text).join("")).toBe(text);expect(segments.filter(s=>s.sample!==undefined).map(s=>s.text)).toEqual(["Hi","👋","30%"]);
    expect(speechWordAt(words,0)).toBe(-1);expect(speechWordAt(words,1599)).toBe(-1);expect(speechWordAt(words,1600)).toBe(0);expect(speechWordAt(words,7999)).toBe(2);expect(speechWordAt(words,8000)).toBe(3);expect(speechWordAt(words,NaN)).toBe(-1);
  });
  it("rejects malformed, resampled/out-of-range, reordered and Unicode-splitting engine cues instead of making timestamps fit",()=>{
    for(const invalid of [[{...marks[0],ticks:-1}],[{...marks[0],ticks:10000000}],[marks[1],marks[0]],[{...marks[0],text:"Different"}],[{ticks:100,start:3,length:1,text:"\ud83d"}],[marks[0],{ticks:2000000,start:1,length:1,text:"i"}],Array(1025).fill(marks[0])])expect(speechWords(text,invalid,16000,16000)).toEqual([]);
    expect(speechWords(text,undefined,16000,16000)).toEqual([]);expect(speechWords(text,marks,NaN,16000)).toEqual([]);expect(speechWords(text,marks,16000,Infinity)).toEqual([]);
  });
  it("computes bounded real PCM peaks and binds them and the transcript to the exact WAV",async()=>{
    const pcm=new Float32Array(16000);pcm[0]=-.5;pcm[15999]=1;
    const bytes=Buffer.from(await encodeMonoWav([pcm],16000).blob.arrayBuffer()),p=makeSpeechPlayback(bytes,text,marks);
    expect(p.audioSha256).toBe(createHash("sha256").update(bytes).digest("hex"));expect(p.peaks).toHaveLength(96);expect(p.peaks[0]).toBe(.5);expect(p.peaks[95]).toBe(32767/32768);expect(p.peaks.slice(1,95).every(v=>v===0)).toBe(true);
    const identity={sha256:p.audioSha256,text,sampleRate:16000,frames:16000};expect(readSpeechPlayback(p,identity)).toBe(p);
    for(const patch of [{sha256:"0".repeat(64)},{text:"Changed"},{sampleRate:24000},{frames:15999}])expect(readSpeechPlayback(p,{...identity,...patch})).toBeNull();
    for(const patch of [{peaks:[Infinity,...p.peaks.slice(1)]},{peaks:Array(129).fill(0)},{words:[{sample:16000,start:0,length:2}]},{words:[{sample:1,start:3,length:1}]},{words:[{sample:2,start:3,length:2},{sample:1,start:0,length:2}]},{source:"estimated"}])expect(readSpeechPlayback({...p,...patch},identity)).toBeNull();
  });
  it("keeps legacy/missing-cue takes usable without fabricated highlights",async()=>{
    const bytes=Buffer.from(await encodeMonoWav([new Float32Array(16000)],16000).blob.arrayBuffer()),p=makeSpeechPlayback(bytes,"One line.");
    expect(p.words).toEqual([]);expect(p.peaks.every(v=>v===0)).toBe(true);expect(speechSegments(p.text,p.words).map(s=>s.text).join("")).toBe(p.text);expect(readSpeechPlayback(undefined,{sha256:p.audioSha256})).toBeNull();
  });
  it("validates the measured Showcase fixture, including a spoken-number expansion",()=>{
    expect(readSpeechPlayback(measured,{sha256:measured.audioSha256,text:measured.text,sampleRate:measured.sampleRate,frames:measured.frames})).not.toBeNull();expect(measured.words).toHaveLength(9);expect(measured.sampleRate).toBe(16000);expect(measured.frames).toBe(88480);expect(speechSegments(measured.text,measured.words).map(s=>s.text).join("")).toBe(measured.text);
  });
});
