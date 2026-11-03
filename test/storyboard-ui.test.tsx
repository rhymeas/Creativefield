import {describe,it,expect} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {buildCatalogue} from "../src/capabilities/catalogue";
import {providers} from "../src/pipelines/registry";
import {boardDraftKey,boardRequirements,chooseWorkflow,eligible,equalShots,fromBoard,moveShot,newShot,saveOutcome,shotErrors,shotPayload,storedDraft,storyboardCreationModels,storyboardModelProblem,transitionProblem,type Board} from "../src/team/storyboard-state";
import {StoryboardShotEditor,shotAudioChoices} from "../src/team/StoryboardShotEditor";
import type {CapabilityManifestV2} from "../src/capabilities/types";
import {approvedTakes,type StillTake} from "../src/team/StoryboardStills";
import {BoardEditor,joinChoices} from "../src/team/TeamStoryboard";
import type {Call,Worker} from "../src/team/api";
const catalogue=buildCatalogue(providers).map(b=>b.manifest),m=catalogue.find(m=>m.category==="t2v")!;
const valid=()=>{const s=newShot(m);s.prompt="A red cup";return s;};
const board=(revision=1):Board=>({id:"b",project_id:"p",name:"Board",revision,shots:[{id:"s",ordinal:0,prompt:"A red cup",duration_seconds:"1.000",settings:valid().settings,assets:[]}]});
describe("team storyboard state",()=>{
  it("offers approved H3 workflows for new shots without changing existing shots",()=>{
    const legacy=catalogue.find(item=>item.id==="wan22-i2v-14b")!;
    const h3={...legacy,id:"h3-i2v"};
    const shot=newShot(legacy),before=structuredClone(shot);
    expect(storyboardCreationModels([legacy,h3]).map(item=>item.id)).toEqual(["h3-i2v"]);
    expect(shot).toEqual(before);
    expect(shot.settings.generation?.capabilityId).toBe(legacy.id);
    expect(storyboardModelProblem(shot)).toMatch(/MiniMax H3/);
    expect(storyboardModelProblem(newShot(h3))).toBeUndefined();
  });
  it("limits workflows to explicit duration-controlled local generators",()=>{
    expect(catalogue.filter(eligible).every(m=>["t2v","i2v","flf2v"].includes(m.category))).toBe(true);
    expect(catalogue.filter(eligible).map(m=>m.id)).toContain("wan22-i2v-14b");
    expect(catalogue.filter(eligible)).toHaveLength(4);
    const unmapped=structuredClone(catalogue.find(m=>m.id==="wan22-i2v-14b")!);delete unmapped.timing!.frameMapping;expect(eligible(unmapped)).toBe(false);
    const shot=fromBoard({...board(),shots:[{...board().shots![0],settings:{audioPolicy:"mute",elementInputs:{}}}]}).shots[0];
    expect(shot.settings.generation).toBeUndefined();expect(shotErrors(shot,catalogue,[])).toContain("Choose a supported local workflow revision.");
  });
  it("normalizes GET fields and strips editor keys from ordered PUT payload",()=>{
    const d=fromBoard(board());expect(d.shots[0].durationSeconds).toBe(1);const payload=shotPayload(d.shots);expect(payload[0]).not.toHaveProperty("key");expect(payload[0].settings.generation!.controls).not.toHaveProperty("length");expect(payload[0].settings.generation!.controls).not.toHaveProperty("prompt");
  });
  it("reorders stably without mutating shots and respects bounds",()=>{
    const a=valid(),b={...valid(),prompt:"blue"},shots=[a,b];expect(moveShot(shots,0,1)).toEqual([b,a]);expect(shots).toEqual([a,b]);expect(moveShot(shots,0,-1)).toBe(shots);
  });
  it("resets workflow-specific controls and references only on explicit selection",()=>{
    const shot=valid();shot.assets=[{role:"start_image",assetId:"old"}];shot.settings.cameraHint="dolly";
    const next=chooseWorkflow(shot,m);expect(next.assets).toEqual([]);expect(next.prompt).toBe(shot.prompt);expect(next.settings.cameraHint).toBe("dolly");expect(shot.assets).toHaveLength(1);
  });
  it("validates empty prompt, duration, seed, shape, unbound hints and unsupported controls",()=>{
    expect(shotErrors(valid(),catalogue,[])).toEqual([]);
    for(const mutate of [(s:ReturnType<typeof valid>)=>{s.prompt="";},(s:ReturnType<typeof valid>)=>{s.durationSeconds="";},(s:ReturnType<typeof valid>)=>{s.settings.generation!.controls.seed=-1;},(s:ReturnType<typeof valid>)=>{s.settings.generation!.controls.width=123;},(s:ReturnType<typeof valid>)=>{s.settings.cameraHint="dolly";},(s:ReturnType<typeof valid>)=>{s.settings.generation!.controls.length=2;}]){const s=valid();mutate(s);expect(shotErrors(s,catalogue,[]).length).toBeGreaterThan(0);}
  });
  it("requires images for I2V and rejects unresolved media or mismatched revisions",()=>{
    const imageModel=catalogue.find(m=>m.category==="i2v"&&eligible(m))!,s=chooseWorkflow(valid(),imageModel);expect(shotErrors(s,catalogue,[]).join(" ")).toContain("required");
    s.assets=[{role:"start_image",assetId:"image"}];expect(shotErrors(s,catalogue,[]).join(" ")).toContain("shared media");s.settings.generation!.version="old";expect(shotErrors(s,catalogue,[]).join(" ")).toContain("revision");
  });
  it("distinguishes save acknowledgement, exact retry and conflicting revisions",()=>{
    const b=board(),d=fromBoard(b),intent={revision:b.revision,shots:shotPayload(d.shots)};
    expect(saveOutcome({...intent,shots:intent.shots.map(({planKey:_key,...s})=>s)},board(2))).toBe("saved");
    expect(saveOutcome(intent,b)).toBe("retry");expect(saveOutcome(intent,board(2))).toBe("saved");expect(saveOutcome(intent,board(3))).toBe("conflict");
    const changed=board(2);changed.shots![0].prompt="changed";expect(saveOutcome(intent,changed)).toBe("conflict");
    expect(equalShots(d.shots,[{...d.shots[0],key:"replacement-id"}])).toBe(false);
  });
  it("keeps a shot title separate from the generation prompt across board loading",()=>{
    const b=board();b.shots![0].settings={...b.shots![0].settings,title:"Opening shot"};
    const draft=fromBoard(b);
    expect(draft.shots[0].settings.title).toBe("Opening shot");
    expect(draft.shots[0].prompt).toBe(b.shots![0].prompt);
    expect(shotPayload(draft.shots)[0].settings.title).toBe("Opening shot");
  });
  it("accepts a 500-character title and rejects oversized stored drafts without changing the prompt",()=>{
    const draft=fromBoard(board());draft.shots[0].settings.title="x".repeat(500);
    expect(storedDraft(draft)).toBe(true);
    expect(shotErrors(draft.shots[0],catalogue,[])).not.toContain("Use a shot title of up to 500 characters.");
    draft.shots[0].settings.title+="x";
    expect(storedDraft(draft)).toBe(false);
    expect(shotErrors(draft.shots[0],catalogue,[])).toEqual(["Use a shot title of up to 500 characters."]);
    expect(draft.shots[0].prompt).toBe("A red cup");
  });
  it("pins the latest explicit approval, excludes changed prompts and keeps it through unapproved takes",()=>{
    const s=valid(),first={id:"approved",plan_key:s.key,prompt:s.prompt,state:"succeeded",approved_asset_id:"image",approved_at:"2026-10-21T10:00:00Z"} as StillTake;
    const next={...first,id:"new-candidate",approved_asset_id:null,approved_at:null};
    expect(approvedTakes([s],[next,first])[s.key].id).toBe("approved");
    expect(approvedTakes([{...s,prompt:"Changed"}],[first])).toEqual({});
    expect(approvedTakes([{...s,key:"different-shot"}],[first])).toEqual({});
    expect(approvedTakes([s],[{...first,id:"new-approval",approved_at:"2026-10-21T11:00:00Z"},first])[s.key].id).toBe("new-approval");
  });
  it("scopes recoverable drafts and rejects malformed browser records",()=>{
    expect(boardDraftKey("u","w","p","b")).not.toBe(boardDraftKey("u2","w","p","b"));expect(boardDraftKey("u","w","p","b")).not.toBe(boardDraftKey("u","w","p2","b"));
    expect(storedDraft(fromBoard(board()))).toBe(true);for(const value of [null,{},[],{...fromBoard(board()),assembly:{width:1,height:1,fps:0}},{...fromBoard(board()),shots:[{}]}])expect(storedDraft(value)).toBe(false);
  });
  it("requires the selected worker to satisfy every shot and live inventory",()=>{
    const req=m.routes[0].requirements,w:Worker={id:"w",name:"Worker",enabled:true,origin:"http://localhost:8188",checked_at:new Date().toISOString(),inventory:{online:true,nodes:req.filter(r=>r.kind==="node").map(r=>r.name),models:req.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),credentials:[]}};
    expect(boardRequirements([valid()],catalogue,w)).toEqual([]);expect(boardRequirements([valid()],catalogue,{...w,checked_at:null}).length).toBeGreaterThan(0);expect(boardRequirements([valid()],catalogue).length).toBeGreaterThan(0);
  });
  it("accepts hard cuts and refuses a cross-fade that assembly cannot build",()=>{
    const two=[{durationSeconds:5},{durationSeconds:4}];
    expect(transitionProblem(two)).toBeUndefined();
    expect(transitionProblem(two,{kind:"cut",seconds:0})).toBeUndefined();
    expect(transitionProblem([{durationSeconds:5}],{kind:"crossfade",seconds:0.5})).toBe("A cross-fade needs at least two shots.");
    expect(transitionProblem(two,{kind:"crossfade",seconds:0.5})).toBeUndefined();
    expect(transitionProblem(two,{kind:"crossfade",seconds:1})).toBeUndefined();
    expect(transitionProblem([{durationSeconds:5},{durationSeconds:1}],{kind:"crossfade",seconds:1})).toBe("A 1 s cross-fade is longer than the shortest shot.");
    expect(transitionProblem(two,{kind:"crossfade",seconds:4})).toBe("A 4 s cross-fade is longer than the shortest shot.");
    expect(transitionProblem([{durationSeconds:""},{durationSeconds:0}],{kind:"crossfade",seconds:0.5})).toBeUndefined();
  });
  it("renders existing themed menus and media controls without native selects",()=>{
    const html=renderToStaticMarkup(<StoryboardShotEditor shot={valid()} manifests={catalogue.filter(eligible)} assets={[]} elements={[]} workspace="w" disabled={false} files={{}} onChange={()=>{}} onFile={()=>{}} onUpload={()=>{}}/>);
    expect(html).not.toContain("<select");expect(html).toContain("ds-modelcard");expect(html).toContain("ds-param");expect(html).toContain("Shot prompt");
  });
  it("offers only the shot joins assembly can build",()=>{
    expect(joinChoices([{durationSeconds:5}])).toEqual(["cut"]);
    expect(joinChoices([{durationSeconds:5},{durationSeconds:4}])).toEqual(["cut","crossfade-0.5","crossfade-1"]);
    expect(joinChoices([{durationSeconds:2},{durationSeconds:1}])).toEqual(["cut","crossfade-0.5"]);
    expect(joinChoices([{durationSeconds:""},{durationSeconds:0}])).toEqual(["cut","crossfade-0.5","crossfade-1"]);
  });
  it("offers shot audio only when the workflow can keep sound, in plain words",()=>{
    const wan=catalogue.find(m=>m.id==="wan22-i2v-14b")!;
    expect(shotAudioChoices(wan)).toEqual([]);
    const withSound={...wan,audioPolicies:["preserve","mute"] as CapabilityManifestV2["audioPolicies"]};
    const choices=shotAudioChoices(withSound);
    expect(choices).toEqual([{value:"preserve",label:"Keep the model's sound"},{value:"mute",label:"Mute"}]);
    expect(choices.map(c=>c.label).filter(label=>["preserve","replace","mix","mute"].includes(label))).toEqual([]);
  });
  it("marks each shot tile with its still state",()=>{
    const html=renderToStaticMarkup(<BoardEditor board={board()} user={{id:"u",email:"fixture@test.local"}} workspace={{id:"w",name:"workspace",role:"viewer"}} project={{id:"p",name:"project"}} catalogue={catalogue} workers={[]} call={(async()=>[]) as Call} authorized canEdit={false}/>);
    expect(html).toContain("Planned");expect(html).toContain("ds-status");expect(html).not.toContain("frames approved");
  });
  it("renders viewer mode without enabled edit or generation actions",()=>{
    const html=renderToStaticMarkup(<BoardEditor board={board()} user={{id:"u",email:"fixture@test.local"}} workspace={{id:"w",name:"workspace",role:"viewer"}} project={{id:"p",name:"project"}} catalogue={catalogue} workers={[]} call={(async()=>[]) as Call} authorized canEdit={false}/>);
    expect(html).toContain("View-only storyboard");expect(html).not.toContain("<select");expect(html).not.toContain("Save shots");expect(html).toContain("Render storyboard");
    expect(html).toContain("ds-storyboard-shot-placeholder");expect(html).toContain("One shot title per line");expect(html).toContain("Create shot cards");expect(html).not.toContain("shot slots left");expect(html).not.toContain("/32 planned");expect(html).not.toContain("0/1 shots approved");
    expect(html).toContain("Advanced storyboard");expect(html).toContain("Storyboard worker");expect(html).toContain("Output frame size");
  });
});
