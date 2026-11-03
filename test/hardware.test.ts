import {describe,it,expect} from "vitest";
import {assessHardware,parseWorkerHardware,gib} from "../src/capabilities/hardware";

const GiB=2**30;
describe("automatic setup assessment",()=>{
  it("uses one GPU's capacity and reported RAM, not aggregate GPU memory or model-file bytes",()=>{
    const hardware=parseWorkerHardware({system:{ram_total:64*GiB,ram_free:32*GiB},devices:[{name:"RTX4090",type:"cuda",vram_total:24*GiB,vram_free:20*GiB}]});
    expect(assessHardware(hardware).title).toContain("24 GB GPU");expect(gib(hardware.devices[0].vramTotal)).toBe("24.0 GiB");
    const multiple=parseWorkerHardware({system:{ram_total:64*GiB,ram_free:32*GiB},devices:[{type:"cuda",vram_total:12*GiB},{type:"cuda",vram_total:12*GiB}]});
    expect(assessHardware(multiple).title).toContain("unqualified");
  });
  it("does not treat missing, malformed or impossible counters as measured memory",()=>{
    const h=parseWorkerHardware({system:{ram_total:"64GB",ram_free:Infinity},devices:[{name:"GPU\u0000",type:"cuda",vram_total:24*GiB,vram_free:25*GiB}]});
    expect(h.ramTotal).toBeNull();expect(h.ramFree).toBeNull();expect(h.devices[0].vramFree).toBeNull();expect(h.devices[0].name).toBe("GPU");expect(assessHardware(h).tone).toBe("warn");expect(gib(null)).toBe("Not reported");
    expect(parseWorkerHardware(null).devices).toEqual([]);
  });
  it("warns about current pressure and does not call a CPU qualified for heavy video",()=>{
    const h=parseWorkerHardware({system:{ram_total:64*GiB,ram_free:2*GiB},devices:[{type:"cuda",vram_total:24*GiB}]});
    expect(assessHardware(h).title).toContain("pressure");
    h.ramFree=32*GiB;h.devices[0].type="cpu";expect(assessHardware(h).title).toContain("No qualified CUDA");
  });
  it("judges memory pressure against the share the server is configured to keep free",()=>{
    const stats={system:{ram_total:64*GiB,ram_free:7*GiB},devices:[{type:"cuda",vram_total:24*GiB}]};
    expect(assessHardware(parseWorkerHardware(stats)).title).toContain("pressure");
    const lowered=parseWorkerHardware(stats,0.05);
    expect(lowered.minFreeShare).toBe(0.05);
    expect(assessHardware(lowered).title).not.toContain("pressure");
    expect(assessHardware(parseWorkerHardware({system:{ram_total:64*GiB,ram_free:2*GiB},devices:[{type:"cuda",vram_total:24*GiB}]},0.05)).guidance).toContain("Less than 5%");
  });
});
