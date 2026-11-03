import {describe,expect,it} from "vitest";
import {heuristicPlan,parseMentions,planProblems,referencedLabels} from "../src/workflow/reference-prompt";
import {buildReplaceSteps} from "../src/team/reference-replace";
import {acceptModelPlan,planPrompt} from "../server/reference-plan";

// The structure from the request that motivated this feature (wording kept, it is the real-world input shape).
const REQUEST="replace the faces only from @Image 1  and @Image 2  from the faces of the people in @Video 1 and make the people from @Video 1  make them wear gangster rap clothes with jewelry on and make the face from @Image 1  that is going on the person in @Video 1  make @Image 1  face slightly skinnier and less chubby witha good jawline but not very far from where it is right now just a little bit better but besides that keep the movement and everything from @Video 1  the same just replacign the faces like i said and changing the clothing";

describe("@-reference prompts",()=>{
  it("finds mentions with forgiving spelling",()=>{
    expect(parseMentions("use @Image 1, @image2, @Img 3 and @vid1").map(m=>m.label)).toEqual(["@Image 1","@Image 2","@Image 3","@Video 1"]);
    expect(referencedLabels(REQUEST)).toEqual(["@Image 1","@Image 2","@Video 1"]);
    expect(parseMentions("email me @ home or @Image0")).toEqual([]);
  });
  it("plans two face swaps, a shared outfit and one face tweak without a model",()=>{
    const plan=heuristicPlan(REQUEST)!;
    expect(plan.video).toBe("@Video 1");
    expect(plan.people.map(p=>[p.target,p.face])).toEqual([["person on the left","@Image 1"],["person on the right","@Image 2"]]);
    expect(plan.people.every(p=>/gangster rap clothes with jewelry/i.test(p.outfit??""))).toBe(true);
    expect(plan.people[0].faceEdit).toMatch(/skinnier/);
    expect(plan.people[1].faceEdit).toBeUndefined();
    expect(plan.keep).toMatch(/keep the movement/);
    expect(planProblems(plan,REQUEST)).toEqual([]);
  });
  it("accepts a model plan only when it is valid and uses the prompt's own references",()=>{
    const good='Sure! ```json\n{"video":"@Video 1","people":[{"target":"person on the left","face":"@Image 1","outfit":"gold chains"}]}\n```';
    expect(acceptModelPlan(good,REQUEST)?.people[0].face).toBe("@Image 1");
    expect(acceptModelPlan('{"video":"@Video 2","people":[{"target":"left","face":"@Image 1"}]}',REQUEST)).toBeNull();
    expect(acceptModelPlan("I cannot help with that.",REQUEST)).toBeNull();
  });
  it("rejects plans that invent references or use a video as a face",()=>{
    const plan={video:"@Video 1",people:[{target:"person on the left",face:"@Image 3"},{target:"x",face:"@Video 1"}]};
    expect(planProblems(plan,REQUEST)).toEqual(["@Image 3 is not in the prompt.","A face must be an image reference, not @Video 1."]);
    expect(heuristicPlan("make @Image 1 smile")).toBeNull();
  });
  it("reads a plain sentence about the one face on screen",()=>{
    const said="make him wear a red jacket",read=planPrompt(said,1);
    expect(read.problems).toEqual([]);
    const plan=heuristicPlan(read.prompt)!;
    expect(plan.people[0]).toMatchObject({face:"@Image 1",outfit:"a red jacket"});
    expect(planProblems(plan,read.prompt)).toEqual([]);
    // The sentence reaches the run: a preparation step for the jacket and its words in the replacement prompt.
    const {steps,missing}=buildReplaceSteps(plan,[{...plan.people[0],index:0}],{"@Video 1":"video","@Image 1":"face"},said);
    expect(missing).toEqual([]);
    expect(steps.map(s=>s.capabilityId)).toEqual(["flux2-klein-edit","scail2-character-replace"]);
    expect(steps[1].controls.prompt).toContain("wears a red jacket");
  });
  it("says why a sentence was not read instead of dropping it",()=>{
    expect(planPrompt("make him wear a red jacket",2).problems).toEqual(["Say which face to change, like @Image 1."]);
    expect(planPrompt("make him wear a red jacket").problems).toEqual(["Mention the source clip as @Video 1."]);
    expect(planPrompt("@Video 1 and @Image 1: make him smile",1).prompt).toBe("@Video 1 and @Image 1: make him smile");
    expect(planPrompt("@Image 2 make him wear red",2).prompt).toBe("@Video 1 @Image 2 make him wear red");
    expect(planPrompt("@Image 2 make him wear red",1).problems).toEqual(["There is no @Image 2 here."]);
  });
});
