import {describe,expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {
  expectedMotionOutput,motionRecoveryAction,postMotionPrompt,prepareMotionRun,
  type MotionLedgerStore,type MotionPreparationRow,type MotionSourceIdentity,
} from "../server/motion-execution";
import {MOTION_NORMALIZATION,type MotionMediaReceipt} from "../server/motion-media";
import {HttpError} from "../server/auth";

const digest=(char:string)=>char.repeat(64);
const key=()=>`${randomUUID()}/${randomUUID()}`;
function receipt(workspaceId:string,sourceKey:string,sourceSha256=digest("a")):MotionMediaReceipt{
  return {
    schema:"comfyfield/motion-media-receipt",version:1,workspaceId,sourceKey,sourceSha256,sourceBytes:100,
    normalizedKey:key(),normalizedSha256:digest("b"),normalizedBytes:80,width:160,height:96,
    decodedFrameCount:24,fps:24,rFrameRate:"24/1",avgFrameRate:"24/1",timeBase:"1/12288",
    durationSeconds:1,durationRational:{numerator:24,denominator:24},durationMicroseconds:1_000_000,
    startTimeSeconds:0,firstFramePtsMicroseconds:0,sampleAspectRatio:"1:1",rotationDegrees:0,
    hasAudio:false,streamCount:1,codec:"h264",container:"mp4",containerFormatName:"mov,mp4",
    pixelFormat:"yuv420p",timingDigest:digest("c"),normalizationVersion:1,normalization:MOTION_NORMALIZATION,
    ffmpegVersion:"ffmpeg fixture",ffprobeVersion:"ffprobe fixture",
  };
}

class MemoryLedger implements MotionLedgerStore{
  row?:MotionPreparationRow;
  run="pending";
  constructor(readonly workspaceId:string,readonly runId:string,readonly source:MotionSourceIdentity,prepared?:MotionMediaReceipt){
    this.row={workspaceId,runId,state:prepared?"prepared":"pending",normalizationVersion:1,
      sourceAssetId:source.assetId,sourceStorageKey:source.storageKey,sourceSha256:source.sha256,sourceBytes:source.bytes,
      normalizedStorageKey:prepared?.normalizedKey??null,normalizedSha256:prepared?.normalizedSha256??null,
      normalizedBytes:prepared?.normalizedBytes??null,receipt:prepared??null,graphDigest:null,postAttemptedAt:null,
      attempt:0,leaseOwner:null,leaseExpiresAt:null,error:null};
  }
  async ensure(){return structuredClone(this.row!);}
  async get(){return this.row?structuredClone(this.row):undefined;}
  async runState(){return this.run;}
  async claim(_w:string,_r:string,token:string,expires:Date){
    if(this.row?.state!=="pending")return undefined;
    Object.assign(this.row,{state:"preparing",leaseOwner:token,leaseExpiresAt:expires.toISOString(),attempt:this.row.attempt+1});
    return structuredClone(this.row);
  }
  async publishPrepared(_w:string,_r:string,token:string,value:MotionMediaReceipt){
    if(this.run!=="pending")return "canceled" as const;
    if(this.row?.state!=="preparing"||this.row.leaseOwner!==token)return "lost" as const;
    Object.assign(this.row,{state:"prepared",receipt:value,normalizedStorageKey:value.normalizedKey,
      normalizedSha256:value.normalizedSha256,normalizedBytes:value.normalizedBytes,leaseOwner:null,leaseExpiresAt:null});
    return "published" as const;
  }
  async resetPending(_w:string,_r:string,error:string,token?:string){if(token&&this.row?.leaseOwner!==token)return;Object.assign(this.row!,{state:"pending",receipt:null,normalizedStorageKey:null,error,leaseOwner:null,leaseExpiresAt:null});}
  async markFailed(_w:string,_r:string,error:string,token?:string){if(token&&this.row?.leaseOwner!==token)return false;Object.assign(this.row!,{state:"failed",error});return true;}
  async markCanceled(){this.row!.state="canceled";}
  async commitGraphAndMarkPost(_w:string,_r:string,_graph:any,digestValue:string){
    if(this.run==="canceled"||this.run==="cancel_requested")return "canceled" as const;
    if(this.row?.postAttemptedAt)return "already" as const;
    if(this.row?.state!=="prepared")return "not_prepared" as const;
    Object.assign(this.row,{state:"submitted",graphDigest:digestValue,postAttemptedAt:new Date().toISOString()});
    return "marked" as const;
  }
  async resetSubmittingToPending(_workspaceId?:string,_runId?:string){if(motionRecoveryAction(this.run,this.row)==="reset_to_pending"){this.run="pending";return true;}return false;}
  async finalizePrePostCancellation(_workspaceId?:string,_runId?:string){
    if(motionRecoveryAction(this.run,this.row)!=="cancel_pre_post")return undefined;
    this.run="canceled";this.row!.state="canceled";return this.row!.normalizedStorageKey;
  }
}

function harness(prepared=false){
  const workspaceId=randomUUID(),runId=randomUUID(),source={assetId:randomUUID(),storageKey:key(),sha256:digest("a"),bytes:100};
  const frozen=receipt(workspaceId,source.storageKey,source.sha256);
  const ledger=new MemoryLedger(workspaceId,runId,source,prepared?frozen:undefined);
  const removed:string[]=[];
  const store={file:vi.fn(async()=>"owned-source.mp4"),remove:vi.fn(async(_w:string,k:string)=>{removed.push(k);})} as any;
  const deps={hashFile:vi.fn(async()=>source.sha256),normalize:vi.fn(async()=>frozen),verify:vi.fn(async()=>({}))} as any;
  return {workspaceId,runId,source,frozen,ledger,store,deps,removed};
}

describe("durable motion execution boundary",()=>{
  it("normalizes once, persists the receipt, and reuses only after revalidation",async()=>{
    const h=harness();
    expect((await prepareMotionRun({...h})).kind).toBe("prepared");
    expect(h.deps.normalize).toHaveBeenCalledTimes(1);
    expect(h.ledger.row?.state).toBe("prepared");
    expect((await prepareMotionRun({...h})).kind).toBe("prepared");
    expect(h.deps.normalize).toHaveBeenCalledTimes(1);
    expect(h.deps.verify).toHaveBeenCalledTimes(2);
  });

  it("allows only one concurrent preparation claim",async()=>{
    const h=harness();
    let release!:()=>void;
    h.deps.normalize.mockImplementation(()=>new Promise(resolve=>{release=()=>resolve(h.frozen);}));
    const first=prepareMotionRun({...h});
    await vi.waitFor(()=>expect(h.ledger.row?.state).toBe("preparing"));
    await expect(prepareMotionRun({...h})).resolves.toMatchObject({kind:"busy"});
    release();
    await expect(first).resolves.toMatchObject({kind:"prepared"});
    expect(h.deps.normalize).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation before preparation and removes a prepared candidate",async()=>{
    const h=harness(true);h.ledger.run="cancel_requested";
    await expect(prepareMotionRun({...h})).resolves.toMatchObject({kind:"canceled"});
    expect(h.removed).toEqual([h.frozen.normalizedKey]);
    expect(h.ledger.row?.state).toBe("canceled");
  });

  it("rejects a changed source before normalization",async()=>{
    const h=harness();h.deps.hashFile.mockResolvedValue(digest("f"));
    await expect(prepareMotionRun({...h})).resolves.toMatchObject({kind:"failed"});
    expect(h.deps.normalize).not.toHaveBeenCalled();
    expect(h.ledger.row?.state).toBe("failed");
  });

  it("marks the POST durably before calling transport and never posts twice",async()=>{
    const h=harness(true),order:string[]=[];
    const original=h.ledger.commitGraphAndMarkPost.bind(h.ledger);
    h.ledger.commitGraphAndMarkPost=async(...args)=>{const result=await original(...args);order.push("marked");return result;};
    const post=vi.fn(async()=>{order.push("post");throw new Error("connection lost after send");});
    await expect(postMotionPrompt(h.ledger,h.workspaceId,h.runId,{} as any,digest("d"),post)).rejects.toThrow();
    expect(order).toEqual(["marked","post"]);
    const second=vi.fn();
    await expect(postMotionPrompt(h.ledger,h.workspaceId,h.runId,{} as any,digest("d"),second)).resolves.toEqual({kind:"blocked",reason:"already"});
    expect(second).not.toHaveBeenCalled();
  });

  it("recovers only a pre-POST submitting run",async()=>{
    const h=harness(true);h.ledger.run="submitting";
    expect(motionRecoveryAction("submitting",h.ledger.row)).toBe("reset_to_pending");
    expect(await h.ledger.resetSubmittingToPending(h.workspaceId,h.runId)).toBe(true);
    h.ledger.run="submitting";Object.assign(h.ledger.row!,{state:"submitted",postAttemptedAt:new Date().toISOString()});
    expect(motionRecoveryAction("submitting",h.ledger.row)).toBe("none");
    expect(await h.ledger.resetSubmittingToPending(h.workspaceId,h.runId)).toBe(false);
  });

  it("finalizes a restarted pre-POST cancellation without looking for a remote job",async()=>{
    const h=harness(true);h.ledger.run="cancel_requested";
    expect(motionRecoveryAction(h.ledger.run,h.ledger.row)).toBe("cancel_pre_post");
    await expect(h.ledger.finalizePrePostCancellation(h.workspaceId,h.runId)).resolves.toBe(h.frozen.normalizedKey);
    expect(h.ledger.run).toBe("canceled");
    expect(h.ledger.row?.state).toBe("canceled");
  });

  it("does not let an expired preparation owner reset its replacement",async()=>{
    const h=harness();
    await h.ledger.claim(h.workspaceId,h.runId,"old",new Date());
    Object.assign(h.ledger.row!,{leaseOwner:"replacement",leaseExpiresAt:new Date(Date.now()+10_000).toISOString()});
    await h.ledger.resetPending(h.workspaceId,h.runId,"late old failure","old");
    expect(h.ledger.row).toMatchObject({state:"preparing",leaseOwner:"replacement"});
    await h.ledger.markFailed(h.workspaceId,h.runId,"late old permanent failure","old");
    expect(h.ledger.row).toMatchObject({state:"preparing",leaseOwner:"replacement"});
  });

  it("does not let an expired owner's permanent error fail the replacement run",async()=>{
    const h=harness();let rejectOld!:(error:Error)=>void;
    h.deps.normalize.mockImplementation(()=>new Promise((_resolve,reject)=>{rejectOld=reject;}));
    const old=prepareMotionRun({...h});
    await vi.waitFor(()=>expect(h.ledger.row?.leaseOwner).toBeTruthy());
    Object.assign(h.ledger.row!,{leaseOwner:"replacement",leaseExpiresAt:new Date(Date.now()+10_000).toISOString()});
    rejectOld(new HttpError(422,"old owner permanent error"));
    await expect(old).resolves.toEqual({kind:"busy"});
    expect(h.ledger.row).toMatchObject({state:"preparing",leaseOwner:"replacement"});
  });

  it("expects Wan's 16-pixel latent grid rather than the nominal portrait size",()=>{
    const manifest={controls:[{id:"width",default:482},{id:"height",default:854}]} as never;
    const invocation={controls:{width:482,height:854}} as never;
    const source=receipt("00000000-0000-4000-8000-000000000001","workspace/source.mp4");
    expect(expectedMotionOutput(manifest,invocation,source)).toMatchObject({width:480,height:848});
  });
});
