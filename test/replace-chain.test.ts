import {describe,expect,it} from "vitest";
import {beginChain,chainKey,clearChain,failedStep,openSteps,parseChain,readChain,runReplaceChain,saveChain,saveStep,stepInputs,type ChainStep} from "../src/team/replace-chain";
import type {Call,Run} from "../src/team/api";

/** A sessionStorage-shaped store, so the tests run without a browser. */
function memory(){
  const saved=new Map<string,string>();
  return {saved,getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);},removeItem:(key:string)=>{saved.delete(key);}};
}

const steps:ChainStep[]=[
  {id:"prepare-0",label:"Prepare @Image 1",capabilityId:"flux2-klein-edit",version:"0.1.0",inputs:{source_image:{asset:"face1"}},controls:{prompt:"prepare"}},
  {id:"replace-0",label:"Replace the 1st person from the left with @Image 1",capabilityId:"scail2-character-replace",version:"0.1.0",
    inputs:{source_video:{asset:"vid"},character_image:{step:"prepare-0"}},controls:{person:"0",prompt:"replace"}},
];
const input={video:"vid",prompt:""};
const key=chainKey("replace","ws","project");

type Seen={path:string;method?:string;body?:unknown};
/** Answers a run per step id; a POST is recorded so a test can see what was queued. */
function recorder(answer?:(path:string,method?:string,body?:unknown)=>Partial<Run>){
  const seen:Seen[]=[];
  const call=(async(path:string,method?:string,body?:unknown)=>{
    seen.push({path,method,body});
    const run={id:`run-${seen.length}`,state:"succeeded",error:null,output_ids:["out-1"],...answer?.(path,method,body)};
    return run;
  }) as unknown as Call;
  return {call,seen,posts:()=>seen.filter(entry=>entry.method==="POST").map(entry=>entry.body as {idempotencyKey:string;capabilityId:string;inputs:Record<string,string>})};
}

