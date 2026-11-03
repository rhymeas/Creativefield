import {describe,expect,it} from "vitest";
import {buildReplaceSteps,personIndexFor,withIndexes,freePerson,personChoices,personLabel,placeFace,removeFace,realWords,requireReferenceLooks,type PlannedPerson} from "../src/team/reference-replace";
import {characterPortrait} from "../src/team/ReferenceReplacePanel";
import type {CharacterReference,CharacterRecord} from "../src/team/api";
import type {ReferencePlan} from "../src/workflow/reference-prompt";

const plan:ReferencePlan={video:"@Video 1",people:[
  {target:"person on the left",face:"@Image 1",faceEdit:"slightly slimmer, good jawline",outfit:"gold chains and a track jacket"},
  {target:"person on the right",face:"@Image 2",outfit:"gold chains and a track jacket"},
],keep:"keep the movement"};
const media={"@Video 1":"vid","@Image 1":"face1","@Image 2":"face2"};
/** The words the local vision model wrote for the two pictures. */
const looks={"@Image 1":"short dark hair, a moustache and a navy shirt","@Image 2":"a beard, glasses and a grey long-sleeve shirt"};
const one:ReferencePlan={video:"@Video 1",people:[plan.people[0]],keep:"keep the movement"};

describe("character replace chain",()=>{
  it("uses a model-readable visual reference instruction when descriptions are unavailable",()=>{
    const plan={video:"@Video 1",people:[{target:"person on the left",face:"@Image 1"}]};
    const result=buildReplaceSteps(plan as never,[{target:"person on the left",face:"@Image 1",index:0}] as never,{"@Video 1":"video","@Image 1":"image"});
    expect(result.steps[0].controls.prompt).toContain("character shown in the reference image");
    expect(result.steps[0].controls.prompt).not.toContain("@Image 1");
  });
  it("stops before replacement when one reference could not be read instead of silently changing routes",()=>{
    expect(()=>requireReferenceLooks(["@Image 1","@Image 2"],looks)).not.toThrow();
    expect(()=>requireReferenceLooks(["@Image 1","@Image 2"],{"@Image 1":looks["@Image 1"],"@Image 2":"...."})).toThrow("Could not read @Image 2");
    expect(()=>requireReferenceLooks(["@Image 1"],{})).toThrow("No replacement was started");
  });
  it("maps spatial targets to left-to-right indexes",()=>{
    expect(personIndexFor("person on the left",1,2)).toBe(0);
    expect(personIndexFor("person on the right",0,2)).toBe(1);
    expect(personIndexFor("third person from the left",0,3)).toBe(2);
    expect(personIndexFor("the drummer",1,2)).toBe(1);
  });
  it("prepares each character, then replaces one person on their own",()=>{
    const {steps,missing}=buildReplaceSteps(one,withIndexes(one),media);
    expect(missing).toEqual([]);
    expect(steps.map(s=>[s.id,s.capabilityId])).toEqual([["prepare-0","flux2-klein-edit"],["replace-0","scail2-character-replace"]]);
    expect(steps[0].controls.prompt).toMatch(/slightly slimmer.*gold chains/);
    expect(steps[1].inputs).toEqual({source_video:{asset:"vid"},character_image:{step:"prepare-0"}});
    expect(steps[1].controls).toEqual({person:"0",prompt:expect.stringContaining("Replace the person on the left with the character shown in the reference image")});
  });
  it("replaces two faces in ONE pass with both pictures once both have been read",()=>{
    const {steps,missing}=buildReplaceSteps(plan,withIndexes(plan),media,undefined,looks);
    expect(missing).toEqual([]);
    // Each picture is prepared for its own person, then one pass carries both.
    expect(steps.map(s=>[s.id,s.capabilityId])).toEqual([
      ["prepare-0","flux2-klein-edit"],["prepare-1","flux2-klein-edit"],["replace-both","scail2-character-replace"],
    ]);
    const both=steps[2];
    expect(both.inputs).toEqual({source_video:{asset:"vid"},character_image:{step:"prepare-0"},character_image_2:{step:"prepare-1"}});
    expect(both.controls.person).toBe("0,1");
    expect(both.controls.two_people).toBe(true);
    expect(both.label).toBe("Replace person on the left and person on the right");
  });
  it("keeps the chained passes until both pictures have been read",()=>{
    // The instruction sentence alone put the second picture on the FIRST person (prompt 04d5fdcc),
    // so an unread picture never takes the one-pass route.
    const {steps}=buildReplaceSteps(plan,withIndexes(plan),media,undefined,{"@Image 1":looks["@Image 1"]});
    expect(steps.map(s=>s.id)).toEqual(["prepare-0","replace-0","prepare-1","replace-1"]);
    expect(steps[1].inputs.character_image).toEqual({step:"prepare-0"});
    expect(steps[3].inputs.source_video).toEqual({step:"replace-0"});
    expect(steps[3].controls.person).toBe("1");
  });
  it("puts the leftmost person's picture first, whatever order the faces were named in",()=>{
    const swapped:ReferencePlan={video:"@Video 1",people:[
      {target:"person on the right",face:"@Image 1"},
      {target:"person on the left",face:"@Image 2"},
    ]};
    const {steps}=buildReplaceSteps(swapped,withIndexes(swapped),media,undefined,{"@Image 1":looks["@Image 1"],"@Image 2":looks["@Image 2"]});
    const both=steps[0];
    expect(both.id).toBe("replace-both");
    expect(both.controls.person).toBe("0,1");
    // @Image 2 is the left person, so it is the first colour and the first picture.
    expect(both.inputs).toEqual({source_video:{asset:"vid"},character_image:{asset:"face2"},character_image_2:{asset:"face1"}});
  });
  it("describes how each person looks when the pictures have been read",()=>{
    const {steps}=buildReplaceSteps(plan,withIndexes(plan),media,undefined,looks);
    const prompt=steps[2].controls.prompt as string;
    expect(prompt).toBe("Two people. The person on the left has short dark hair, a moustache and a navy shirt and wears gold chains and a track jacket. "
      +"The person on the right has a beard, glasses and a grey long-sleeve shirt and wears gold chains and a track jacket. "
      +"Keep the source video's full frame, camera, background and motion. Keep the movement.");
    expect(prompt).not.toMatch(/becomes @Image/);
  });
  it("describes one person too, which is what lands their picture",()=>{
    const {steps}=buildReplaceSteps(one,withIndexes(one),media,"in a plain grey studio",{"@Image 1":"a moustache and a navy jacket"});
    expect(steps[1].controls.prompt).toBe("One person. The person on the left has a moustache and a navy jacket and wears gold chains and a track jacket. "
      +"In a plain grey studio. Keep the source video's full frame, camera, background and motion. Keep the movement.");
    expect(steps[1].controls.person).toBe("0");
  });
  it("names missing media instead of building a partial chain",()=>{
    expect(buildReplaceSteps(plan,withIndexes(plan),{"@Video 1":"vid"})).toEqual({steps:[],missing:["@Image 1","@Image 2"]});
  });
  it("names the target person so the reference face lands on the right one",()=>{
    const {steps}=buildReplaceSteps(one,withIndexes(one),media);
    expect(steps[1].controls.prompt).toContain("Replace the person on the left with the character shown in the reference image");
    expect(steps[1].controls.prompt).toContain("Keep every other person unchanged");
  });
  it("carries the request's scene words into the replacement prompt without @ references",()=>{
    const request="Replace the people in @Video 1 with @Image 1 and @Image 2 in a plain grey studio.";
    const {steps}=buildReplaceSteps(plan,withIndexes(plan),media,request,looks);
    const replace=steps[2].controls.prompt as string;
    expect(replace).toContain("plain grey studio");
    expect(replace).not.toContain("@Video 1");
    expect(replace).toMatch(/full frame/i);
    expect(replace).toContain("Keep the movement.");
    expect(replace).not.toMatch(/keep keep/i);
  });
  it("drops a replace sentence that named only a reference, so no person is replaced with nothing",()=>{
    const request="Replace the 1st person from the left with @Image 1. Replace the 2nd person from the left with @Image 2.";
    const {steps}=buildReplaceSteps(plan,withIndexes(plan),media,request,looks);
    const replace=steps[2].controls.prompt as string;
    expect(replace).not.toMatch(/replace/i);
    expect(replace).not.toMatch(/with\s*[.,;]/);
    expect(replace).toContain("The person on the left has short dark hair");
    expect(replace).toMatch(/full frame/i);
  });
  it("keeps the scene words of a sentence that also named a reference",()=>{
    const {steps}=buildReplaceSteps(one,withIndexes(one),media,"Replace the left man with @Image 1 in a park at sunset.");
    expect(steps[1].controls.prompt).toContain("in a park at sunset.");
  });
  it("chains one pass per person when three people change, because a pass carries two",()=>{
    const three:ReferencePlan={video:"@Video 1",people:[
      {target:"person on the left",face:"@Image 1"},{target:"third person from the left",face:"@Image 2"},{target:"person on the right",face:"@Image 1"},
    ]};
    const {steps}=buildReplaceSteps(three,withIndexes(three),media);
    expect(steps.map(s=>s.id)).toEqual(["replace-0","replace-1","replace-2"]);
    expect(steps[1].inputs.source_video).toEqual({step:"replace-0"});
    expect(steps.every(s=>s.controls.two_people===undefined)).toBe(true);
  });
  it("dresses a person from their clothes picture before the replacement",()=>{
    const people:PlannedPerson[]=withIndexes(one).map((p,i)=>i===0?{...p,clothes:"shirt"}:p);
    const {steps,missing}=buildReplaceSteps(one,people,media);
    expect(missing).toEqual([]);
    expect(steps.map(s=>s.id)).toEqual(["prepare-0","dress-0","replace-0"]);
    const dress=steps[1];
    expect(dress.capabilityId).toBe("fibo2-edit");
    expect(dress.inputs).toEqual({source_image:{step:"prepare-0"},reference_image:{asset:"shirt"}});
    expect(dress.controls.prompt).toMatch(/clothes or product from the reference picture/);
    expect(steps[2].inputs.character_image).toEqual({step:"dress-0"});
  });
  it("dresses both pictures before the one pass that replaces both people",()=>{
    const people:PlannedPerson[]=withIndexes(plan).map(p=>({...p,clothes:"shirt",faceEdit:undefined,outfit:undefined}));
    const {steps}=buildReplaceSteps(plan,people,media,undefined,looks);
    expect(steps.map(s=>s.id)).toEqual(["dress-0","dress-1","replace-both"]);
    expect(steps[2].inputs).toEqual({source_video:{asset:"vid"},character_image:{step:"dress-0"},character_image_2:{step:"dress-1"}});
  });
  it("dresses straight from the face picture when nothing else changes",()=>{
    const plain:ReferencePlan={video:"@Video 1",people:[{target:"person on the left",face:"@Image 1"}]};
    const people:PlannedPerson[]=withIndexes(plain).map(p=>({...p,clothes:"shirt"}));
    const {steps}=buildReplaceSteps(plain,people,media);
    expect(steps.map(s=>s.id)).toEqual(["dress-0","replace-0"]);
    expect(steps[0].inputs.source_image).toEqual({asset:"face1"});
    expect(steps[1].inputs.character_image).toEqual({step:"dress-0"});
  });
  it("keeps the chain unchanged for a person without a clothes picture",()=>{
    const {steps}=buildReplaceSteps(one,withIndexes(one),media);
    expect(steps.some(s=>s.id.startsWith("dress-"))).toBe(false);
  });
  it("reads only words, so a placeholder from the plan never becomes a step or a prompt",()=>{
    // The local text model answered with "faceEdit": "..." and "outfit": "....", the panel sent
    // "Face: ...; Wearing ...." to the preparation step, and the preparation made a generic person out of
    // both pictures (runs 389f5d60 and 0b04a736). A placeholder is not a change.
    const placeholders:ReferencePlan={video:"@Video 1",people:[
      {target:"person on the left",face:"@Image 1",faceEdit:"...",outfit:"...."},
      {target:"person on the right",face:"@Image 2",faceEdit:"…",outfit:"n/a"},
    ]};
    expect(realWords("...")).toBeUndefined();
    expect(realWords("…")).toBeUndefined();
    expect(realWords("n/a")).toBeUndefined();
    expect(realWords("  red jacket ")).toBe("red jacket");
    const {steps}=buildReplaceSteps(placeholders,withIndexes(placeholders),media,undefined,looks);
    expect(steps.map(s=>s.id)).toEqual(["replace-both"]);
    expect(steps[0].controls.prompt).toBe("Two people. The person on the left has short dark hair, a moustache and a navy shirt. "
      +"The person on the right has a beard, glasses and a grey long-sleeve shirt. "
      +"Keep the source video's full frame, camera, background and motion.");
    expect(steps[0].controls.prompt).not.toContain("wears");
  });
  it("does not describe a pass from a look that is only a placeholder",()=>{
    const plain:ReferencePlan={video:"@Video 1",people:[{target:"person on the left",face:"@Image 1"},{target:"person on the right",face:"@Image 2"}]};
    const {steps}=buildReplaceSteps(plain,withIndexes(plain),media,undefined,{"@Image 1":"...","@Image 2":"...."});
    // No words for the pictures, so the chained passes stay: the one-pass route needs a reading of both.
    expect(steps.map(s=>s.id)).toEqual(["replace-0","replace-1"]);
    expect(steps[0].controls.prompt).toContain("Replace the person on the left with the character shown in the reference image");
  });
});

