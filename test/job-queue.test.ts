import {afterEach,describe,expect,it,vi} from "vitest";
import {monitorJobQueue,jobQueueTitle,runLocation,type JobQueueSnapshot} from "../src/team/job-queue";
class Source extends EventTarget {closed=false;close(){this.closed=true;}emit(type:string,data?:unknown){this.dispatchEvent(Object.assign(new Event(type),{data:JSON.stringify(data)}));}}
const job={id:"10000000-0000-4000-8000-000000000001",project_id:"20000000-0000-4000-8000-000000000001",capability_id:"workflow",state:"running",created_at:"2026-10-22",updated_at:"2026-10-22"};
const payload={runs:[job],total:12,progress:{[job.id]:.25}};
afterEach(()=>vi.useRealTimers());
describe("aggregate job event connection",()=>{
  it("names internal pose jobs without exposing their batch variant",()=>{
    expect(jobQueueTitle("sdpose-preview-6",{})).toBe("Detect driving pose");expect(jobQueueTitle("sdpose-preview-1",{})).toBe("Detect driving pose");expect(jobQueueTitle("sdpose-preview-60",{})).toBe("Creative job");expect(jobQueueTitle("workflow",{workflow:"Camera move"})).toBe("Camera move");
  });
  it("says where a run happened in plain words",()=>{
    expect(runLocation('chatgpt',false)).toBe('ChatGPT');expect(jobQueueTitle('chatgpt-image-edit',{})).toBe('ChatGPT image edit');
    expect(runLocation("sdk",true)).toBe("Comfy Cloud");expect(runLocation(undefined,true)).toBe("Comfy Cloud");expect(runLocation("sdk",false)).toBe("SDK proxy");expect(runLocation("native",false)).toBe("Local ComfyUI");expect(runLocation(undefined,false)).toBe("Local ComfyUI");
  });
  function setup(){const sources:Source[]=[],states:JobQueueSnapshot[]=[];const create=vi.fn(()=>{const source=new Source();sources.push(source);return source;});const monitor=monitorJobQueue("workspace",state=>states.push(state),create);return {sources,states,create,monitor};}
  it("uses one same-origin connection and preserves total beyond visible rows",()=>{
    const {sources,states,create,monitor}=setup();monitor.refresh();monitor.refresh();expect(create).toHaveBeenCalledTimes(1);expect(create).toHaveBeenCalledWith("/api/v1/workspaces/workspace/jobs/stream");sources[0].emit("jobs",payload);expect(states.at(-1)).toMatchObject({...payload,loading:false,error:false});monitor.dispose();
  });
  it("closes while hidden, ignores late events and reconnects when visible",()=>{
    const {sources,states,create,monitor}=setup();monitor.refresh();monitor.setVisible(false);expect(sources[0].closed).toBe(true);const count=states.length;sources[0].emit("jobs",payload);expect(states).toHaveLength(count);monitor.setVisible(true);expect(create).toHaveBeenCalledTimes(2);sources[1].emit("jobs",payload);expect(states.at(-1)?.total).toBe(12);monitor.dispose();
  });
  it("bounds disconnect retries and allows an explicit retry",async()=>{
    vi.useFakeTimers();const {sources,states,create,monitor}=setup();monitor.refresh();sources[0].emit("error");await vi.advanceTimersByTimeAsync(1000);sources[1].emit("error");await vi.advanceTimersByTimeAsync(5000);sources[2].emit("error");await vi.advanceTimersByTimeAsync(60000);expect(create).toHaveBeenCalledTimes(3);expect(states.at(-1)?.error).toBe(true);expect(sources.every(source=>source.closed)).toBe(true);monitor.refresh();expect(create).toHaveBeenCalledTimes(4);monitor.dispose();
  });
  it("clears data on revoked access without automatic reconnect",async()=>{
    vi.useFakeTimers();const {sources,states,create,monitor}=setup();monitor.refresh();sources[0].emit("jobs",payload);sources[0].emit("access-denied",{});await vi.advanceTimersByTimeAsync(60000);expect(create).toHaveBeenCalledTimes(1);expect(states.at(-1)).toMatchObject({total:0,runs:[],error:true});monitor.dispose();
  });
  it("does not reset its retry budget on a frame followed by an immediate disconnect",async()=>{
    vi.useFakeTimers();const {sources,states,create,monitor}=setup();monitor.refresh();
    for(let i=0;i<3;i++){sources[i].emit("jobs",payload);sources[i].emit("error");await vi.advanceTimersByTimeAsync(i===0?1000:i===1?5000:60000);}
    expect(create).toHaveBeenCalledTimes(3);expect(states.at(-1)?.error).toBe(true);monitor.dispose();
  });
  it("rejects malformed/foreign progress and never exposes event payload errors",()=>{
    const {sources,states,monitor}=setup();monitor.refresh();sources[0].emit("jobs",{...payload,progress:{foreign:1}});expect(sources[0].closed).toBe(true);expect(states.at(-1)?.runs).toEqual([]);expect(JSON.stringify(states)).not.toContain("foreign");monitor.dispose();
  });
  it("carries pose preparation rows before their child run exists",()=>{
    const {sources,states,monitor}=setup();monitor.refresh();const preparation={id:"30000000-0000-4000-8000-000000000001",project_id:job.project_id,state:"preparing",created_at:"2026-10-22",updated_at:"2026-10-22",source_name:"portrait.png"};sources[0].emit("jobs",{runs:[job],preparations:[preparation],total:13,progress:{[job.id]:.25}});expect(states.at(-1)?.preparations).toEqual([preparation]);expect(states.at(-1)?.total).toBe(13);monitor.dispose();
  });
  it("cancels retries and ignores all events after disposal",async()=>{
    vi.useFakeTimers();const {sources,states,create,monitor}=setup();monitor.refresh();sources[0].emit("error");monitor.dispose();const count=states.length;await vi.advanceTimersByTimeAsync(60000);sources[0].emit("jobs",payload);expect(create).toHaveBeenCalledTimes(1);expect(states).toHaveLength(count);
  });
});
