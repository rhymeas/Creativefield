import {HttpError} from "./auth";
export const MAX_MICROPHONE_BYTES=44+96000*60*2;
export function microphoneWav(buffer:Buffer){
  const invalid=()=>{throw new HttpError(422,"Use a canonical mono PCM16 WAV recording of at most 60 seconds.");};
  if(buffer.length<46||buffer.length>MAX_MICROPHONE_BYTES)invalid();
  if(buffer.toString("ascii",0,4)!=="RIFF"||buffer.toString("ascii",8,12)!=="WAVE"||buffer.toString("ascii",12,16)!=="fmt "||buffer.toString("ascii",36,40)!=="data")invalid();
  const rate=buffer.readUInt32LE(24),bytes=buffer.readUInt32LE(40);
  if(buffer.readUInt32LE(4)!==buffer.length-8||buffer.readUInt32LE(16)!==16||buffer.readUInt16LE(20)!==1||buffer.readUInt16LE(22)!==1||buffer.readUInt16LE(32)!==2||buffer.readUInt16LE(34)!==16||rate<8000||rate>96000||buffer.readUInt32LE(28)!==rate*2||bytes!==buffer.length-44||bytes%2||bytes<2||bytes/2>rate*60)invalid();
  return {sampleRate:rate,frames:bytes/2,durationSeconds:bytes/2/rate,channels:1,bitsPerSample:16};
}
