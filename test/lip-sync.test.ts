import {readFileSync} from "node:fs";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {describe,it,expect} from "vitest";
import {compileLocal} from "../src/capabilities/compile";
import {validateCapability} from "../src/capabilities/validate";
import {capabilityReadiness} from "../src/capabilities/readiness";
import {defaultDraft} from "../src/team/state";
import {encodeMonoWav} from "../src/team/audio/microphone";
import {validateVoiceInput} from "../server/voice-input";
import {voiceWav} from "../server/voice-wav";
import {sdkSupportsManifest} from "../server/sdk-client";
import type {CapabilityBundle} from "../src/capabilities/types";

const bundle:CapabilityBundle={manifest:JSON.parse(readFileSync("native-workflows/wan21-infinitetalk/manifest.json","utf8")),template:JSON.parse(readFileSync("native-workflows/wan21-infinitetalk/template.api.json","utf8"))};
const invocation={capabilityId:"lip-sync",version:bundle.manifest.version,routeId:"local",inputs:{start_image:"comfyfield-portrait.png",source_audio:"comfyfield-voice.wav"},controls:{length:1.6,audio_start:.5},audioPolicy:"replace" as const};
describe("single-speaker lip sync",()=>{
  it("compiles aligned audio/video windows and preserves the saved graph",()=>{
    expect(validateCapability(bundle)).toEqual([]);const before=structuredClone(bundle.template);
    const graph=compileLocal(bundle,invocation,{allowExperimental:true});
    expect(graph["11"].inputs).toMatchObject({mode:"single_speaker",length:41});expect(graph["12"].inputs.cfg).toBe(1);expect(graph["15"].inputs).toMatchObject({start_index:.5,duration:1.64});expect(graph["14"].inputs.audio).toEqual(["15",0]);expect(bundle.template).toEqual(before);
    expect(compileLocal(bundle,{...invocation,audioPolicy:"mute"},{allowExperimental:true})["14"].inputs.audio).toBeUndefined();
    expect(defaultDraft(bundle.manifest).audioPolicy).toBe("replace");
    expect(sdkSupportsManifest(bundle.manifest)).toBe(false);
    expect(()=>compileLocal(bundle,{...invocation,controls:{length:10}},{allowExperimental:true})).toThrow(/range/);
  });
  it("does not make an experimental route ready merely because files are present",()=>{
    const r=bundle.manifest.routes[0],inventory={online:true,nodes:r.requirements.filter(q=>q.kind==="node").map(q=>q.name),models:r.requirements.filter(q=>q.kind==="model").map(q=>`${q.location}/${q.name}`),credentials:[]};
    expect(capabilityReadiness(bundle.manifest,"local",inventory).state).toBe("ready");
    const experimental=structuredClone(bundle.manifest);experimental.routes[0].implementation="experimental";expect(capabilityReadiness(experimental,"local",inventory).state).toBe("unsupported");
    const broken=structuredClone(bundle);broken.template!["10"].inputs.audio=["2",0];expect(validateCapability(broken)).toContain("Voice audio must use the same bounded window for encoding and output");
  });
  it("validates real bounded recorder WAV bytes, source identity and available window",async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),"comfyfield-voice-"));
    try{
      const file=path.join(dir,"take.wav"),buffer=Buffer.from(await encodeMonoWav([new Float32Array(16000*3)],16000).blob.arrayBuffer());await writeFile(file,buffer);const hash=createHash("sha256").update(buffer).digest("hex");
      expect(await validateVoiceInput(file,hash,.5,1.64)).toMatchObject({durationSeconds:3,sampleRate:16000,channels:1});
      const metadata=Buffer.concat([Buffer.from("JUNK"),Buffer.from([4,0,0,0]),Buffer.from("test")]),ordinary=Buffer.concat([buffer.subarray(0,36),metadata,buffer.subarray(36)]);ordinary.writeUInt32LE(ordinary.length-8,4);
      expect(voiceWav(ordinary)).toMatchObject({durationSeconds:3,channels:1});
      await expect(validateVoiceInput(file,"0".repeat(64),0,1)).rejects.toThrow(/hash/);
      await expect(validateVoiceInput(file,hash,2,2)).rejects.toThrow(/shorter/);
      await writeFile(file,Buffer.from("not a WAV"));await expect(validateVoiceInput(file,hash,0,1)).rejects.toThrow(/PCM16/);
    }finally{if(!path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep+"comfyfield-voice-"))throw new Error("Unexpected test cleanup path");await rm(dir,{recursive:true,force:true});}
  });
});
