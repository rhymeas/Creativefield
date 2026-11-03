import {afterEach,describe,it,expect,vi} from "vitest";
import {WorkspaceJobFeed} from "../server/job-feed";

afterEach(()=>vi.useRealTimers());
const snapshot={runs:[{id:"job"}],preparations:[],total:1,progress:{job:.5}};
function client(){return {authorize:vi.fn(async()=>{}),write:vi.fn((_data:string)=>true),close:vi.fn()};}
const settle=()=>vi.advanceTimersByTimeAsync(0);
describe("workspace job scheduler",()=>{
  it("shares one reader across tabs and stops after the last disconnect",async()=>{
    vi.useFakeTimers();const read=vi.fn(async()=>snapshot),feed=new WorkspaceJobFeed(read),a=client(),b=client();
    const offA=feed.subscribe("a",a),offB=feed.subscribe("a",b);await settle();expect(read).toHaveBeenCalledTimes(1);expect(a.write).toHaveBeenCalledTimes(1);expect(b.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);expect(read).toHaveBeenCalledTimes(2);expect(a.write).toHaveBeenCalledTimes(1);
    offA();offB();await vi.advanceTimersByTimeAsync(60000);expect(read).toHaveBeenCalledTimes(2);feed.close();
  });
  it("separates workspace snapshots and rechecks access before broadcast",async()=>{
    vi.useFakeTimers();const read=vi.fn(async(id:string)=>({...snapshot,runs:[{id}]})),feed=new WorkspaceJobFeed(read),a=client(),b=client();
    feed.subscribe("a",a);feed.subscribe("b",b);await settle();expect(a.write.mock.calls[0][0]).toContain('"id":"a"');expect(b.write.mock.calls[0][0]).toContain('"id":"b"');
    a.authorize.mockRejectedValue(new Error("revoked"));await vi.advanceTimersByTimeAsync(1000);expect(a.close).toHaveBeenCalledTimes(1);expect(a.write.mock.calls.at(-1)?.[0]).toContain("access-denied");expect(read.mock.calls.filter(([id])=>id==="a")).toHaveLength(1);feed.close();
  });
  it("closes slow consumers and exposes no backend error detail",async()=>{
    vi.useFakeTimers();const slow=client();slow.write.mockReturnValue(false);const feed=new WorkspaceJobFeed(async()=>snapshot);feed.subscribe("a",slow);await settle();expect(slow.close).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(60000);expect(slow.write).toHaveBeenCalledTimes(1);feed.close();
    const bad=client(),failed=new WorkspaceJobFeed(async()=>{throw new Error("secret SQL detail");});failed.subscribe("b",bad);await settle();expect(bad.close).toHaveBeenCalledTimes(1);expect(bad.write.mock.calls[0][0]).toContain("unavailable");expect(bad.write.mock.calls[0][0]).not.toContain("secret");failed.close();
  });
  it("rejects excess connections before scheduling and cleans shutdown timers",async()=>{
    vi.useFakeTimers();const read=vi.fn(async()=>snapshot),feed=new WorkspaceJobFeed(read);for(let i=0;i<16;i++)feed.subscribe("a",client());expect(()=>feed.subscribe("a",client())).toThrow(/Too many/);await settle();feed.close();const count=read.mock.calls.length;await vi.advanceTimersByTimeAsync(60000);expect(read).toHaveBeenCalledTimes(count);
  });
  it("checks an idle workspace slowly and sends a new subscriber its snapshot",async()=>{
    vi.useFakeTimers();const read=vi.fn(async()=>({runs:[],preparations:[],total:0,progress:{}})),feed=new WorkspaceJobFeed(read),a=client(),b=client();
    feed.subscribe("a",a);await settle();await vi.advanceTimersByTimeAsync(9999);expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(read).toHaveBeenCalledTimes(2);
    feed.subscribe("a",b);await settle();expect(b.write).toHaveBeenCalledTimes(1);expect(b.write.mock.calls[0][0]).toContain('"total":0');feed.close();
  });
});
