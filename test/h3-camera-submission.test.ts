import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {compileLocal} from "../src/capabilities/compile";
import type {CapabilityBundle} from "../src/capabilities/types";
import {defaultDraft,submissionIntent} from "../src/team/state";

describe("H3 camera prompt through the real workflow",()=>{
  for(const id of ["h3-t2v","h3-i2v","h3-flf2v"]){
    it(`keeps movement and user text in ${id}'s bound ComfyUI prompt`,()=>{
      const manifest=JSON.parse(readFileSync(`native-workflows/${id}/manifest.json`,"utf8"));
      const template=JSON.parse(readFileSync(`native-workflows/${id}/template.api.json`,"utf8"));
      const bundle={manifest,template} as CapabilityBundle;
      const prompt="Camera move: The camera slowly pans left.\n\nA red bicycle by the sea";
      const inputs=Object.fromEntries(manifest.inputs.filter((input:{required:boolean})=>input.required).map((input:{id:string})=>[input.id,`comfyfield-${input.id}.png`]));
      const intent=submissionIntent({capabilityId:manifest.id,version:manifest.version,routeId:"local",inputs,controls:{...defaultDraft(manifest).controls,prompt},audioPolicy:manifest.audioPolicies[0]},"test-intent");
      const withSound=compileLocal(bundle,{...intent,audioPolicy:defaultDraft(manifest).audioPolicy});
      const muted=compileLocal(bundle,{...intent,audioPolicy:"mute"});
      const videoNode=Object.keys(withSound).find(key=>withSound[key].class_type==="CreateVideo")!;
      expect(defaultDraft(manifest).audioPolicy).toBe("replace");
      expect(withSound[videoNode].inputs.audio).toBeDefined();
      expect(muted[videoNode].inputs.audio).toBeUndefined();
      const graph=compileLocal(bundle,intent);
      const binding=manifest.controls.find((control:{id:string})=>control.id==="prompt").binding;
      expect(graph[binding.node].inputs[binding.field]).toBe(prompt);
    });
  }
});