const face=(asset:string,index:number)=>({asset,index});

describe("which person a face replaces",()=>{
  it("says where a face goes in words",()=>{
    expect(personLabel(0)).toBe("1st person from the left");
    expect(personLabel(2)).toBe("3rd person from the left");
    expect(personChoices().map(c=>c.label)).toEqual(["1st person from the left","2nd person from the left","3rd person from the left","4th person from the left"]);
  });
  it("puts an added face on the first free person, so faces go left to right",()=>{
    expect(freePerson([])).toBe(0);
    expect(freePerson([face("a",0)])).toBe(1);
    expect(freePerson([face("a",2)])).toBe(0);
    expect(freePerson([face("a",0),face("b",1),face("c",2)])).toBe(3);
  });
  it("removes a face and renumbers the rest left to right",()=>{
    expect(removeFace([face("a",0),face("b",1),face("c",2)],1)).toEqual([face("a",0),face("c",1)]);
    expect(removeFace([face("a",0),face("b",1),face("c",2)],0)).toEqual([face("b",0),face("c",1)]);
  });
  it("keeps the person of a face put on a later one on purpose",()=>{
    expect(removeFace([face("a",0),face("c",2)],0)).toEqual([face("c",2)]);
  });
  it("moves a face to another person by swapping, so no two faces share one",()=>{
    expect(placeFace([face("a",0),face("b",1)],0,1)).toEqual([face("a",1),face("b",0)]);
    expect(placeFace([face("a",0),face("b",1)],1,3)).toEqual([face("a",0),face("b",3)]);
    expect(placeFace([face("a",0),face("b",1)],1,4)).toEqual([face("a",0),face("b",1)]);
  });
});
const reference=(ordinal:number,assetId:string,extra:Partial<CharacterReference>={}):CharacterReference=>(
  {ordinal,assetId,assetProjectId:"project-a",assetSha256:"a".repeat(64),assetMediaType:"image",assetContentType:"image/png",assetBytes:12,assetMetadata:{},...extra});
