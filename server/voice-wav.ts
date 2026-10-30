import {HttpError} from "./auth";
export const MAX_VOICE_WAV_BYTES=44+96000*60*2+65536;
/** Bounded PCM parser: accepts recorder WAV and ordinary RIFF metadata chunks. */
export function voiceWav(buffer:Buffer){
  const invalid=():never=>{throw new HttpError(422,"Use a saved microphone take or mono PCM16 WAV of at most 60 seconds.");};
  if(buffer.length<46||buffer.length>MAX_VOICE_WAV_BYTES||buffer.toString("ascii",0,4)!=="RIFF"||buffer.toString("ascii",8,12)!=="WAVE"||buffer.readUInt32LE(4)!==buffer.length-8)invalid();
  let rate=0,dataBytes=-1,offset=12,chunks=0,format=false;
  while(offset<buffer.length){
    if(++chunks>64||offset+8>buffer.length)invalid();
    const id=buffer.toString("ascii",offset,offset+4),size=buffer.readUInt32LE(offset+4),start=offset+8,end=start+size;
    if(end>buffer.length)invalid();
    if(id==="fmt "){
      if(format||size<16||size>40)invalid();format=true;rate=buffer.readUInt32LE(start+4);
      if(buffer.readUInt16LE(start)!==1||buffer.readUInt16LE(start+2)!==1||buffer.readUInt16LE(start+12)!==2||buffer.readUInt16LE(start+14)!==16||rate<8000||rate>96000||buffer.readUInt32LE(start+8)!==rate*2)invalid();
    }else if(id==="data"){if(dataBytes>=0)invalid();dataBytes=size;}
    offset=end+(size%2);if(offset>buffer.length)invalid();
  }
  if(!format||dataBytes<2||dataBytes%2||dataBytes>rate*60*2)invalid();
  return {sampleRate:rate,frames:dataBytes/2,durationSeconds:dataBytes/2/rate,channels:1,bitsPerSample:16};
}
