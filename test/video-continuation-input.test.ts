import {beforeEach,describe,expect,it,vi} from "vitest";
import type {DiskStore} from "../server/storage";
import {planVideoExtension,type VideoSourceEnvelope} from "../server/video-extension-plan";
import {admitVideoContinuation,continuationSourceIssues} from "../server/video-continuation-input";
import {inspectVideoSource} from "../server/video-extension-media";

vi.mock("../server/video-extension-media",()=>({inspectVideoSource:vi.fn()}));
const asset={id:"11111111-1111-4111-8111-111111111111",project_id:"22222222-2222-4222-8222-222222222222",storage_key:"fixture",sha256:"a".repeat(64)};
const source:VideoSourceEnvelope={validationVersion:1,sourceAssetId:asset.id,projectId:asset.project_id,sha256:asset.sha256,bytes:100,width:512,height:320,frameRate:{numerator:16,denominator:1},frameCount:17,timestampDigest:"b".repeat(64),hasAudio:false,durationSeconds:17/16,audioSeconds:null,container:"mov,mp4",videoCodec:"h264",ffmpegVersion:"fixture",ffprobeVersion:"fixture"};
const store={file:vi.fn(async()=>"fixture.mp4")} as unknown as DiskStore;
const plan=()=>planVideoExtension({contractVersion:1,projectId:asset.project_id,sourceAssetId:asset.id,startFrame:0,endFrameExclusive:17,extensionFrames:8,overlapFrames:5,audioPolicy:"mute"},source);
const controls=()=>{const c=plan().continuation!;return {generation_frames:c.generationFrames,overlap_frames:c.overlapFrames,context_start_frame:c.contextStartFrame};};
beforeEach(()=>{vi.mocked(inspectVideoSource).mockResolvedValue(source);});
describe("planned native continuation admission",()=>{
  it("admits only the same inspected bytes and server-derived frame context",async()=>{
    await expect(admitVideoContinuation(asset,"workspace",store,controls(),plan())).resolves.toEqual(source);
    for(const key of Object.keys(controls()))await expect(admitVideoContinuation(asset,"workspace",store,{...controls(),[key]:999},plan())).rejects.toThrow("context controls");
  });
  it("rejects changed source bytes and timestamp/frame facts",async()=>{
    for(const change of [{sha256:"c".repeat(64)},{timestampDigest:"d".repeat(64)},{frameCount:16}]){
      vi.mocked(inspectVideoSource).mockResolvedValue({...source,...change});
      await expect(admitVideoContinuation(asset,"workspace",store,controls(),plan())).rejects.toThrow("source video changed");
    }
  });
  it("rejects foreign source identity and the full-loader memory envelope",async()=>{
    await expect(admitVideoContinuation({...asset,project_id:"other"},"workspace",store,controls(),plan())).rejects.toThrow("source plan");
    for(const change of [{frameCount:162},{width:1024},{height:321},{frameRate:{numerator:24,denominator:1}}])expect(continuationSourceIssues({...source,...change})).not.toEqual([]);
  });
});
