import {describe,expect,it} from "vitest";
import {readdirSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {effectGuide,effectPromptCopy,type EffectGuide} from "../src/team/effect-guides";

const pack=(id:string,file:string)=>JSON.parse(readFileSync(join("native-workflows",id,file),"utf8"));

/** A restyle graph that stops at the 81-frame head carries an ImageFromBatch cap. */
const capsAt81=(id:string)=>Object.values(pack(id,"template.api.json") as Record<string,{class_type:string;inputs:Record<string,unknown>}>).some(node=>node.class_type==="ImageFromBatch"&&Number(node.inputs.length)===81);

/** The effects the workspace can actually run: finishing workflows with a local video route. */
const effectIds=readdirSync("native-workflows").filter(name=>{
  try{const manifest=pack(name,"manifest.json");return manifest.category==="finishing"&&manifest.coverage?.local==="implemented"&&manifest.outputs?.some((output:{type:string})=>output.type==="video");}catch{return false;}
});

const guides=(ids:string[])=>ids.map(id=>[id,effectGuide(id)] as [string,EffectGuide|undefined]);

describe("effect guides",()=>{
  it("explains every effect the workspace can run",()=>{
    expect(effectIds.length).toBeGreaterThan(0);
    expect(guides(effectIds).filter(([,guide])=>!guide)).toEqual([]);
  });

  it("keeps each guide to a short summary and three plain steps",()=>{
    for(const [id,guide] of guides(effectIds)){
      expect(guide!.summary.endsWith("."),`${id} summary`).toBe(true);
      expect(guide!.summary.split(" ").length,`${id} summary length`).toBeLessThan(16);
      expect(guide!.steps.length,`${id} steps`).toBe(3);
      for(const step of guide!.steps){
        expect(step.title.trim(),`${id} step title`).not.toBe("");
        expect(step.text.trim(),`${id} step text`).not.toBe("");
        expect(step.title.split(" ").length,`${id} step title length`).toBeLessThan(6);
        expect(step.text.split(" ").length,`${id} step text length`).toBeLessThan(25);
      }
    }
  });

  it("states the clip limit only where the graph stops at 81 frames",()=>{
    for(const [id,guide] of guides(effectIds)){
      expect(Boolean(guide!.clipHint),`${id} clip hint`).toBe(capsAt81(id));
    }
    expect(effectGuide("vace-canny-restyle")!.clipHint).toBe("Drop a video, up to 5 s");
    expect(effectGuide("vace-depth-restyle")!.clipHint).toBeUndefined();
  });

  it("asks for the new look on effect screens only",()=>{
    expect(effectPromptCopy(effectGuide("vace-canny-restyle"))).toEqual({label:"Describe the new look",placeholder:"Say the new look, for example a watercolor painting"});
    expect(effectPromptCopy(effectGuide("vace-reference-restyle"))?.label).toBe("Describe the new look");
    expect(effectPromptCopy(undefined)).toBeUndefined();
    expect(effectGuide("wan22-i2v-14b")).toBeUndefined();
  });
});
