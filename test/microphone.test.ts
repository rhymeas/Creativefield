import {afterEach,describe,expect,it,vi} from "vitest";
import {encodeMonoWav,LocalMicrophone} from "../src/team/audio/microphone";
import {microphoneWav} from "../server/microphone-wav";
afterEach(()=>vi.unstubAllGlobals());
describe("local microphone PCM contract",()=>{
  it("round trips sample count, clamps amplitudes and rejects malformed timing",async()=>{
    const result=encodeMonoWav([new Float32Array([-2,-.5,0,.5,2,NaN])],48000),bytes=Buffer.from(await result.blob.arrayBuffer());
    expect(microphoneWav(bytes)).toMatchObject({frames:6,sampleRate:48000,durationSeconds:6/48000,channels:1});
    expect(bytes.readInt16LE(44)).toBe(-32768);expect(bytes.readInt16LE(52)).toBe(32767);expect(bytes.readInt16LE(54)).toBe(0);
    const wrong=Buffer.from(bytes);wrong.writeUInt32LE(100,40);expect(()=>microphoneWav(wrong)).toThrow(/PCM16/);
    expect(()=>microphoneWav(Buffer.from("RIFF"))).toThrow(/PCM16/);
    expect(()=>encodeMonoWav([],48000)).toThrow();expect(()=>encodeMonoWav([new Float32Array(8001*60)],8000)).toThrow();
  });
  it("stops permission-request tracks if canceled before the device resolves",async()=>{
    let resolve!:(s:unknown)=>void;const stop=vi.fn();vi.stubGlobal("navigator",{mediaDevices:{getUserMedia:()=>new Promise(r=>resolve=r)}});
    const mic=new LocalMicrophone(),started=mic.start(()=>{},()=>{},()=>{});mic.stop();resolve({getTracks:()=>[{stop}]});expect(await started).toBe(false);expect(stop).toHaveBeenCalledOnce();
  });
  it("cleans every audio node, track and context after a saved take",async()=>{
    const track={stop:vi.fn(),onended:null},source={connect:vi.fn(),disconnect:vi.fn()},processor={connect:vi.fn(),disconnect:vi.fn(),onaudioprocess:null as any},gain={connect:vi.fn(),disconnect:vi.fn(),gain:{value:1}},close=vi.fn(async()=>{});
    vi.stubGlobal("navigator",{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
    vi.stubGlobal("AudioContext",class{sampleRate=48000;destination={};createMediaStreamSource(){return source;}createScriptProcessor(){return processor;}createGain(){return gain;}async resume(){}close=close;});
    const mic=new LocalMicrophone(),level=vi.fn();expect(await mic.start(level,()=>{},()=>{})).toBe(true);
    processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4096).fill(.1)}});
    const take=mic.stop(true)!;expect(take.frames).toBe(4096);expect(level).toHaveBeenCalledOnce();expect(track.stop).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();expect(processor.onaudioprocess).toBeNull();expect(source.disconnect).toHaveBeenCalledOnce();expect(gain.disconnect).toHaveBeenCalledOnce();
  });
});
