import {describe,it,expect,vi} from "vitest";
import {PosePreviewClient,poseRequestKey,type PoseBinding} from "../src/team/performance/pose-preview";
import {ApiError,type Call} from "../src/team/api";
import poseFixture from "../src/ds/fixtures/pose-preview.json";
const uuid=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const binding:PoseBinding={userId:uuid(1),workspaceId:uuid(2),projectId:uuid(3),workerId:uuid(4),sourceAssetId:uuid(5),sourceSha256:"a".repeat(64)};
function storage(){const data=new Map<string,string>();return {getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};}
function status(id:string,state="pending"){return {id,project_id:binding.projectId,worker_id:binding.workerId,source_asset_id:binding.sourceAssetId,source_sha256:binding.sourceSha256,state,run_id:null,error:null,frames:state==="succeeded"?[{assetId:uuid(20),previewId:id,sourceAssetId:binding.sourceAssetId,sourceSha256:binding.sourceSha256,frameIndex:0,seconds:0,pose:poseFixture.frames[0].pose}]:[]};}
describe("source-bound pose preview recovery",()=>{
  it("persists before POST and reuses an active request instead of creating another",async()=>{
    const store=storage(),requestId=uuid(10),call=vi.fn(async(_path:string,method?:string)=>{expect(JSON.parse(store.getItem(poseRequestKey(binding))!).requestId).toBe(requestId);return status(requestId,method==="POST"?"pending":"queued");}),next=vi.fn(()=>requestId),client=new PosePreviewClient(binding,call as Call,store,next);
    expect((await client.start())?.state).toBe("pending");expect((await client.start())?.state).toBe("queued");expect(next).toHaveBeenCalledTimes(1);expect(call.mock.calls.map(call=>call[1])).toEqual(["POST","GET"]);
  });
  it("recovers a lost POST response after reload with GET and no new submission",async()=>{
    const store=storage(),id=uuid(10),call=vi.fn(async()=>{throw new ApiError(503,"response lost");});await expect(new PosePreviewClient(binding,call as Call,store,()=>id).start()).rejects.toThrow("response lost");
    const recovered=vi.fn(async()=>status(id,"queued"));expect((await new PosePreviewClient(binding,recovered as Call,store).recover())?.state).toBe("queued");expect(recovered.mock.calls).toHaveLength(1);
  });
  it("replays an unaccepted durable intent with its original UUID only after GET 404",async()=>{
    const store=storage(),id=uuid(10),first=vi.fn(async()=>{throw Error("offline");});await expect(new PosePreviewClient(binding,first as Call,store,()=>id).start()).rejects.toThrow();
    const call=vi.fn(async(_path:string,method?:string,body?:unknown)=>{if(method==="GET")throw new ApiError(404,"not accepted");expect(body).toMatchObject({requestId:id,sourceAssetId:binding.sourceAssetId});return status(id);});await new PosePreviewClient(binding,call as Call,store).recover();expect(call.mock.calls.map(call=>call[1])).toEqual(["GET","POST"]);
    const unavailable=vi.fn(async()=>{throw new ApiError(503,"offline");});await expect(new PosePreviewClient(binding,unavailable as Call,store).recover()).rejects.toThrow("offline");expect(unavailable).toHaveBeenCalledTimes(1);
  });
  it("does not submit when intent cannot be stored or recovered",async()=>{
    const call=vi.fn(),store={getItem:()=>null,setItem:()=>{throw Error("quota");}};await expect(new PosePreviewClient(binding,call as Call,store).start()).rejects.toThrow("quota");expect(call).not.toHaveBeenCalled();
    const corrupt=storage();corrupt.setItem(poseRequestKey(binding),"broken");await expect(new PosePreviewClient(binding,call as Call,corrupt).start()).rejects.toThrow("could not be recovered");expect(call).not.toHaveBeenCalled();
  });
  it("separates clip hashes, worker, user, workspace and project scopes",async()=>{
    const store=storage(),id=uuid(10);await new PosePreviewClient(binding,(async()=>status(id)) as Call,store,()=>id).start();
    for(const change of [{sourceSha256:"b".repeat(64)},{sourceAssetId:uuid(30)},{workerId:uuid(31)},{userId:uuid(32)},{workspaceId:uuid(33)},{projectId:uuid(34)}]){const call=vi.fn();expect(await new PosePreviewClient({...binding,...change},call as Call,store).recover()).toBeNull();expect(call).not.toHaveBeenCalled();}
  });
  it("rejects mismatched scope, timing or malformed poses instead of displaying them",async()=>{
    const id=uuid(10);for(const mutate of [(value:any)=>{value.source_sha256="b".repeat(64);},(value:any)=>{value.worker_id=uuid(30);},(value:any)=>{value.frames[0].seconds=.4;},(value:any)=>{value.frames[0].pose={canvas_width:32,canvas_height:32,people:[{}]};}]){const value=status(id,"succeeded");mutate(value);await expect(new PosePreviewClient(binding,(async()=>value) as Call,storage(),()=>id).start()).rejects.toThrow();}
  });
  it("creates a new UUID only for a deliberate new preview after a terminal result",async()=>{
    const store=storage(),ids=[uuid(10),uuid(11)],next=vi.fn(()=>ids.shift()!),call=vi.fn(async(_path:string,_method?:string,body?:any)=>status(body.requestId,"succeeded")),client=new PosePreviewClient(binding,call as Call,store,next);expect((await client.start())?.frames).toHaveLength(1);await client.start();expect(next).toHaveBeenCalledTimes(2);expect(call.mock.calls.map(call=>call[2].requestId)).toEqual([uuid(10),uuid(11)]);
  });
  it("ignores an aborted late response while keeping the original durable identity",async()=>{
    const store=storage(),id=uuid(10),controller=new AbortController();let resolve!:(value:unknown)=>void;const pending=new Promise(resolveValue=>{resolve=resolveValue;});const client=new PosePreviewClient(binding,(()=>pending) as Call,store,()=>id),request=client.start(controller.signal);controller.abort();resolve(status(id,"succeeded"));await expect(request).rejects.toMatchObject({name:"AbortError"});expect(JSON.parse(store.getItem(poseRequestKey(binding))!).requestId).toBe(id);
  });
});
