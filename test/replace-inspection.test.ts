import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import type {ApiGraph} from "../src/workflow/build";
import {buildReplaceInspectionGraph,REPLACE_INSPECTION_OUTPUTS} from "../src/capabilities/replace-inspection";

const template=JSON.parse(readFileSync("native-workflows/scail2-character-replace/template.api.json","utf8")) as ApiGraph;
describe("saved reference preparation export",()=>{
  it.each([false,true])("keeps real image/mask sources but no sampler or video output (two people: %s)",two=>{
    const graph=structuredClone(template);graph["344"].inputs.value=two;
    const before=structuredClone(graph),result=buildReplaceInspectionGraph(graph);
    expect(graph).toEqual(before);
    expect(Object.values(result).filter(n=>n.class_type==="SaveImage")).toHaveLength(4);
    expect(Object.values(result).some(n=>/Sampler|Guider|UNETLoader|VAEDecode|SaveVideo|ToVideo/.test(n.class_type))).toBe(false);
    expect(result["inspect:reference"].inputs.images).toEqual(two?["350",0]:["213:225",0]);
    expect(result["inspect:reference-mask"].inputs.images).toEqual(two?["353",0]:["213:199",1]);
    expect(!!result["330"]).toBe(two);
    for(const node of Object.values(result))for(const value of Object.values(node.inputs)){
      if(Array.isArray(value)&&value.length===2&&typeof value[0]==="string"&&typeof value[1]==="number")expect(result[value[0]],value[0]).toBeDefined();
    }
    for(const output of REPLACE_INSPECTION_OUTPUTS.filter(o=>o.first))expect(result[output.id+":first"].inputs.length).toBe(1);
  });
  it("refuses a missing or generated reference rather than silently running diffusion",()=>{
    const absent=structuredClone(template);delete absent["213:114"].inputs.reference_image_mask;
    expect(()=>buildReplaceInspectionGraph(absent)).toThrow("did not retain");
    const generated=structuredClone(template);generated["213:114"].inputs.reference_image=["213:6",0];
    expect(()=>buildReplaceInspectionGraph(generated)).toThrow("video generation");
  });
  it("refuses an unresolved lazy branch",()=>{
    const graph=structuredClone(template);graph["344"].inputs.value="unknown";
    expect(()=>buildReplaceInspectionGraph(graph)).toThrow("could not be frozen");
  });
});
