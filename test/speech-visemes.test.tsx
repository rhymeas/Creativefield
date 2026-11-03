import {describe,it,expect} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {speechVisemes,speechVisemeAt,readSpeechPlayback,type SpeechPlayback,type SpeechVisemeMark} from "../src/capabilities/speech-playback";
import {VisemeStrip} from "../src/ds/VisemeStrip";
import {WordWave} from "../src/ds/WordWave";
import fixture from "../src/ds/fixtures/speech-visemes.json";

describe("measured SAPI mouth-form playback",()=>{
  const marks:SpeechVisemeMark[]=[{ticks:0,durationTicks:1000000,id:0},{ticks:1000000,durationTicks:2000000,id:21},{ticks:1000000,durationTicks:2000000,id:6}],p=fixture as SpeechPlayback;
  const identity={sha256:p.audioSha256,text:p.text,sampleRate:p.sampleRate,frames:p.frames};
  it("keeps actual durations and simultaneous events, highlighting the latest event without inventing an interval",()=>{
    const cues=speechVisemes(marks,16000,16000);expect(cues).toEqual([{sample:0,duration:1600,id:0},{sample:1600,duration:3200,id:21},{sample:1600,duration:3200,id:6}]);expect(speechVisemeAt(cues,1599)).toBe(0);expect(speechVisemeAt(cues,1600)).toBe(2);expect(speechVisemeAt(cues,4799)).toBe(2);expect(speechVisemeAt(cues,4800)).toBe(-1);expect(speechVisemeAt(cues,NaN)).toBe(-1);expect(speechVisemeAt(cues,-1)).toBe(-1);
  });
  it("rejects malformed, reordered or out-of-WAV clocks instead of rescaling",()=>{
    for(const value of [[{...marks[0],ticks:-1}],[{...marks[0],durationTicks:0}],[{...marks[0],durationTicks:10000001}],[{...marks[0],id:22}],[marks[1],marks[0]],Array(4097).fill(marks[0])])expect(speechVisemes(value,16000,16000)).toEqual([]);
    expect(speechVisemes(undefined,16000,16000)).toEqual([]);expect(speechVisemes(marks,Infinity,16000)).toEqual([]);
  });
  it("binds the actual fixture to its WAV and rejects invalid stored viseme metadata",()=>{
    expect(p.visemes).toHaveLength(28);expect(p.visemes!.at(-1)!.sample+p.visemes!.at(-1)!.duration).toBe(p.frames);expect(readSpeechPlayback(p,identity)).toBe(p);
    for(const patch of [{visemeSource:"estimated"},{visemes:[{sample:0,duration:p.frames+1,id:1}]},{visemes:[{sample:-1,duration:1,id:0}]},{visemes:[{sample:2,duration:1,id:1},{sample:1,duration:1,id:2}]}])expect(readSpeechPlayback({...p,...patch},identity)).toBeNull();
    expect(readSpeechPlayback(p,{...identity,sha256:"0".repeat(64)})).toBeNull();
  });
  it("renders only measured events inside the selected audio window with one tab stop",()=>{
    const html=renderToStaticMarkup(<VisemeStrip playback={p} currentTime={0} window={{startSample:16000,endSample:32000}} onSeek={()=>{}}/>);
    expect(html).toContain('aria-label="Speech mouth shapes"');expect(html.match(/tabindex="0"/g)).toHaveLength(1);expect(html).toContain('aria-current="true"');expect(html).not.toContain('at 2.00 seconds');
    expect(renderToStaticMarkup(<VisemeStrip playback={{...p,visemes:undefined,visemeSource:undefined}} currentTime={0} onSeek={()=>{}}/>)).toBe("");
    const fallback=renderToStaticMarkup(<WordWave playback={{...p,words:[]}} currentTime={0} onSeek={()=>{}}/>);expect(fallback).toContain('aria-label="Speech position"');expect(fallback).not.toContain(p.text);expect(fallback).not.toContain('Seek to');
  });
});
