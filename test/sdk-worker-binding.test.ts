import {afterEach,describe,expect,it,vi} from "vitest";
import {sdkTransportConfigured,sdkSupportsManifest} from "../server/sdk-client";
afterEach(()=>vi.unstubAllEnvs());
import type {CapabilityManifestV2} from "../src/capabilities/types";
describe("local SDK proxy worker binding",()=>{
  it("does not route a second worker through the first worker's proxy",()=>{
    vi.stubEnv("COMFY_SDK_BASE_URL","http://127.0.0.1:8189");vi.stubEnv("COMFY_SDK_WORKER_ORIGIN","");
    expect(sdkTransportConfigured("http://127.0.0.1:8188")).toBe(true);
    expect(sdkTransportConfigured("http://127.0.0.1:8190")).toBe(false);
    expect(sdkTransportConfigured("http://foreign.test:8188")).toBe(false);
  });
  it("admits ordinary videos while keeping typed native contracts isolated",()=>{
    const base={outputs:[{required:true,type:"video"}]} as CapabilityManifestV2;
    expect(sdkSupportsManifest(base)).toBe(true);
    for(const key of ["motionContract","mediaContract","imageInputContract","imageArtifacts","outputContract"])expect(sdkSupportsManifest({...base,[key]:{kind:"fixture"}})).toBe(false);
    expect(sdkSupportsManifest({outputs:[{required:true,type:"audio"}]} as CapabilityManifestV2)).toBe(false);
  });
  it("accepts an explicit matching binding and fails closed on invalid configuration",()=>{
    vi.stubEnv("COMFY_SDK_BASE_URL","http://127.0.0.1:8191");vi.stubEnv("COMFY_SDK_WORKER_ORIGIN","http://127.0.0.1:8190");
    expect(sdkTransportConfigured("http://127.0.0.1:8190")).toBe(true);
    vi.stubEnv("COMFY_SDK_WORKER_ORIGIN","invalid");expect(sdkTransportConfigured("http://127.0.0.1:8190")).toBe(false);
    vi.stubEnv("COMFY_SDK_BASE_URL","");expect(sdkTransportConfigured()).toBe(false);
  });
});
