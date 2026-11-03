import {describe,expect,it} from "vitest";
import type {CapabilityManifestV2} from "../src/capabilities/types";
import type {CharacterRecord,ReusableElement} from "../src/team/api";
import {buildCastShotPayloads,normalizeCastDraft,castDraftWithScenes,reorderCast,shotPlan,toggleCastMember,storedInfluencerDraft,buildShotPayloads,characterBinding,characterBindings,characterWorkflowReady,estimateSeconds,influencerErrors,splitScript,storyboardTitle} from "../src/team/influencer/state";

const character:CharacterRecord={id:"char-1",projectId:"project",elementId:"element",name:"Mara",description:"Host",createdAt:"2026-10-17T00:00:00Z",referencePack:{version:1,references:[]}};

describe("influencer recipe state",()=>{
  it("splits a script into scenes on blank lines and collapses whitespace",()=>{
    expect(splitScript("  Hello   world. \n\n\nSecond  scene.\n")).toEqual(["Hello world.","Second scene."]);
    expect(splitScript(" \n\n ")).toEqual([]);
  });

  it("estimates speaking duration clamped between 2 and 15 seconds",()=>{
    expect(estimateSeconds("Hi")).toBe(2);
    expect(estimateSeconds(Array(25).fill("word").join(" "))).toBe(10);
    expect(estimateSeconds(Array(200).fill("word").join(" "))).toBe(15);
  });

  it("builds muted storyboard shots named with the character",()=>{
    const shots=buildShotPayloads(character,"Intro line.\n\nProduct demo.");
    expect(shots).toHaveLength(2);
    expect(shots[0].prompt).toBe("Mara: Intro line.");
    expect(shots[0].settings.audioPolicy).toBe("mute");
    expect(shots[0].settings.elementInputs).toEqual({});
    expect(shots[0].assets).toEqual([]);
  });

  it("keeps generated audio for new H3 scenes without changing other defaults",()=>{
    const manifest={id:"h3-i2v",version:"1",inputs:[],controls:[],audioPolicies:["mute","replace"]} as unknown as CapabilityManifestV2;
    expect(buildShotPayloads(character,"A scene",manifest)[0].settings.audioPolicy).toBe("replace");
    expect(buildShotPayloads(character,"A scene",{...manifest,id:"other-video"})[0].settings.audioPolicy).toBe("mute");
  });

  it("binds the character element and generation when a workflow is chosen",()=>{
    const manifest={schemaVersion:2,id:"wan-i2v",version:"1",title:"I2V",category:"i2v",description:"",inputs:[{id:"start_image",label:"Start image",type:"image",required:true}],outputs:[],controls:[{id:"prompt",label:"Prompt",type:"string"},{id:"length",label:"Length",type:"number",default:5,min:3,max:10},{id:"seed",label:"Seed",type:"integer",default:42}],presets:[],routes:[],coverage:{local:"implemented",hosted:"unsupported"},licenses:{software:"x",weights:[]},sources:[],tickets:[],audioPolicies:["mute"]} as unknown as CapabilityManifestV2;
    const element={id:"element",name:"Mara",kind:"character",description:"",created_at:"2026-10-17T00:00:00Z",asset_ids:["asset-1"],assets:[{id:"asset-1",project_id:"project",name:"mara.png",media_type:"image",content_type:"image/png",bytes:"10",created_at:"2026-10-17T00:00:00Z",parent_id:null}]} as unknown as ReusableElement;
    expect(characterBinding(manifest,element)).toEqual({portId:"start_image",portLabel:"Start image",assetId:"asset-1"});
    expect(characterBinding(manifest,undefined)).toBeNull();
    const shots=buildShotPayloads(character,"Brief intro.",manifest,element);
    expect(shots[0].durationSeconds).toBe(3);
    expect(shots[0].settings.elementInputs).toEqual({start_image:{elementId:"element",assetId:"asset-1"}});
    expect(shots[0].settings.generation).toEqual({capabilityId:"wan-i2v",version:"1",routeId:"local",controls:{seed:42}});
    const unbound=buildShotPayloads(character,"Brief intro.",manifest,undefined);
    expect(unbound[0].settings.elementInputs).toEqual({});
    expect(unbound[0].settings.generation?.capabilityId).toBe("wan-i2v");
  });

  it("fills every required character reference port and rejects unusable workflows",()=>{
    const manifest={schemaVersion:2,id:"wan-flf",version:"1",title:"FLF",category:"flf2v",description:"",inputs:[{id:"start_image",label:"Start",type:"image",required:true},{id:"end_image",label:"End",type:"image",required:true}],outputs:[],controls:[],presets:[],routes:[],coverage:{local:"implemented",hosted:"unsupported"},licenses:{software:"x",weights:[]},sources:[],tickets:[],audioPolicies:["mute"]} as unknown as CapabilityManifestV2;
    const assets=["a","b"].map(id=>({id,project_id:"project",name:`${id}.png`,media_type:"image",content_type:"image/png",bytes:"10",created_at:"2026-10-17T00:00:00Z",parent_id:null}));
    const element={id:"element",name:"Mara",kind:"character",description:"",created_at:"2026-10-17T00:00:00Z",asset_ids:["a","b"],assets} as unknown as ReusableElement;
    expect(characterBindings(manifest,element)).toEqual({start_image:{elementId:"element",assetId:"a"},end_image:{elementId:"element",assetId:"b"}});
    expect(characterBinding(manifest,element)).toEqual({portId:"start_image",portLabel:"Start",assetId:"a"});
    expect(characterWorkflowReady(manifest,element)).toBe(true);
    expect(characterWorkflowReady(manifest,{...element,assets:[assets[0]]} as ReusableElement)).toBe(false);
    expect(buildShotPayloads(character,"Scene.",manifest,element)[0].settings.elementInputs).toEqual({start_image:{elementId:"element",assetId:"a"},end_image:{elementId:"element",assetId:"b"}});
  });

  it("requires an existing character and at least one scene, never a title",()=>{
    expect(influencerErrors({characterId:"",title:"",script:""},[character])).toEqual(["Choose an existing character.","Write at least one scene. Separate scenes with a blank line."]);
    expect(influencerErrors({characterId:character.id,title:"",script:"Scene."},[character])).toEqual([]);
    expect(influencerErrors({characterId:character.id,title:"",script:Array(21).fill("Scene.").join("\n\n")},[character])).toContain("At most 20 scenes per storyboard.");
    expect(storyboardTitle(character)).toBe("Mara storyboard");
  });
  it("persists ordered cast and stable scene assignments without substituting removed identities",()=>{
    const second={...character,id:"char-2",elementId:"element-2",name:"Noor"};
    const legacy=normalizeCastDraft({characterId:character.id,title:"",script:"First.\n\nSecond."});
    const added=toggleCastMember(legacy,second.id);added.scenes[1]={...added.scenes[1],characterId:second.id};
    const moved=reorderCast(added,0,1),roundtrip=JSON.parse(JSON.stringify(moved));
    expect(moved.castIds).toEqual([second.id,character.id]);expect(moved.scenes.map(s=>s.characterId)).toEqual([character.id,second.id]);expect(storedInfluencerDraft(roundtrip)).toBe(true);expect(normalizeCastDraft(roundtrip).scenes).toEqual(moved.scenes);
    const removed=toggleCastMember(moved,character.id);expect(removed.scenes[0].characterId).toBe(character.id);expect(influencerErrors(removed,[character,second]).join(" ")).toContain("Assign each scene");
    expect(storedInfluencerDraft({...moved,castIds:[character.id,character.id]})).toBe(false);expect(storedInfluencerDraft({...moved,scenes:[moved.scenes[0],moved.scenes[0]]})).toBe(false);
  });
  it("binds both scene identities to their own complete reference packs, not to separate temporal endpoints",()=>{
    const second={...character,id:"char-2",elementId:"element-2",name:"Noor"};
    const manifest={id:"wan-flf",version:"1",inputs:[{id:"start_image",label:"Start",type:"image",required:true},{id:"end_image",label:"End",type:"image",required:true}],controls:[{id:"length",type:"number",default:1,min:1,max:5}],audioPolicies:["mute"]} as unknown as CapabilityManifestV2;
    const element=(id:string)=>({id,name:id,assets:["front","back"].map(view=>({id:`${id}-${view}`,project_id:"project",media_type:"image",content_type:"image/png"}))}) as ReusableElement;
    const elements=[element(character.elementId),element(second.elementId)];
    const d=normalizeCastDraft({characterId:character.id,title:"",script:"First.\n\nSecond.",castIds:[character.id,second.id]});d.scenes[1].characterId=second.id;
    const shots=buildCastShotPayloads(d,[character,second],elements,manifest);
    expect(shots.map(s=>s.planKey)).toEqual(d.scenes.map(s=>s.key));expect(shots.map(s=>s.prompt)).toEqual(["Mara: First.","Noor: Second."]);
    expect(Object.values(shots[0].settings.elementInputs).map(b=>b.elementId)).toEqual([character.elementId,character.elementId]);expect(Object.values(shots[1].settings.elementInputs).map(b=>b.elementId)).toEqual([second.elementId,second.elementId]);
    expect(()=>buildCastShotPayloads(d,[character,second],[elements[0]],manifest)).toThrow("missing or incompatible");
  });
  it("summarizes each shot with its person and length before the storyboard is created",()=>{
    const second={...character,id:"char-2",elementId:"element-2",name:"Noor"};
    const manifest={id:"wan-i2v",version:"1",inputs:[],controls:[{id:"length",type:"number",default:5,min:2,max:5}],audioPolicies:["mute"]} as unknown as CapabilityManifestV2;
    const d=normalizeCastDraft({characterId:character.id,title:"",script:`First line.\n\n${Array(20).fill("word").join(" ")}`,castIds:[character.id,second.id]});
    d.scenes[1].characterId=second.id;
    expect(shotPlan(d,[character,second]).shots.map(s=>({shot:s.shot,name:s.characterName,seconds:s.seconds}))).toEqual([{shot:1,name:"Mara",seconds:2},{shot:2,name:"Noor",seconds:8}]);
    const plan=shotPlan(d,[character,second],manifest);
    expect(plan.shots.map(s=>({shot:s.shot,name:s.characterName,seconds:s.seconds}))).toEqual([{shot:1,name:"Mara",seconds:2},{shot:2,name:"Noor",seconds:5}]);
    expect(plan.shots.map(s=>s.key)).toEqual(d.scenes.map(s=>s.key));
    expect(plan.totalSeconds).toBe(7);
    const mixed=castDraftWithScenes(d,[...d.scenes,{key:"k3",text:"Third.",characterId:"char-gone"}]);
    expect(shotPlan(mixed,[character,second]).shots.map(s=>s.characterName)).toEqual(["Mara","Noor","Pick a person"]);
    expect(shotPlan(castDraftWithScenes(d,[{key:"k1",text:"   ",characterId:character.id}]),[character])).toEqual({shots:[],totalSeconds:0});
  });

});
