import {describe,expect,it} from "vitest";
import {catalogueTitles,jobQueueTitle} from "../src/team/job-queue";

describe("workflow names for run lists and the job queue",()=>{
  it("keeps the name and drops its bracketed detail",()=>{
    expect(catalogueTitles([{id:"a",title:"Wan 2.2 14B (image to video)"},{id:"b",title:"Object replacement"}])).toEqual({a:"Wan 2.2 14B",b:"Object replacement"});
  });
  it("is what a run list needs to name a run, never the generic fallback",()=>{
    const titles=catalogueTitles([{id:"wan22-ti2v-5b",title:"Wan 2.2 TI2V 5B"}]);
    expect(jobQueueTitle("wan22-ti2v-5b",titles)).toBe("Wan 2.2 TI2V 5B");
    expect(jobQueueTitle("wan22-ti2v-5b",{})).toBe("Creative job");
  });
});
