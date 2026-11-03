import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {compileLocal} from "../src/capabilities/compile";
import {APPROVED_LOCAL_CLASSES} from "../src/capabilities/policy";
import type {CapabilityBundle} from "../src/capabilities/types";
import {validateCapability} from "../src/capabilities/validate";

const root="native-workflows/previs-to-video";
const bundle={manifest:JSON.parse(readFileSync(`${root}/manifest.json`,"utf8")),template:JSON.parse(readFileSync(`${root}/template.api.json`,"utf8"))} as CapabilityBundle;
const request={capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:"comfyfield-video.mp4",character_image:"comfyfield-reference.png"},controls:{},audioPolicy:"replace" as const};

describe("previs original audio",()=>{
  it("keeps generated audio as default and admits only the reviewed core audio nodes",()=>{
    expect(validateCapability(bundle)).toEqual([]);
    for(const name of ["EmptyAudio","AudioConcat","TrimAudioDuration"])expect(APPROVED_LOCAL_CLASSES.has(name)).toBe(true);
    const graph=compileLocal(bundle,request);
    expect(graph["source-audio-enabled"].inputs.value).toBe(false);
    expect(graph["source-audio-choice"].inputs.on_false).toEqual(["2121",0]);
    expect(graph["40"].inputs.audio).toEqual(["source-audio-choice",0]);
  });
  it("pads source audio with silence and trims to generated frame count, and mute removes audio",()=>{
    const graph=compileLocal(bundle,{...request,controls:{use_original_audio:true}});
    expect(graph["source-audio-enabled"].inputs.value).toBe(true);
    expect(graph["source-audio-pad"].inputs).toEqual({audio1:["11",1],audio2:["source-audio-silence",0],direction:"after"});
    expect(graph["source-audio-duration"].inputs).toEqual({expression:"a / 24","values.a":["2131",1]});
    expect(graph["source-audio-trim"].inputs).toEqual({audio:["source-audio-pad",0],start_index:0,duration:["source-audio-duration",0]});
    const muted=compileLocal(bundle,{...request,controls:{use_original_audio:true},audioPolicy:"mute"});
    expect(muted["40"].inputs.audio).toBeUndefined();
  });
});
