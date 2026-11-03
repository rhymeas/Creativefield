import {describe,expect,it} from "vitest";
import {PICTURE_PROMPT,REMOVE_PROMPT,UNREADABLE,editPlanProblems,heuristicEditPlan,nounPhrase,trackable} from "../src/workflow/edit-plan";
import {acceptModelEditPlan} from "../server/edit-plan";

// One sentence the user writes on Create Video, read into what SAM 3.1 tracks and what VACE paints there.
const SENTENCES:[string,number,{target:string;prompt:string;reference?:number}][]=[
  ["make his jacket red",0,{target:"jacket",prompt:"A red jacket."}],
  ["replace the mug with @Image 1",2,{target:"mug",prompt:PICTURE_PROMPT,reference:1}],
  ["remove the car in the back",0,{target:"car",prompt:REMOVE_PROMPT}],
  ["put sunglasses on her",0,{target:"sunglasses",prompt:"Sunglasses on her."}],
  ["make the mug blue",0,{target:"mug",prompt:"A blue mug."}],
  ["turn the shirt green",0,{target:"shirt",prompt:"A green shirt."}],
  ["change the wall to dark blue",0,{target:"wall",prompt:"A dark blue wall."}],
  ["make his jacket orange",0,{target:"jacket",prompt:"An orange jacket."}],
  ["remove the person on the left",0,{target:"person",prompt:REMOVE_PROMPT}],
  ["make @Image 2 the jacket",2,{target:"jacket",prompt:PICTURE_PROMPT,reference:2}],
  ["put sunglasses on her face",0,{target:"face",prompt:"Sunglasses on her face."}],
  ["make the car in the back red",0,{target:"car",prompt:"A red car."}],
  ["add a gold chain to his neck",0,{target:"neck",prompt:"Gold chain on his neck."}],
  ["make the red car blue",0,{target:"red car",prompt:"A blue car."}],
  ["replace the mug with a red one",0,{target:"mug",prompt:"A red mug."}],
];

describe("reading one edit sentence",()=>{
  it("finds the thing SAM tracks and words for what it becomes",()=>{
    for(const [said,images,plan] of SENTENCES){
      expect({said,...heuristicEditPlan(said,images)}).toEqual({said,target:plan.target,prompt:plan.prompt,problems:[],...(plan.reference?{reference:plan.reference}:{})});
    }
  });
  it("uses an @Image only when the screen has that picture",()=>{
    expect(heuristicEditPlan("replace the mug with @Image 3",2)).toMatchObject({problems:["There is no @Image 3 here."]});
    expect(heuristicEditPlan("replace the mug with @Image 1",0)).toMatchObject({problems:["Add a picture first, then say @Image 1."]});
    expect(heuristicEditPlan("make @Image 1 the jacket",3)).toMatchObject({target:"jacket",reference:1});
  });
  it("says what to write instead of guessing",()=>{
    expect(heuristicEditPlan("",0)).toMatchObject({target:"",prompt:"",problems:[UNREADABLE]});
    expect(heuristicEditPlan("asdf qwerty",0)).toMatchObject({problems:[UNREADABLE]});
    expect(heuristicEditPlan("make it red",0)).toMatchObject({problems:[UNREADABLE]});
    expect(heuristicEditPlan("remove the car",0).prompt).toBe(REMOVE_PROMPT);
  });
  it("keeps the target a short noun phrase and at least two letters",()=>{
    expect(nounPhrase("his jacket")).toBe("jacket");
    expect(nounPhrase("the car in the back")).toBe("car");
    expect(nounPhrase("the mug")).toBe("mug");
    expect(trackable("jacket")).toBe(true);
    expect(trackable("a")).toBe(false);
    expect(trackable("it")).toBe(false);
  });
});

describe("a text model's read is held to the same shape",()=>{
  it("accepts a plan that uses only this screen's pictures",()=>{
    const answer='Sure! ```json\n{"target":"jacket","prompt":"A red leather jacket.","reference":1}\n```';
    expect(acceptModelEditPlan(answer,2)).toEqual({target:"jacket",prompt:"A red leather jacket.",reference:1});
  });
  it("refuses an untrackable target, an unknown picture or something that is not JSON",()=>{
    expect(acceptModelEditPlan('{"target":"it","prompt":"A red one."}',2)).toBeNull();
    expect(acceptModelEditPlan('{"target":"jacket","prompt":"A red jacket.","reference":3}',2)).toBeNull();
    expect(acceptModelEditPlan("I cannot help with that.",2)).toBeNull();
    expect(acceptModelEditPlan('{"target":"jacket","prompt":"A red jacket.","face":"@Image 1"}',2)).toBeNull();
  });
  it("names the problem a plan would cause in plain words",()=>{
    expect(editPlanProblems({target:"jacket",prompt:"A red jacket."},0)).toEqual([]);
    expect(editPlanProblems({target:"jacket",prompt:"A red jacket.",reference:2},1)).toEqual(["There is no @Image 2 here."]);
    expect(editPlanProblems({target:"",prompt:""},0)).toEqual([UNREADABLE]);
  });
});