const savedCharacter:CharacterRecord={id:"character-a",projectId:"project-a",elementId:"element-a",name:"Ari",description:"",createdAt:"2026-10-16T00:00:00.000Z",
  referencePack:{version:1,references:[reference(1,"asset-second"),reference(0,"asset-portrait")]}};

describe("a saved character in Replace character",()=>{
  it("offers the first reference as the face, whatever the pack order is",()=>{
    expect(characterPortrait(savedCharacter,"project-a")).toBe("asset-portrait");
    expect(characterPortrait({...savedCharacter,referencePack:{version:1,references:[reference(0,"asset-portrait",{assetProjectId:null})]}},"project-a")).toBe("asset-portrait");
  });
  it("offers no face when the pack cannot give this project one image",()=>{
    expect(characterPortrait({...savedCharacter,referencePack:{version:1,references:[]}},"project-a")).toBeUndefined();
    expect(characterPortrait({...savedCharacter,elementId:""},"project-a")).toBeUndefined();
    expect(characterPortrait({...savedCharacter,referencePack:{version:1,references:[reference(0,"asset-other",{assetProjectId:"project-b"})]}},"project-a")).toBeUndefined();
    expect(characterPortrait({...savedCharacter,referencePack:{version:1,references:[reference(0,"asset-video",{assetMediaType:"video"})]}},"project-a")).toBeUndefined();
    expect(characterPortrait({...savedCharacter,referencePack:{version:1,references:[reference(2,"asset-portrait")]}},"project-a")).toBeUndefined();
  });
});
