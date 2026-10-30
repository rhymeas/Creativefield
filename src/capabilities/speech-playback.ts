export type SpeechWord={sample:number;start:number;length:number};
export type SpeechViseme={sample:number;duration:number;id:number};
export type SpeechPlayback={version:1;source:"windows-speech-progress-v1";audioSha256:string;text:string;sampleRate:number;frames:number;peaks:number[];words:SpeechWord[];visemeSource?:"windows-viseme-reached-v1";visemes?:SpeechViseme[]};
export type SpeechMark={ticks:number;start:number;length:number;text:string};
export type SpeechVisemeMark={ticks:number;durationTicks:number;id:number};
/** Actual SAPI en-US events only. Invalid clocks are omitted, never stretched to fit. */
export function speechVisemes(marks:SpeechVisemeMark[]|undefined,sampleRate:number,frames:number):SpeechViseme[]{
  if(!Array.isArray(marks)||!marks.length||marks.length>4096||!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>96000||!Number.isInteger(frames)||frames<1||frames>sampleRate*60)return [];
  const result:SpeechViseme[]=[];let previousSample=-1;
  for(const mark of marks){
    if(!mark||![mark.ticks,mark.durationTicks,mark.id].every(Number.isSafeInteger)||mark.ticks<0||mark.durationTicks<=0||mark.id<0||mark.id>21||!Number.isSafeInteger(mark.ticks+mark.durationTicks)||(mark.ticks+mark.durationTicks)*sampleRate>frames*10000000)return [];
    const sample=Math.round(mark.ticks*sampleRate/10000000),end=Math.round((mark.ticks+mark.durationTicks)*sampleRate/10000000);
    if(sample<previousSample||end>frames||end<=sample)return [];
    result.push({sample,duration:end-sample,id:mark.id});previousSample=sample;
  }return result;
}
export function speechVisemeAt(visemes:SpeechViseme[],sample:number){
  if(!Number.isFinite(sample)||sample<0)return -1;let low=0,high=visemes.length-1,answer=-1;
  while(low<=high){const middle=(low+high)>>1;if(visemes[middle].sample<=sample){answer=middle;low=middle+1;}else high=middle-1;}
  return answer>=0&&sample<visemes[answer].sample+visemes[answer].duration?answer:-1;
}
function boundary(text:string,n:number){return n===0||n===text.length||!(text.charCodeAt(n)>=0xdc00&&text.charCodeAt(n)<=0xdfff&&text.charCodeAt(n-1)>=0xd800&&text.charCodeAt(n-1)<=0xdbff);}
/** Preserve actual onset order and repeated spans (e.g. “30%” spoken as two words). */
export function speechWords(text:string,marks:SpeechMark[]|undefined,sampleRate:number,frames:number):SpeechWord[]{
  if(!Array.isArray(marks)||!marks.length||marks.length>1024||!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>96000||!Number.isInteger(frames)||frames<1||frames>sampleRate*60)return [];
  const result:SpeechWord[]=[];let lastSample=-1,lastStart=-1,lastEnd=0;
  for(const mark of marks){
    if(!mark||![mark.ticks,mark.start,mark.length].every(Number.isSafeInteger)||mark.ticks<0||mark.start<0||mark.length<1||mark.start+mark.length>text.length||!boundary(text,mark.start)||!boundary(text,mark.start+mark.length)||text.slice(mark.start,mark.start+mark.length)!==mark.text)return [];
    const sample=Math.round(mark.ticks*sampleRate/10000000),previous=result.at(-1),repeat=previous?.start===mark.start&&previous.length===mark.length;
    if(sample>=frames||sample<lastSample||mark.start<lastStart||!repeat&&mark.start<lastEnd)return [];
    result.push({sample,start:mark.start,length:mark.length});lastSample=sample;lastStart=mark.start;lastEnd=mark.start+mark.length;
  }return result;
}
/** Invalid or differently bound metadata never drives a transcript highlight. */
export function readSpeechPlayback(value:unknown,identity:{sha256?:string;text?:unknown;sampleRate?:unknown;frames?:unknown}):SpeechPlayback|null{
  const p=value as SpeechPlayback;if(!p||p.version!==1||p.source!=="windows-speech-progress-v1"||!identity.sha256||p.audioSha256!==identity.sha256||!/^[a-f0-9]{64}$/.test(p.audioSha256)||typeof p.text!=="string"||!p.text.length||p.text.length>400||p.text!==identity.text||p.sampleRate!==identity.sampleRate||p.frames!==identity.frames||!Number.isInteger(p.sampleRate)||p.sampleRate<8000||p.sampleRate>96000||!Number.isInteger(p.frames)||p.frames<1||p.frames>p.sampleRate*60||!Array.isArray(p.peaks)||p.peaks.length<16||p.peaks.length>128||p.peaks.some(n=>!Number.isFinite(n)||n<0||n>1)||!Array.isArray(p.words)||p.words.length>1024)return null;
  if(p.visemes!==undefined){
    if(p.visemeSource!=="windows-viseme-reached-v1"||!Array.isArray(p.visemes)||p.visemes.length>4096)return null;
    let previous=-1;for(const v of p.visemes){if(!v||![v.sample,v.duration,v.id].every(Number.isSafeInteger)||v.sample<0||v.sample<previous||v.duration<=0||v.sample+v.duration>p.frames||v.id<0||v.id>21)return null;previous=v.sample;}
  }else if(p.visemeSource!==undefined)return null;
  let lastSample=-1,lastStart=-1,lastEnd=0,previous:SpeechWord|undefined;
  for(const word of p.words){if(!word||![word.sample,word.start,word.length].every(Number.isSafeInteger)||word.sample<0||word.sample>=p.frames||word.sample<lastSample||word.start<0||word.start<lastStart||word.length<1||word.start+word.length>p.text.length||!boundary(p.text,word.start)||!boundary(p.text,word.start+word.length))return null;const repeat=previous?.start===word.start&&previous.length===word.length;if(!repeat&&word.start<lastEnd)return null;lastSample=word.sample;lastStart=word.start;lastEnd=word.start+word.length;previous=word;}return p;
}
export function speechWordAt(words:SpeechWord[],sample:number){if(!Number.isFinite(sample)||sample<0)return -1;let left=0,right=words.length-1,answer=-1;while(left<=right){const mid=(left+right)>>1;if(words[mid].sample<=sample){answer=mid;left=mid+1;}else right=mid-1;}return answer;}
/** Text is not duplicated when the engine expands one source span into several spoken words. */
export function speechSegments(text:string,words:SpeechWord[]){const result:{text:string;start:number;length:number;sample?:number}[]=[];let end=0;for(const word of words){if(word.start<end)continue;if(word.start>end)result.push({text:text.slice(end,word.start),start:end,length:word.start-end});result.push({text:text.slice(word.start,word.start+word.length),start:word.start,length:word.length,sample:word.sample});end=word.start+word.length;}if(end<text.length)result.push({text:text.slice(end),start:end,length:text.length-end});return result;}
