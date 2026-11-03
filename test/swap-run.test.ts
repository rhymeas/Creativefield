import {describe,expect,it} from "vitest";
import {attemptKey,cancelSwapRun,runSwapAttempt,swapStepBody,SwapStepError,type TrackedStep} from "../src/team/swap-run";
import type {Call,Run} from "../src/team/api";

type Seen={path:string;method?:string;body?:unknown};
function recorder(answer:(method:string|undefined,path:string,body:unknown)=>Partial<Run>){
  const seen:Seen[]=[];
  const call=(async(path:string,method?:string,body?:unknown)=>{
    seen.push({path,method,body});
    return {id:"run",state:"succeeded",error:null,output_ids:[],...answer(method,path,body)};
  }) as unknown as Call;
  return {call,seen};
}

const steps=(attempt?:{tracking?:boolean}):TrackedStep[]=>[
  {id:"mask",label:"Find the red car",capabilityId:"sam31-video-mask",version:"0.1.0",
    inputs:{source_video:{asset:"video"}},controls:{},
    ...(attempt?.tracking?{tracking:{prompt:"the red car"}}:{})},
  {id:"edit",label:"Change the red car",capabilityId:"wan21-vace-masked-edit",version:"0.3.0",
    inputs:{source_video:{asset:"video"},edit_mask:{step:"mask"}},controls:{prompt:"a blue bike"}},
];
const target={projectId:"project",workerId:"worker"};

describe("swap run loop",()=>{
  it("gives each attempt its own key, so pressing Generate again queues a new run",()=>{
    const mask=steps({tracking:true})[0];
    const body=(attempt:number)=>swapStepBody(mask,{source_video:"video"},{...target,attempt});
    expect(body(1).idempotencyKey).toBe("swap-1-mask");
    expect(body(1).idempotencyKey).not.toBe(body(2).idempotencyKey);
    expect(attemptKey(1,"mask")).not.toBe(attemptKey(1,"edit"));
    expect(body(1).tracking).toEqual({prompt:"the red car"});
    expect(body(1).controls).not.toHaveProperty("prompt");
  });

  it("says which step is working, feeds its output into the next and hands Cancel the run",async()=>{
    const {call,seen}=recorder((method,_path,body)=>{
      if(method!=="POST")return{state:"succeeded",output_ids:["edit-asset"]};
      return (body as {capabilityId:string}).capabilityId==="sam31-video-mask"
        ?{id:"run-mask",output_ids:["mask-asset"]}:{id:"run-edit",output_ids:["edit-asset"]};
    });
    const labels:string[]=[],runs:Array<string|null>=[];
    const outputs=await runSwapAttempt({call,workspaceId:"ws",...target,attempt:1,steps:steps({tracking:true}),
      onStep:label=>labels.push(label),onRun:id=>runs.push(id),sleep:async()=>{}});
    expect(labels).toEqual(["Find the red car…","Change the red car…",""]);
    expect(runs).toEqual(["run-mask","run-edit",null]);
    expect(outputs).toEqual({mask:"mask-asset",edit:"edit-asset"});
    const posts=seen.filter(entry=>entry.method==="POST").map(entry=>entry.body as {idempotencyKey:string;inputs:Record<string,string>});
    expect(posts.map(post=>post.idempotencyKey)).toEqual(["swap-1-mask","swap-1-edit"]);
    expect(posts.map(post=>post.inputs)).toEqual([
      {source_video:"video"},
      {source_video:"video",edit_mask:"mask-asset"},
    ]);
  });

  it("waits for a running step instead of queueing it twice",async()=>{
    let checks=0;
    const {call,seen}=recorder(method=>(method==="GET"
      ?(++checks===2?{state:"succeeded",output_ids:["mask-asset"]}:{state:"running"})
      :{id:"run-mask",state:"running"}));
    const outputs=await runSwapAttempt({call,workspaceId:"ws",...target,attempt:1,steps:[steps()[0]],sleep:async()=>{}});
    expect(outputs).toEqual({mask:"mask-asset"});
    expect(seen.filter(entry=>entry.method==="POST")).toHaveLength(1);
    expect(checks).toBe(2);
  });

  it("names the step that failed, in plain words",async()=>{
    const failed=await runSwapAttempt({call:recorder(()=>({state:"failed",error:null,output_ids:[]})).call,
      workspaceId:"ws",...target,attempt:1,steps:[steps()[0]],sleep:async()=>{}}).catch(error=>error);
    expect(failed).toBeInstanceOf(SwapStepError);
    expect((failed as SwapStepError).label).toBe("Find the red car");
    expect(failed.message).toBe("Find the red car: it did not finish.");
    const cancelled=await runSwapAttempt({call:recorder(()=>({state:"canceled",error:null,output_ids:[]})).call,
      workspaceId:"ws",...target,attempt:1,steps:[steps()[0]],sleep:async()=>{}}).catch(error=>error);
    expect(cancelled.message).toBe("Find the red car: it was cancelled.");
  });

  it("cancels the run that is working",async()=>{
    const {call,seen}=recorder(()=>({}));
    await cancelSwapRun(call,"ws","run-1");
    expect(seen).toEqual([{path:"/workspaces/ws/runs/run-1/cancel",method:"POST",body:{}}]);
  });
});
