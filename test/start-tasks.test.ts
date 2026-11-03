import {describe,expect,it} from "vitest";
import {START_TASKS,changeChoiceFromHash,matchTasks,startTasks} from "../src/team/start-tasks";
import {videoModeFromHash} from "../src/team/video-edit";

describe("start screen tasks",()=>{
  it("links every task to a real screen",()=>{
    const routes=new Set(["video","motion","image","imageedit","characters","marketing","remix","audio","3d","block"]);
    for(const task of START_TASKS){
      const [route]=task.href.slice(1).split("/");
      expect(routes.has(route),task.id).toBe(true);
      if(route==="video")expect(videoModeFromHash(task.href),task.id).not.toBeNull();
    }
  });
  it("offers Remix Studio only when a compatible editor is ready",()=>{
    expect(startTasks({remiximage:true}).find(t=>t.id==="remix")?.href).toBe("#remix");
    expect(startTasks({image:true}).some(t=>t.id==="remix")).toBe(false);
  });
  it("opens the Change page with the right card",()=>{
    expect(changeChoiceFromHash("#video/transform/swap")).toBe("swap");
    expect(changeChoiceFromHash("#video/transform/restyle")).toBe("restyle");
    expect(changeChoiceFromHash("#video/transform")).toBeUndefined();
  });
  it("hides tasks that are not set up instead of hinting them",()=>{
    const tasks=startTasks({image:true});
    expect(tasks.map(t=>t.id)).toContain("picture");
    expect(tasks.map(t=>t.id)).not.toContain("swap-person");
    expect(tasks.map(t=>t.id)).toContain("character");
    expect(tasks.length).toBeLessThan(START_TASKS.length);
    expect(startTasks({}).map(t=>t.id)).not.toContain("talk");
  });
  it("finds a card by its name or its line",()=>{
    expect(matchTasks(START_TASKS,"dance").map(t=>t.id)).toEqual(["copy-moves"]);
    expect(matchTasks(START_TASKS,"3d").map(t=>t.id)).toEqual(["model3d"]);
    expect(matchTasks(START_TASKS,"  ")).toHaveLength(START_TASKS.length);
    expect(matchTasks(START_TASKS,"kayak")).toEqual([]);
  });
  it("shows the sharpen card only when its own workflow is ready",()=>{
    expect(startTasks({vfx:true}).map(t=>t.id)).toContain("sharpen");
    expect(startTasks({image:true}).map(t=>t.id)).not.toContain("sharpen");
  });
  it("opens the sharpen card in the composer on its own workflow",()=>{
    const task=START_TASKS.find(t=>t.id==="sharpen")!;
    expect(task.label).toBe("Sharpen and upscale");
    expect(task.href).toBe("#video/create");
    expect(task.workflow).toBe("nvidia-vfx-upscale");
  });
  it("says only where a saved character works today",()=>{
    const task=START_TASKS.find(t=>t.id==="character")!;
    expect(task.label).toBe("My characters");
    expect(task.text).toBe("Save a person once, then use them to replace a face, make a picture or fill a shot.");
    expect(task.text).not.toMatch(/every|any|all/i);
  });
  it("sends 3D to templates and the model viewer, not to a model it cannot make",()=>{
    const task=START_TASKS.find(t=>t.id==="model3d")!;
    expect(task.label).toBe("3D models");
    expect(task.text).toBe("Preview a model you have or browse 3D templates.");
    expect(`${task.label} ${task.text}`).not.toMatch(/make a 3d|get a 3d model|build 3d|spin/i);
  });
  it("uses short, plain labels",()=>{
    for(const task of START_TASKS){
      expect(task.label.split(" ").length,task.label).toBeLessThanOrEqual(6);
      expect(task.label+task.text).not.toMatch(/SCAIL|VACE|Wan|FLUX|Qwen|TRELLIS|ComfyUI|workflow|capability|render/i);
    }
  });
});


it("opens the H3 effect clips in Effects only when that workflow is ready",()=>{
  expect(startTasks({video:true}).map(task=>task.id)).not.toContain("effect-clips");
  const task=startTasks({h3effects:true}).find(item=>item.id==="effect-clips");
  expect(task).toMatchObject({href:"#video/effects",workflow:"h3-effects"});
});


it("shows Ad Studio only when a product image model is ready",()=>{
  expect(startTasks({image:true}).map(task=>task.id)).not.toContain("ad");
  expect(startTasks({adimage:true}).find(task=>task.id==="ad")).toMatchObject({href:"#marketing"});
});
