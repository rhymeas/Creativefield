import {describe,expect,it} from "vitest";
import {loadServerCatalogue} from "../server/catalogue";
import {compileLocal} from "../src/capabilities/compile";
import {freezeSweep,pendingDirections,recoverSweep,sweepFrameTimes,sweepOrder,sweepRunRequest,SWEEP_CAPABILITY,SWEEP_DIRECTIONS} from "../src/image/angle-sweep";

const scope={workspaceId:"w",projectId:"p",userId:"u",workerId:"worker"},id="df2d1b52-a4ad-482d-a68f-8bc68d94c0b7";

describe("angle sweep",()=>{
  it("targets the installed Fun Camera graph with supported poses",async()=>{
    const bundle=(await loadServerCatalogue()).find(b=>b.manifest.id===SWEEP_CAPABILITY.id)!;
    expect(bundle.manifest.version).toBe(SWEEP_CAPABILITY.version);
    const pose=bundle.manifest.controls.find(c=>c.id==="camera_pose")!;
    for(const d of SWEEP_DIRECTIONS)expect(pose.options).toContain(d.pose);
    const sweep=freezeSweep("source",scope,id),graph=compileLocal(bundle,{...sweepRunRequest(sweep,"left"),inputs:{start_image:"comfyfield-start.png"}} as never);
    expect(Object.values(graph).some(n=>(n.inputs as Record<string,unknown>).camera_pose==="Pan Left")).toBe(true);
  });
  it("gives each direction a stable distinct key and resumes only the unsent one",()=>{
    const sweep=freezeSweep("source",scope,id),left=sweepRunRequest(sweep,"left"),right=sweepRunRequest(sweep,"right");
    expect(left.idempotencyKey).not.toBe(right.idempotencyKey);expect(sweepRunRequest(sweep,"left")).toEqual(left);
    expect(left.controls.speed).toBe(1.6);expect(right.controls.speed).toBe(1);
    expect(pendingDirections(sweep)).toEqual(["left","right"]);
    expect(pendingDirections({...sweep,runIds:{left:"run"}})).toEqual(["right"]);
  });
  it("refuses a saved sweep for another source, project or user",()=>{
    const sweep=freezeSweep("source",scope,id);
    expect(recoverSweep(sweep,scope,"source")).toEqual(sweep);
    expect(recoverSweep(sweep,scope,"other")).toBeNull();
    expect(recoverSweep(sweep,{...scope,projectId:"x"},"source")).toBeNull();
    expect(recoverSweep(sweep,{...scope,userId:"x"},"source")).toBeNull();
    expect(()=>freezeSweep("",scope)).toThrow();expect(()=>freezeSweep("source",{...scope,workerId:""})).toThrow();
  });
  it("spaces frames evenly and orders them left to right around the original",()=>{
    const t=sweepFrameTimes(1,5);expect(t).toHaveLength(5);expect(t[0]).toBe(0);expect(t[4]).toBeLessThan(1);expect([...t].sort((a,b)=>a-b)).toEqual(t);
    expect(sweepFrameTimes(0,5)).toEqual([]);expect(sweepFrameTimes(1,1)).toEqual([0]);
    expect(sweepOrder(["l1","l2"],"o",["r1","r2"])).toEqual(["l2","l1","o","r1","r2"]);
  });
});