describe("saved transform chain",()=>{
  it("keeps one chain per tool and project",()=>{
    expect(chainKey("replace","w","p")).toBe("comfyfield:chain:replace:w:p");
    expect(chainKey("swap","w","p")).not.toBe(chainKey("replace","w","p"));
  });

  it("queues only the open step after a reload, with the request id it already had",async()=>{
    const storage=memory();
    const first=recorder(()=>({output_ids:["out-prepare"]}));
    let closed=false;
    const started=beginChain({requestId:"req-1",attempt:1,input,steps});
    saveChain(storage,key,started);
    await runReplaceChain({call:first.call,workspaceId:"ws",projectId:"project",workerId:"worker",record:started,storage,key,
      sleep:async()=>{},alive:()=>!closed,onChanged:()=>{closed=first.posts().length===1;}});
    expect(first.posts().map(post=>post.idempotencyKey)).toEqual(["replace-req-1-prepare-0"]);

    // The tab was reloaded: the panel reads the chain back and carries on at the open step.
    const reloaded=readChain(storage,key);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.stepIndex).toBe(1);
    expect(reloaded!.outputs).toEqual({"prepare-0":"out-prepare"});
    expect(openSteps(reloaded!).map(step=>step.id)).toEqual(["replace-0"]);

    const second=recorder(()=>({output_ids:["out-replace"]}));
    const done=await runReplaceChain({call:second.call,workspaceId:"ws",projectId:"project",workerId:"worker",record:reloaded!,storage,key,sleep:async()=>{}});
    expect(second.posts().map(post=>post.idempotencyKey)).toEqual(["replace-req-1-replace-0"]);
    expect(second.posts()[0].inputs).toEqual({source_video:"vid",character_image:"out-prepare"});
    expect(done.outputs).toEqual({"prepare-0":"out-prepare","replace-0":"out-replace"});
    expect(done.stepIndex).toBe(2);
  });

  it("fetches a step that was already queued instead of queueing it again",async()=>{
    const storage=memory();
    const record={...beginChain({requestId:"req-2",attempt:1,input,steps}),runIds:{"prepare-0":"run-old"}};
    saveChain(storage,key,record);
    const {call,seen,posts}=recorder(path=>(path.endsWith("run-old")?{id:"run-old",output_ids:["out-prepare"]}:{id:"run-new",output_ids:["out-replace"]}));
    const done=await runReplaceChain({call,workspaceId:"ws",projectId:"project",workerId:"worker",record:readChain(storage,key)!,storage,key,sleep:async()=>{}});
    expect(seen[0]).toEqual({path:"/workspaces/ws/runs/run-old",method:"GET",body:undefined});
    expect(posts().map(post=>post.idempotencyKey)).toEqual(["replace-req-2-replace-0"]);
    expect(done.outputs["replace-0"]).toBe("out-replace");
  });

  it("names the step that did not finish and starts it fresh next time",async()=>{
    const storage=memory();
    const record=beginChain({requestId:"req-3",attempt:1,input,steps});
    const failed=await runReplaceChain({call:recorder(()=>({state:"failed",error:null,output_ids:[]})).call,
      workspaceId:"ws",projectId:"project",workerId:"worker",record,storage,key,sleep:async()=>{},alive:()=>true}).catch(error=>error);
    expect((failed as Error).message).toBe("Prepare @Image 1: failed. Press Continue to go on from here.");
    const saved=readChain(storage,key)!;
    expect(saved.runIds).toEqual({});
    expect(saved.outputs).toEqual({});
    expect(saved.requestId).not.toBe("req-3");
    const again=recorder(()=>({output_ids:["out-prepare"]}));
    await runReplaceChain({call:again.call,workspaceId:"ws",projectId:"project",workerId:"worker",record:saved,storage,key,sleep:async()=>{}});
    expect(again.posts()[0].idempotencyKey).toBe(`replace-${saved.requestId}-prepare-0`);
  });

  it("keeps a found mask in the chain, so only the change is left",()=>{
    const swapSteps:ChainStep[]=[
      {id:"mask",label:"Find the red car",capabilityId:"sam31-video-mask",version:"0.1.0",inputs:{source_video:{asset:"vid"}},controls:{},tracking:{prompt:"the red car"}},
      {id:"edit",label:"Change the red car",capabilityId:"wan21-vace-masked-edit",version:"0.3.0",inputs:{source_video:{asset:"vid"},edit_mask:{step:"mask"}},controls:{prompt:"a blue bike"}},
    ];
    const swapKey=chainKey("swap","ws","project");
    const storage=memory();
    const started=beginChain({requestId:"req-4",attempt:2,input:{video:"vid",target:"the red car",prompt:""},steps:swapSteps});
    saveChain(storage,swapKey,started);
    const found=saveStep(started,"mask","run-mask","mask-asset");
    saveChain(storage,swapKey,found);
    const reloaded=readChain(storage,swapKey)!;
    expect(reloaded.input).toEqual({video:"vid",target:"the red car",prompt:""});
    expect(reloaded.attempt).toBe(2);
    expect(reloaded.outputs).toEqual({mask:"mask-asset"});
    expect(openSteps(reloaded).map(step=>step.id)).toEqual(["edit"]);
    expect(stepInputs(openSteps(reloaded)[0],reloaded.outputs)).toEqual({source_video:"vid",edit_mask:"mask-asset"});
    clearChain(storage,swapKey);
    expect(readChain(storage,swapKey)).toBeNull();
  });

  it("starts a new attempt after a step failed, so the old failed run is not fetched again",()=>{
    const started=beginChain({requestId:"req-5",attempt:2,input,steps});
    const kept=failedStep(saveStep(started,"prepare-0","run-mask","out-prepare"),"edit");
    expect(kept.attempt).toBe(3);
    expect(kept.outputs).toEqual({"prepare-0":"out-prepare"});
    expect(kept.runIds).toEqual({"prepare-0":"run-mask"});
    expect(kept.requestId).not.toBe("req-5");
  });

  it("refuses a saved chain it cannot pick up, and never throws over storage",()=>{
    const good=beginChain({requestId:"req-6",attempt:1,input,steps});
    expect(parseChain(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(parseChain(null)).toBeNull();
    expect(parseChain({...good,version:2})).toBeNull();
    expect(parseChain({...good,requestId:""})).toBeNull();
    expect(parseChain({...good,steps:[]})).toBeNull();
    expect(parseChain({...good,input:{...input,video:""}})).toBeNull();
    expect(parseChain({...good,input:{video:"vid",prompt:"",faces:[{asset:"face1",index:-1}]}})).toBeNull();
    expect(parseChain({...good,runIds:{"prepare-0":7}})).toBeNull();
    expect(parseChain({...good,stepIndex:9})).toBeNull();
    // The open step follows the outputs that exist, whatever index the file claims.
    expect(parseChain({...good,stepIndex:0,outputs:{"prepare-0":"out-prepare"}})?.stepIndex).toBe(1);

    const blocked={getItem:()=>{throw new Error("blocked");},setItem:()=>{throw new Error("blocked");},removeItem:()=>{throw new Error("blocked");}};
    const storage=memory();
    storage.setItem(key,"not json");
    expect(readChain(storage,key)).toBeNull();
    // A chain with every step done has nothing to pick up.
    saveChain(storage,key,saveStep(saveStep(good,"prepare-0","run-1","out-1"),"replace-0","run-2","out-2"));
    expect(readChain(storage,key)).toBeNull();
    expect(readChain(blocked,key)).toBeNull();
    expect(()=>saveChain(blocked,key,good)).not.toThrow();
    expect(()=>clearChain(blocked,key)).not.toThrow();
    expect(readChain(null,key)).toBeNull();
  });
});
