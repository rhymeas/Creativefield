import {describe,expect,it} from "vitest";
import {heuristicPlan,namedPosition} from "../src/workflow/reference-prompt";
import {personLabel,withIndexes} from "../src/team/reference-replace";

describe("the sentence says which person a character replaces",()=>{
  it("reads the position words the panel writes into the prompt",()=>{
    for(const index of [0,1,2,3]){
      const sentence=`Replace the ${personLabel(index)} with @Image 1.`;
      const plan=heuristicPlan(`@Video 1 ${sentence}`)!;
      expect(withIndexes(plan)[0].index).toBe(index);
    }
  });
  it("puts each character on the person its own sentence names",()=>{
    const plan=heuristicPlan("@Video 1 Replace the 2nd person from the left with @Image 1. Replace the 1st person from the left with @Image 2.")!;
    expect(withIndexes(plan).map(person=>person.index)).toEqual([1,0]);
  });
  it("still maps characters left to right by mention order when the sentence names no position",()=>{
    const plan=heuristicPlan("@Video 1 Put @Image 1 and @Image 2 in the clip.")!;
    expect(withIndexes(plan).map(person=>person.index)).toEqual([0,1]);
  });
  it("understands the person on the left or the right and the middle",()=>{
    expect(namedPosition("swap the person on the right")).toBe("person on the right");
    expect(namedPosition("the person on the left")).toBe("person on the left");
    expect(namedPosition("the person in the middle")).toBe("person in the middle");
    expect(namedPosition("make it brighter")).toBeUndefined();
  });
});
