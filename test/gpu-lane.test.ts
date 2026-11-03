import {describe,expect,it,vi} from "vitest";
import {familyChanged,gpuLaneEnabled,laneDecision,localQueueState,modelFamily,onThisComputer} from "../server/gpu-lane";
import {ExecutionService} from "../server/execution";

describe("GPU lane",()=>{
  it("treats loopback local workers as sharing this computer's card",()=>{
    expect(onThisComputer({kind:"local",origin:"http://127.0.0.1:8288"})).toBe(true);
    expect(onThisComputer({kind:"local",origin:"http://localhost:8188"})).toBe(true);
    expect(onThisComputer({kind:"local",origin:"http://192.0.2.1:8188"})).toBe(false);
    expect(onThisComputer({kind:"cloud",origin:"https://cloud.comfy.org"})).toBe(false);
  });
  it("holds a run while another local ComfyUI is busy",()=>{
    expect(laneDecision("img",["img","h3"],["h3"],"h3")).toEqual({go:false});
  });
  it("detects jobs submitted directly to another ComfyUI",async()=>{
    const queue=(running:unknown[],pending:unknown[])=>async()=>new Response(JSON.stringify({queue_running:running,queue_pending:pending}),{status:200});
    expect(await localQueueState(queue([['other-job']],[]))).toBe('busy');
    expect(await localQueueState(queue([],[['other-job']]))).toBe('busy');
    expect(await localQueueState(queue([],[]))).toBe('idle');
    expect(await localQueueState(async()=>new Response('{}'))).toBe('busy');
    expect(await localQueueState(async()=>new Response('not json'))).toBe('busy');
    expect(await localQueueState(async()=>new Response('',{status:503}))).toBe('busy');
    expect(await localQueueState(async()=>{throw new Error('offline');})).toBe('unavailable');
  });
  it("waits instead of unloading a worker with an external ComfyUI job",async()=>{
    const workers=[{id:'image',origin:'http://127.0.0.1:8188',api_prefix:'',enabled:true},{id:'h3',origin:'http://127.0.0.1:8288',api_prefix:'',enabled:true}];
    const pool={query:vi.fn(async(sql:string)=>({rows:sql.includes('FROM workers')?workers:[]}))};
    const service=new ExecutionService(pool as never,{} as never,[]);
    const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({queue_running:[['external']],queue_pending:[]})));
    try{
      expect(await (service as any).gpuLaneOpen({id:'run',workspace_id:'workspace'},workers[0])).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0][0])).toBe('http://127.0.0.1:8288/queue');
      (service as any).gpuOwner=workers[0].origin;
      expect(await (service as any).gpuLaneOpen({id:'next-run',workspace_id:'workspace'},workers[0])).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }finally{fetcher.mockRestore();await service.close();}
  });
  it("lets runs queue on the ComfyUI that already holds the card",()=>{
    expect(laneDecision("h3",["img","h3"],["h3"],"h3")).toEqual({go:true,free:[]});
  });
  it("unloads the other ComfyUIs when the card changes hands",()=>{
    expect(laneDecision("img",["img","h3"],[],"h3")).toEqual({go:true,free:["h3"]});
    expect(laneDecision("img",["img","h3"],[],null)).toEqual({go:true,free:["h3"]});
  });
  it("runs only on one person's own computer, never on a shared server",()=>{
    expect(gpuLaneEnabled({LOCAL_SINGLE_USER:"1"})).toBe(true);
    expect(gpuLaneEnabled({})).toBe(false);
    expect(gpuLaneEnabled({LOCAL_SINGLE_USER:"0"})).toBe(false);
  });
});

describe("model-family loader",()=>{
  const pack=(id:string,model?:string)=>({id,routes:[{requirements:model?[{kind:"model",name:model,location:"diffusion_models"}]:[]}]});
  it("names a pack's family by its main diffusion model",()=>{
    expect(modelFamily(pack("h3-t2v","minimax_h3_fl2va_pruned_int8_convrot.safetensors"))).toBe("minimax_h3_fl2va_pruned_int8_convrot.safetensors");
    expect(modelFamily(pack("trim"))).toBe("trim");
  });
  it("unloads only when the family changes",()=>{
    expect(familyChanged(undefined,"a")).toBe(false);
    expect(familyChanged("a","a")).toBe(false);
    expect(familyChanged("a","b")).toBe(true);
  });
});
