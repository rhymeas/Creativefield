export const MAX_RECORDING_SECONDS=60;
export function encodeMonoWav(chunks:Float32Array[],sampleRate:number){
  const frames=chunks.reduce((n,c)=>n+c.length,0);
  if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>96000||frames<1||frames>sampleRate*MAX_RECORDING_SECONDS)throw new Error("Record between one sample and 60 seconds of audio.");
  const buffer=new ArrayBuffer(44+frames*2),view=new DataView(buffer);
  const ascii=(offset:number,s:string)=>{for(let i=0;i<s.length;i++)view.setUint8(offset+i,s.charCodeAt(i));};
  ascii(0,"RIFF");view.setUint32(4,36+frames*2,true);ascii(8,"WAVE");ascii(12,"fmt ");view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(36,"data");view.setUint32(40,frames*2,true);
  let at=44;for(const chunk of chunks)for(const sample of chunk){const value=Math.max(-1,Math.min(1,Number.isFinite(sample)?sample:0));view.setInt16(at,Math.round(value*(value<0?32768:32767)),true);at+=2;}
  return {blob:new Blob([buffer],{type:"audio/wav"}),frames,sampleRate,durationSeconds:frames/sampleRate};
}

/** One consented local capture. stop() also invalidates pending permission requests. */
export class LocalMicrophone {
  private epoch=0;private stream:MediaStream|null=null;private context:AudioContext|null=null;private source:MediaStreamAudioSourceNode|null=null;private processor:ScriptProcessorNode|null=null;private silent:GainNode|null=null;
  private chunks:Float32Array[]=[];private frames=0;private rate=0;private timer:ReturnType<typeof setTimeout>|undefined;
  async start(onLevel:(level:number,seconds:number)=>void,onLimit:()=>void,onError:(message:string)=>void){
    this.stop();const epoch=this.epoch;
    const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
    if(epoch!==this.epoch){stream.getTracks().forEach(t=>t.stop());return false;}
    this.stream=stream;
    try{
      const context=new AudioContext();this.context=context;this.rate=context.sampleRate;
      if(this.rate<8000||this.rate>96000)throw new Error("This device's sample rate is unsupported.");
      this.source=context.createMediaStreamSource(stream);this.processor=context.createScriptProcessor(4096,1,1);this.silent=context.createGain();this.silent.gain.value=0;
      this.source.connect(this.processor);this.processor.connect(this.silent);this.silent.connect(context.destination);
      this.processor.onaudioprocess=event=>{
        if(epoch!==this.epoch)return;const available=MAX_RECORDING_SECONDS*this.rate-this.frames,input=event.inputBuffer.getChannelData(0),chunk=input.slice(0,Math.min(input.length,available));
        if(chunk.length){this.chunks.push(chunk);this.frames+=chunk.length;let sum=0;for(const n of chunk)sum+=n*n;onLevel(Math.min(1,Math.sqrt(sum/chunk.length)*4),this.frames/this.rate);}
        if(this.frames>=MAX_RECORDING_SECONDS*this.rate)onLimit();
      };
      for(const track of stream.getAudioTracks())track.onended=()=>{if(epoch===this.epoch){this.stop();onError("The microphone disconnected. Reconnect it and record another take.");}};
      await context.resume();if(epoch!==this.epoch)return false;
      this.timer=setTimeout(onLimit,MAX_RECORDING_SECONDS*1000);return true;
    }catch(error){this.stop();throw error;}
  }
  stop(keep=false){
    this.epoch++;clearTimeout(this.timer);this.timer=undefined;
    if(this.processor){this.processor.onaudioprocess=null;this.processor.disconnect();}this.source?.disconnect();this.silent?.disconnect();
    for(const t of this.stream?.getTracks()??[]){t.onended=null;t.stop();}if(this.context)void this.context.close().catch(()=>{});
    this.processor=null;this.source=null;this.silent=null;this.stream=null;this.context=null;
    const result=keep&&this.frames?encodeMonoWav(this.chunks,this.rate):null;this.chunks=[];this.frames=0;return result;
  }
}
