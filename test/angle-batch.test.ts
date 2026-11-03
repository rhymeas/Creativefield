import {describe,expect,it} from "vitest";
import {loadServerCatalogue} from "../server/catalogue";
import {angleBatchPendingPresets,angleBatchSubmittingCount,angleBatchStorageKey,angleRunRequest,extendAngleBatch,freezeAngleBatch,recoverAngleBatch,recoverAngleBatchForReview} from "../src/image/angle-batch";
import {defaultImageDraft} from "../src/image/image-state";
import {compileLocal} from "../src/capabilities/compile";

describe("angle batch uses existing run admission",()=>{
  const scope={workspaceId:"workspace",projectId:"project",userId:"user",workerId:"worker"},id="df2d1b52-a4ad-482d-a68f-8bc68d94c0b7";
  it("shows planned slots only while submission is active, and removes accepted slots",async()=>{
    const manifest=(await loadServerCatalogue()).find(b=>b.manifest.id==="flux2-klein-angles")!.manifest;
    const draft=defaultImageDraft(manifest);draft.inputs={source_image:"source"};
    const batch=freezeAngleBatch(manifest,draft,["high-left","low-right"],scope,id);
    expect(angleBatchSubmittingCount(batch,manifest,true)).toBe(2);
    expect(angleBatchSubmittingCount({...batch,runIds:{"high-left":"run-1"}},manifest,true)).toBe(1);
    expect(angleBatchSubmittingCount(batch,manifest,false)).toBe(0);
  });
  it("freezes one source/note and gives each selected preset a stable distinct request",async()=>{
    const bundle=(await loadServerCatalogue()).find(b=>b.manifest.id==="flux2-klein-angles")!,draft=defaultImageDraft(bundle.manifest);draft.inputs={source_image:"source"};draft.controls.prompt="Keep the red jacket.";
    const batch=freezeAngleBatch(bundle.manifest,draft,["high-left","low-right"],scope,id);draft.controls.prompt="Changed later";draft.inputs.source_image="other";
    const first=angleRunRequest(batch,"high-left"),second=angleRunRequest(batch,"low-right");expect(first.inputs).toEqual({source_image:"source"});expect(first.controls.prompt).toBe("Keep the red jacket.");expect(first.idempotencyKey).not.toBe(second.idempotencyKey);expect(angleRunRequest(JSON.parse(JSON.stringify(batch)),"high-left")).toEqual(first);
    const graph=compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_image:"comfyfield-source.png"},controls:first.controls,presetId:first.presetId,audioPolicy:"mute"});
    const promptControl=bundle.manifest.controls.find(c=>c.id==="prompt")!;expect(String(graph[promptControl.binding!.node].inputs[promptControl.binding!.field])).toContain("Keep the red jacket.");
    expect(recoverAngleBatch(batch,bundle.manifest,scope)).toEqual(batch);expect(recoverAngleBatch({...batch,pendingPreset:"high-left"},bundle.manifest,scope)?.pendingPreset).toBe("high-left");expect(recoverAngleBatch({...batch,pendingPreset:"not-selected"},bundle.manifest,scope)).toBeNull();expect(recoverAngleBatch(batch,bundle.manifest,{...scope,userId:"other"})).toBeNull();expect(angleBatchStorageKey(scope)).not.toBe(angleBatchStorageKey({...scope,projectId:"other"}));expect(angleBatchStorageKey(scope,"qwen-image-21-angles")).not.toBe(angleBatchStorageKey(scope,"flux2-klein-angles"));
    expect(()=>freezeAngleBatch(bundle.manifest,defaultImageDraft(bundle.manifest),["high-left"],scope,id)).toThrow(/required/);expect(()=>freezeAngleBatch(bundle.manifest,draft,["made-up"],scope,id)).toThrow();expect(()=>freezeAngleBatch(bundle.manifest,draft,["high-left","high-left"],scope,id)).toThrow();expect(()=>angleRunRequest(batch,"low")).toThrow();
  });
  it("maps all eight angle presets and all relight moods to real prompt bindings",async()=>{
    const catalogue=await loadServerCatalogue();
    for(const capability of ["flux2-klein-angles","flux2-klein-relight"]){
      const bundle=catalogue.find(b=>b.manifest.id===capability)!,control=bundle.manifest.controls.find(c=>c.id==="prompt")!,draft=defaultImageDraft(bundle.manifest);
      for(const preset of bundle.manifest.presets){const graph=compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_image:"comfyfield-source.png"},controls:{...draft.controls,prompt:"Keep my extra note."},presetId:preset.id,audioPolicy:"mute"});expect(graph[control.binding!.node].inputs[control.binding!.field]).toBe(`${preset.values.prompt}\n\nKeep my extra note.`);}
    }
  });

  it("keeps fresh angle batches scene-neutral and refuses resuming a different recipe revision",async()=>{
    const bundle=(await loadServerCatalogue()).find(b=>b.manifest.id==="flux2-klein-angles")!,draft=defaultImageDraft(bundle.manifest);
    draft.inputs={source_image:"source"};
    const batch=freezeAngleBatch(bundle.manifest,draft,["left-45","right-45"],scope,id);
    for(const presetId of batch.presetIds){
      const request=angleRunRequest(batch,presetId);
      const graph=compileLocal(bundle,{...request,inputs:{source_image:"comfyfield-scene.png"},audioPolicy:"mute"});
      const text=String(graph["28"].inputs.value);
      expect(text).not.toMatch(/snow|mountain|handbag|bag color/i);
      expect(text).toContain(presetId==="left-45"?"subject's left":"subject's right");
      expect(graph["133"].inputs.image).toBe("comfyfield-scene.png");
      expect(graph["128:107"].inputs.steps).toBe(16);
    }
    expect(recoverAngleBatch({...batch,capabilityVersion:"0.1.0"},bundle.manifest,scope)).toBeNull();
  });
  it("freezes a Qwen angle batch with distinct presets and compiles the <mva> instruction", async () => {
    const bundle = (await loadServerCatalogue()).find(b => b.manifest.id === "qwen-image-21-angles")!;
    const draft = defaultImageDraft(bundle.manifest);
    draft.inputs = { source_image: "source" };
    draft.controls.prompt = "Keep the red jacket.";
    const batch = freezeAngleBatch(bundle.manifest, draft, ["left-side", "back"], scope, id);
    expect(batch.capabilityId).toBe("qwen-image-21-angles");
    const first = angleRunRequest(batch, "left-side"), second = angleRunRequest(batch, "back");
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    const graph = compileLocal(bundle, {
      capabilityId: bundle.manifest.id,
      version: bundle.manifest.version,
      routeId: "local",
      inputs: { source_image: "comfyfield-source.png" },
      controls: first.controls,
      presetId: first.presetId,
      audioPolicy: "mute",
    });
    const prompt = bundle.manifest.controls.find(control => control.id === "prompt")!;
    const text = String(graph[prompt.binding!.node].inputs[prompt.binding!.field]);
    expect(text).toContain("<mva> left side view");
    expect(text).toContain("Keep the red jacket.");
  });

  it("extends a completed batch with only new directions and keeps accepted request keys",async()=>{
    const bundle=(await loadServerCatalogue()).find(b=>b.manifest.id==="flux2-klein-angles")!,saved=freezeAngleBatch(bundle.manifest,{...defaultImageDraft(bundle.manifest),inputs:{source_image:"source"}},["high-left"],scope,id);
    saved.runIds["high-left"]="00000000-0000-4000-8000-000000000010";
    const extended=extendAngleBatch(saved,["high-left","low-right"],bundle.manifest);
    expect(extended.presetIds).toEqual(["high-left","low-right"]);
    expect(extended.runIds).toEqual(saved.runIds);
    expect(extended.draft).toEqual(saved.draft);
    expect(angleBatchPendingPresets(extended,bundle.manifest)).toEqual(["low-right"]);
    expect(angleRunRequest(extended,"high-left").idempotencyKey).toBe(angleRunRequest(saved,"high-left").idempotencyKey);
  });

  it("reviews old receipts without changing their version or admitting remaining angles",async()=>{
    const bundle=(await loadServerCatalogue()).find(b=>b.manifest.id==="flux2-klein-angles")!,draft=defaultImageDraft(bundle.manifest);draft.inputs={source_image:"source"};
    const saved={...freezeAngleBatch(bundle.manifest,draft,["left-45","right-45"],scope,id),capabilityVersion:"0.1.0"};
    saved.runIds={"left-45":"00000000-0000-4000-8000-000000000001"};saved.pendingPreset="right-45";
    const restored=recoverAngleBatchForReview(JSON.parse(JSON.stringify(saved)),bundle.manifest,scope)!;
    expect(restored).toEqual(saved);
    expect(angleBatchPendingPresets(restored,bundle.manifest)).toEqual(["right-45"]);
    expect(angleRunRequest(restored,"right-45").version).toBe("0.1.0");
    expect(angleRunRequest(restored,"right-45").idempotencyKey).toBe(angleRunRequest(saved,"right-45").idempotencyKey);
    expect(()=>compileLocal(bundle,{...angleRunRequest(restored,"right-45"),audioPolicy:"mute"})).toThrow(/revision mismatch/);
    delete restored.pendingPreset;expect(angleBatchPendingPresets(restored,bundle.manifest)).toEqual([]);
    expect(recoverAngleBatchForReview(saved,bundle.manifest,{...scope,projectId:"other"})).toBeNull();
    expect(recoverAngleBatchForReview({...saved,capabilityVersion:{}},bundle.manifest,scope)).toBeNull();
    expect(recoverAngleBatchForReview({...saved,presetIds:["unknown"]},bundle.manifest,scope)).toBeNull();
  });

});
