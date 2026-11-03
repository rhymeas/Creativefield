import {describe,it,expect} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {CloudRunConsent,isCloudWorker,runTargetOptions,targetWorkers} from "../src/team/TeamApp";
import {workerKind} from "../src/team/TeamSettings";
import type {Worker} from "../src/team/api";

const local:Worker={id:"local",name:"This computer",enabled:true,origin:"http://127.0.0.1:8188",checked_at:null,inventory:null};
const cloud={...local,id:"cloud",name:"Comfy Cloud",origin:"https://cloud.comfy.org",kind:"cloud"} as Worker;

describe("Comfy Cloud is a choice, never a surprise",()=>{
  it("offers cloud setup and Router from every creative canvas",()=>{
    expect(runTargetOptions([])?.map(o=>o.value)).toEqual(['local','cloud','router']);
    expect(runTargetOptions([local])?.map(o=>o.value)).toEqual(['local','cloud','router']);
    expect(runTargetOptions([])?.find(o=>o.value==='cloud')?.note).toContain('no render starts');
  });
  it("keeps this computer first and preselected",()=>{
    const options=runTargetOptions([cloud,local])!;
    expect(options.map(option=>option.value)).toEqual(["local","cloud","router"]);
    expect(options[0].label).toBe("This computer");
    expect(options[1]).toMatchObject({label:"Comfy Cloud"});
    expect(options[1].note).toContain("credits");
  });
  it("sends runs only to the chosen target",()=>{
    expect(targetWorkers([local,cloud],"local")).toEqual([local]);
    expect(targetWorkers([local,cloud],"cloud")).toEqual([cloud]);
    expect(targetWorkers([local,cloud],"router")).toEqual([]);
    expect(isCloudWorker(local)).toBe(false);
    expect(isCloudWorker(cloud)).toBe(true);
  });
  it("asks for a clear yes before the first Cloud run",()=>{
    const html=renderToStaticMarkup(<CloudRunConsent onUse={()=>{}} onKeep={()=>{}}/>);
    expect(html).toContain("Cloud runs use your Comfy Cloud credits.");
    expect(html).toContain("Use Comfy Cloud");
    expect(html).toContain("Keep local");
    expect(html).not.toContain("disabled");
  });
  it("registers a cloud worker only at the Comfy Cloud address",()=>{
    expect(workerKind("https://cloud.comfy.org")).toBe("cloud");
    expect(workerKind("https://cloud.comfy.org/")).toBe("cloud");
    expect(workerKind("http://127.0.0.1:8188")).toBe("local");
    expect(workerKind("not a url")).toBe("local");
  });
});
