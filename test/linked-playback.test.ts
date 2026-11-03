import {describe,it,expect,vi} from "vitest";
import {linkMediaPlayback} from "../src/ds/linked-playback";

class Media extends EventTarget{
  duration=10;paused=true;seeking=false;private time=0;
  get currentTime(){return this.time;}
  set currentTime(value:number){this.time=value;queueMicrotask(()=>this.dispatchEvent(new Event("seeking")));}
  play=vi.fn(async()=>{if(this.paused){this.paused=false;queueMicrotask(()=>this.dispatchEvent(new Event("play")));}});
  pause=vi.fn(()=>{if(!this.paused){this.paused=true;queueMicrotask(()=>this.dispatchEvent(new Event("pause")));}});
  element(){return this as unknown as HTMLMediaElement;}
}
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
describe("linked media comparison",()=>{
  it("ignores queued play events after a quick user pause",async()=>{
    const left=new Media(),right=new Media(),dispose=linkMediaPlayback(left.element(),right.element());
    void left.play();left.pause();await settle();
    expect(left.paused).toBe(true);expect(right.paused).toBe(true);expect(right.play).not.toHaveBeenCalled();
    dispose();
  });
  it("links play, pause and seeking from either player without echoing seeks or repeated play",async()=>{
    const left=new Media(),right=new Media(),dispose=linkMediaPlayback(left.element(),right.element());
    left.currentTime=2;await left.play();await settle();expect(right.currentTime).toBe(2);expect(right.paused).toBe(false);
    right.currentTime=4;await settle();expect(left.currentTime).toBe(4);expect(right.currentTime).toBe(4);
    right.pause();await settle();expect(left.paused).toBe(true);expect(right.play).toHaveBeenCalledTimes(1);expect(left.play).toHaveBeenCalledTimes(1);
    dispose();left.currentTime=1;await left.play();await settle();expect(right.currentTime).toBe(4);expect(right.paused).toBe(true);
  });
  it("uses the shared duration and restarts both together after reaching its end",async()=>{
    const left=new Media(),right=new Media();right.duration=6;const dispose=linkMediaPlayback(left.element(),right.element());
    left.currentTime=8;await settle();expect(left.currentTime).toBe(6);expect(right.currentTime).toBe(6);
    await left.play();await settle();expect(left.currentTime).toBe(0);expect(right.currentTime).toBe(0);expect(right.paused).toBe(false);
    right.dispatchEvent(new Event("ended"));await settle();expect(left.paused).toBe(true);expect(right.paused).toBe(true);dispose();
  });
  it("waits for metadata and pauses the pair when browser playback is rejected",async()=>{
    const left=new Media(),right=new Media(),blocked=vi.fn();right.duration=NaN;
    const dispose=linkMediaPlayback(left.element(),right.element(),blocked);left.currentTime=3;await settle();expect(right.currentTime).toBe(0);
    right.duration=10;right.dispatchEvent(new Event("loadedmetadata"));await settle();expect(right.currentTime).toBe(3);
    right.play.mockRejectedValueOnce(new Error("NotAllowedError"));await left.play();await settle();expect(left.paused).toBe(true);expect(blocked).toHaveBeenCalledTimes(1);dispose();
  });
});
