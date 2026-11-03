import {describe,expect,it} from "vitest";
import {existsSync} from "node:fs";
import {TASKS,routeTask,routeImageToVideo,type TaskId} from "../src/capabilities/tasks";

describe("task router",()=>{
  it("names only packs that exist",()=>{
    for(const task of Object.values(TASKS))for(const id of task.candidates)expect(existsSync(`native-workflows/${id}/manifest.json`),id).toBe(true);
  });
  it("picks the first ready candidate and says why",()=>{
    const ready=[{id:"qwen-image-21-t2i"},{id:"flux2-klein-t2i"}];
    expect(routeTask("image.create",ready)).toMatchObject({pack:{id:"flux2-klein-t2i"},fallback:false});
  });
  it("falls back when the best pack is not ready, and says so",()=>{
    const routed=routeTask("image.create",[{id:"qwen-image-21-t2i"}]);
    expect(routed).toMatchObject({pack:{id:"qwen-image-21-t2i"},fallback:true});
    expect(routed?.reason).toContain("not ready here");
  });
  it("returns nothing when no candidate is ready",()=>{
    expect(routeTask("video.create",[{id:"flux2-klein-t2i"}])).toBeUndefined();
    expect(routeTask("image.create",[{id:"z-image-turbo-t2i"},{id:"moss-image-t2i"}])).toBeUndefined();
  });
  it("routes the user's decisions: FLUX 3 creates, Fibo edits, H3 makes video",()=>{
    const first=(task:TaskId)=>TASKS[task].candidates[0];
    expect(first("image.create")).toBe("flux2-klein-t2i");
    expect(first("image.edit")).toBe("fibo2-edit");
    expect(first("video.create")).toBe("h3-t2v");
    expect(first("video.from-image")).toBe("h3-i2v");
  });
  it("routes an image to the supported H3 input and never falls back to Wan",()=>{
    const wan={id:'wan22-ti2v-5b',inputs:[{id:'start_image',type:'image'}]};
    const h3={id:'h3-i2v',inputs:[{id:'start_image',type:'image'}]};
    const reference={id:'minimax-h3-video',inputs:[{id:'character_image',type:'image'}]};
    expect(routeImageToVideo([wan,reference,h3])).toEqual({pack:h3,inputId:'start_image'});
    expect(routeImageToVideo([wan,reference])).toEqual({pack:reference,inputId:'character_image'});
    expect(routeImageToVideo([wan])).toBeUndefined();
    expect(routeImageToVideo([{id:'h3-i2v',inputs:[{id:'source_video',type:'video'}]}])).toBeUndefined();
  });
});
