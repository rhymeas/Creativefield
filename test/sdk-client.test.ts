import {readFileSync} from "node:fs";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {CapabilityManifestV2} from "../src/capabilities/types";
import type {ApiGraph} from "../src/workflow/build";

/* No Cloud call: the SDK class is replaced so only what we hand it is recorded. */
const seen=vi.hoisted(()=>({clients:[] as Array<{options:Record<string,unknown>;base:string|undefined}>}));
vi.mock("@comfyorg/sdk",()=>({
  Comfy: class { constructor(options:Record<string,unknown>){ seen.clients.push({options,base:process.env.COMFY_BASE_URL}); } },
}));

const cloud="https://cloud.comfy.org";
/** A fresh module per test, so the client cache and its environment reads start empty. */
async function load(){vi.resetModules();return import("../server/sdk-client");}

beforeEach(()=>{
  seen.clients=[];
  vi.stubEnv("COMFY_SDK_BASE_URL","");vi.stubEnv("COMFY_SDK_WORKER_ORIGIN","");vi.stubEnv("COMFY_CLOUD_API_KEY","");vi.stubEnv("COMFY_CLOUD_API_KEY_FILE","");
  vi.stubEnv("COMFY_BASE_URL","http://keep.test");
});
afterEach(()=>vi.unstubAllEnvs());

describe("one SDK client per worker",()=>{
  it("gives a Cloud worker the Cloud base and the key from the environment",async()=>{
    vi.stubEnv("COMFY_CLOUD_API_KEY","fake-cloud-key");
    vi.stubEnv("COMFY_SDK_BASE_URL","http://127.0.0.1:8189");
    const {sdkClient,sdkTransportConfigured}=await load();
    expect(sdkTransportConfigured({origin:cloud,kind:"cloud"})).toBe(true);
    sdkClient({origin:cloud,kind:"cloud"});
    expect(seen.clients).toEqual([{options:{clientInfo:"ComfyField",apiKey:"fake-cloud-key"},base:cloud}]);
    expect(process.env.COMFY_BASE_URL).toBe("http://keep.test");
  });
  it("keeps a Cloud worker on the native path without a key",async()=>{
    const {sdkClient,sdkTransportConfigured}=await load();
    expect(sdkTransportConfigured({origin:cloud,kind:"cloud"})).toBe(false);
    expect(()=>sdkClient({origin:cloud,kind:"cloud"})).toThrow("COMFY_CLOUD_API_KEY");
    expect(seen.clients).toHaveLength(0);
  });
  it("leaves a local worker on the old proxy base with no key",async()=>{
    vi.stubEnv("COMFY_SDK_BASE_URL","http://127.0.0.1:8189");
    vi.stubEnv("COMFY_CLOUD_API_KEY","fake-cloud-key");
    const {sdkClient,sdkTransportConfigured}=await load();
    expect(sdkTransportConfigured({origin:"http://127.0.0.1:8188",kind:"local"})).toBe(true);
    expect(sdkClient({origin:"http://127.0.0.1:8188",kind:"local"})).toBe(sdkClient());
    expect(seen.clients).toEqual([{options:{clientInfo:"ComfyField"},base:"http://127.0.0.1:8189"}]);
  });
  it("reuses a client for one base and key and builds another when the key changes",async()=>{
    vi.stubEnv("COMFY_CLOUD_API_KEY","key-one");
    const {sdkClient}=await load();
    const first=sdkClient({origin:cloud,kind:"cloud"});
    expect(sdkClient({origin:cloud,kind:"cloud"})).toBe(first);
    vi.stubEnv("COMFY_CLOUD_API_KEY","key-two");
    expect(sdkClient({origin:cloud,kind:"cloud"})).not.toBe(first);
    expect(seen.clients.map(client=>client.options.apiKey)).toEqual(["key-one","key-two"]);
  });
});

const scailRoot="native-workflows/scail2-character-replace";
const scailManifest=JSON.parse(readFileSync(`${scailRoot}/manifest.json`,"utf8")) as CapabilityManifestV2;
const scailTemplate=JSON.parse(readFileSync(`${scailRoot}/template.api.json`,"utf8")) as ApiGraph;

describe("replace character never takes the SDK path",()=>{
  it("declares the chunk contract on the source clip and the video artifact",()=>{
    const contract=scailManifest.replaceContract;
    expect(contract).toEqual({kind:"scail_replace_chunks_v1",sourceInput:"source_video",artifactNode:"202"});
    expect(scailManifest.inputs.find(input=>input.id===contract?.sourceInput)?.type).toBe("video");
    // The chunk compile pads and crops around this node, so it has to be the file that gets published.
    expect(scailTemplate[contract?.artifactNode ?? ""].class_type).toBe("SaveVideo");
  });
  it("keeps the manifest off the SDK path even when the SDK is configured",async()=>{
    vi.stubEnv("COMFY_SDK_BASE_URL","http://127.0.0.1:8189");vi.stubEnv("COMFY_CLOUD_API_KEY","fake-cloud-key");
    const {sdkSupportsManifest,sdkTransportConfigured}=await load();
    expect(sdkTransportConfigured({origin:"http://127.0.0.1:8188",kind:"local"})).toBe(true);
    expect(sdkSupportsManifest(scailManifest)).toBe(false);
  });
  it("would let the same manifest through without the declaration",async()=>{
    const {sdkSupportsManifest}=await load();
    const without=structuredClone(scailManifest);
    delete without.replaceContract;
    // Nothing else in this pack excludes it, so this one contract is the whole guard.
    expect(sdkSupportsManifest(without)).toBe(true);
  });
});
