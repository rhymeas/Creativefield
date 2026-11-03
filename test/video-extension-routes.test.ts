import {describe,it,expect} from "vitest";
import {videoExtensionIntentSchema} from "../server/video-extension-plan";
import {requestSchema} from "../server/run-submission";

describe("video extension public contract",()=>{
  it("rejects seconds, backward direction and unknown public fields",()=>{
    const base={contractVersion:1,projectId:"11111111-1111-4111-8111-111111111111",sourceAssetId:"22222222-2222-4222-8222-222222222222",startFrame:0,endFrameExclusive:17,extensionFrames:4,overlapFrames:1};
    expect(videoExtensionIntentSchema.safeParse(base).success).toBe(true);
    expect(videoExtensionIntentSchema.parse({...base,audioPolicy:"preserve"}).audioPolicy).toBe("preserve");
    for(const invalid of [{...base,startSeconds:0},{...base,direction:"backward"},{...base,audioPolicy:"replace"}])expect(videoExtensionIntentSchema.safeParse(invalid).success).toBe(false);
  });
  it("does not depend on a forbidden runtime boundary",async()=>{
    const source=await import("node:fs/promises").then(fs=>fs.readFile(new URL("../server/video-extension-routes.ts",import.meta.url),"utf8"));
    expect(source).not.toMatch(/genjutsu|higgsfield|pryx/i);
  });
  it("reserves extension child idempotency keys from public runs",()=>{
    const run={projectId:"11111111-1111-4111-8111-111111111111",workerId:"22222222-2222-4222-8222-222222222222",idempotencyKey:"video-extension:parent:generate",capabilityId:"fixture",version:"1",routeId:"local",inputs:{},controls:{},audioPolicy:"mute"};
    expect(requestSchema.safeParse(run).success).toBe(false);expect(requestSchema.safeParse({...run,idempotencyKey:"public-request-1"}).success).toBe(true);
  });
  it("accepts only boolean consent receipts",()=>{
    const run={projectId:"11111111-1111-4111-8111-111111111111",workerId:"22222222-2222-4222-8222-222222222222",idempotencyKey:"public-request-1",capabilityId:"fixture",version:"1",routeId:"local",inputs:{},controls:{},audioPolicy:"mute"};
    expect(requestSchema.safeParse({...run,consent:{webcam:true}}).success).toBe(true);
    expect(requestSchema.safeParse({...run,consent:{webcam:"yes"}}).success).toBe(false);
    expect(requestSchema.safeParse({...run,consent:{unexpected:true}}).success).toBe(false);
  });
});
