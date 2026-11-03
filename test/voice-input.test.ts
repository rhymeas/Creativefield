import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {encodeMonoWav} from "../src/team/audio/microphone";
import {verifyVoiceInput} from "../server/voice-input";
import type {CapabilityManifestV2,Invocation} from "../src/capabilities/types";

const manifest:CapabilityManifestV2=JSON.parse(readFileSync("native-workflows/wan21-infinitetalk/manifest.json","utf8"));
const invocation:Invocation={capabilityId:manifest.id,version:manifest.version,routeId:"local",inputs:{source_audio:"take"},controls:{length:2,audio_start:1},audioPolicy:"replace"};
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(){
  const dir=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/ComfyField/voice-preflight-");directories.push(dir);
  const path=join(dir,"voice.wav"),bytes=Buffer.from(await encodeMonoWav([new Float32Array(16000*4).fill(.1)],16000).blob.arrayBuffer());await writeFile(path,bytes);
  const asset={id:"take",role:"source_audio",project_id:"project",media_type:"audio",content_type:"audio/wav",sha256:createHash("sha256").update(bytes).digest("hex"),storage_key:"voice.wav"};
  return {path,asset,file:vi.fn(async()=>path)};
}
describe("queued voice file preflight",()=>{
  it("reads the actual bound WAV and admits the compiler's selected window",async()=>{
    const f=await fixture();await expect(verifyVoiceInput(manifest,invocation,[f.asset],"project",f.file)).resolves.toBeUndefined();expect(f.file).toHaveBeenCalledTimes(1);expect(f.file).toHaveBeenCalledWith("voice.wav");
  });
  it("rejects queued-time sample mutation even when the WAV geometry is unchanged",async()=>{
    const f=await fixture(),bytes=await readFile(f.path);bytes[bytes.length-2]^=1;await writeFile(f.path,bytes);
    await expect(verifyVoiceInput(manifest,invocation,[f.asset],"project",f.file)).rejects.toThrow("source hash");
  });
  it("rejects foreign, replaced and wrongly typed inputs before reading a file",async()=>{
    const f=await fixture();
    for(const patch of [{id:"replacement"},{project_id:"foreign"},{role:"another_role"},{media_type:"video"},{content_type:"audio/mpeg"}])await expect(verifyVoiceInput(manifest,invocation,[{...f.asset,...patch}],"project",f.file)).rejects.toThrow("project and input");
    await expect(verifyVoiceInput(manifest,invocation,[],"project",f.file)).rejects.toThrow();expect(f.file).not.toHaveBeenCalled();
  });
  it("rejects short, negative and nonfinite selected windows",async()=>{
    const f=await fixture();for(const controls of [{length:2,audio_start:3},{length:2,audio_start:-1},{length:NaN,audio_start:0},{length:2,audio_start:Infinity}])await expect(verifyVoiceInput(manifest,{...invocation,controls},[f.asset],"project",f.file)).rejects.toThrow("requested window");
  });
  it("rejects malformed audio and leaves non-voice workflows untouched",async()=>{
    const f=await fixture();await writeFile(f.path,"not a wav");await expect(verifyVoiceInput(manifest,invocation,[f.asset],"project",f.file)).rejects.toThrow("PCM16");f.file.mockClear();
    await verifyVoiceInput({...manifest,voiceContract:undefined},invocation,[],"project",f.file);expect(f.file).not.toHaveBeenCalled();
  });
});
