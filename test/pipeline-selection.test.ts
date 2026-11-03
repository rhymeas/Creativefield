import {describe,it,expect} from "vitest";
import {providers} from "../src/pipelines/registry";
import {pipelineChoices,workflowMedia} from "../src/ui/pipeline-selection";
const manifest=(mode:string)=>providers.find(p=>p.pipeline===mode)!.manifest;
describe("catalogue selection through draft changes",()=>{
  it("never submits hidden images with an explicitly selected text workflow",()=>{
    const choices=pipelineChoices("video","t2v",true,true);expect(choices).toEqual(["t2v"]);
    const media=workflowMedia(manifest(choices[0]),{start:"draft-start",end:"draft-end",motion:"draft-drive"});
    expect(media).toEqual({file:null,endFile:null,motionFile:null,complete:true});
    // Returning to the ordinary input-driven composer still sees preserved drafts.
    expect(pipelineChoices("video",null,true,true)).toEqual(["flf2v","i2v"]);
  });
  it("keeps explicit first/last-frame selection and blocks until both images exist",()=>{
    for(const [hasStart,hasEnd] of [[false,false],[true,false],[true,true]])expect(pipelineChoices("video","flf2v",hasStart,hasEnd)).toEqual(["flf2v"]);
    expect(workflowMedia(manifest("flf2v"),{start:"start",end:null,motion:null}).complete).toBe(false);
    expect(workflowMedia(manifest("flf2v"),{start:"start",end:"end",motion:null}).complete).toBe(true);
    expect(workflowMedia(manifest("flf2v"),{start:null,end:"end",motion:null}).complete).toBe(false);
  });
  it("keeps explicit i2v while replacing a start image with an old end draft present",()=>{
    for(const hasStart of [false,true,false,true])expect(pipelineChoices("video","i2v",hasStart,true)).toEqual(["i2v"]);
    expect(workflowMedia(manifest("i2v"),{start:"replacement",end:"old-end",motion:"old-drive"})).toEqual({file:"replacement",endFile:null,motionFile:null,complete:true});
    expect(pipelineChoices("motion","i2v",true,true)).toEqual(["motion"]);
    expect(pipelineChoices("video",null,true,true)[0]).toBe("flf2v");
  });
});
