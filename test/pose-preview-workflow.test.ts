import {describe,it,expect} from "vitest";
import {randomUUID} from "node:crypto";
import {posePreviewWorkflow} from "../server/pose-preview-workflow";
import {validateCapability} from "../src/capabilities/validate";
import {compileLocal} from "../src/capabilities/compile";
import {posePreviewOutputMetadata} from "../server/pose-preview-admission";
import type {Invocation} from "../src/capabilities/types";
import fixture from "../src/ds/fixtures/pose-preview.json";
import {sdkSupportsManifest} from "../server/sdk-client";

describe("pinned one-run SDPose preview workflow",()=>{
  it("compiles exactly the measured sample count without repeating short clips",()=>{
    for(let count=1;count<=6;count++){const bundle=posePreviewWorkflow(count);expect(validateCapability(bundle)).toEqual([]);const graph=compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:Object.fromEntries(bundle.manifest.inputs.map((port,i)=>[port.id,`comfyfield-frame-${i}.png`])),controls:{},audioPolicy:"mute"});expect(Object.keys(graph.batch.inputs)).toHaveLength(count);expect(graph.load_0.inputs.image).toBe("comfyfield-frame-0.png");expect(bundle.manifest.imageArtifacts!.artifacts[0].cardinality).toEqual({min:count,max:count});}
    for(const bad of [0,7,NaN,1.5])expect(()=>posePreviewWorkflow(bad)).toThrow();
  });
  it("rejects changed extractor bindings and output cardinality",()=>{
    const isolated=structuredClone(posePreviewWorkflow(1).manifest);isolated.imageArtifacts=undefined;expect(sdkSupportsManifest(isolated)).toBe(false);
    const source=posePreviewWorkflow(2);for(const mutate of [(b:typeof source)=>{b.template!.extract.inputs.model=["load_0",0];},(b:typeof source)=>{b.template!.keypoints.inputs.source=["draw",0];},(b:typeof source)=>{b.manifest.imageArtifacts!.artifacts[0].cardinality.max=3;},(b:typeof source)=>{b.template!.batch.inputs["images.image0"]=["load_1",0];}]){const b=structuredClone(source);mutate(b);expect(validateCapability(b).length).toBeGreaterThan(0);}
  });
  it("binds numeric output to exact source/frame identity and rejects absent or wrong geometry",()=>{
    const bundle=posePreviewWorkflow(1),invocation:Invocation={capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",controls:{},audioPolicy:"mute",inputs:{frame_0:randomUUID()},posePreviewSnapshot:{validationVersion:1,previewId:randomUUID(),sourceAssetId:randomUUID(),sourceSha256:"a".repeat(64),normalizedSha256:"b".repeat(64),width:704,height:1280,fps:24,frames:[]}};
    invocation.posePreviewSnapshot!.frames=[{inputPort:"frame_0",assetId:invocation.inputs.frame_0,sha256:"c".repeat(64),frameIndex:0,seconds:0}];const pose=fixture.frames[0].pose,output=posePreviewOutputMetadata(bundle.manifest,invocation,{keypoints:{text:[JSON.stringify([pose])]}})!;
    expect(output[0]).toMatchObject({sourceAssetId:invocation.posePreviewSnapshot!.sourceAssetId,frameAssetId:invocation.inputs.frame_0,frameIndex:0,seconds:0,fps:24,pose});
    for(const value of [{},{keypoints:{text:["not JSON"]}},{keypoints:{text:[JSON.stringify([])]}},{keypoints:{text:[JSON.stringify([{...pose,canvas_width:512}])]}}])expect(()=>posePreviewOutputMetadata(bundle.manifest,invocation,value)).toThrow();
  });
});
