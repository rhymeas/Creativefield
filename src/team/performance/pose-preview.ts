import {z} from "zod";
import {readPoseFrames,type PosePreviewFrame} from "../../capabilities/pose-preview";
import {ApiError,workspacePath,type Call} from "../api";

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema=z.object({userId:z.uuid(),workspaceId:z.uuid(),projectId:z.uuid(),workerId:z.uuid(),sourceAssetId:z.uuid(),sourceSha256:digest}).strict();
const intentSchema=bindingSchema.extend({version:z.literal(1),requestId:z.uuid()}).strict();
export type PoseBinding=z.infer<typeof bindingSchema>;
type Intent=z.infer<typeof intentSchema>;
type ReceiptStore=Pick<Storage,"getItem"|"setItem">;
const frameSchema=z.object({assetId:z.uuid(),previewId:z.uuid(),sourceAssetId:z.uuid(),sourceSha256:digest,frameIndex:z.number().int().min(0).max(640),seconds:z.number().finite().min(0).max(27),pose:z.unknown()});
const statusSchema=z.object({id:z.uuid(),project_id:z.uuid(),worker_id:z.uuid(),source_asset_id:z.uuid(),source_sha256:digest,state:z.enum(["pending","preparing","prepared","queued","succeeded","failed","cancel_requested","canceled"]),run_id:z.uuid().nullable(),error:z.string().max(2000).nullable(),frames:z.array(frameSchema).max(6).default([])});
export type PoseStatus={state:z.infer<typeof statusSchema>["state"];runId:string|null;error:string|null;frames:PosePreviewFrame[]};
export const poseTerminal=(state:string)=>["succeeded","failed","canceled"].includes(state);
export function poseRequestKey(binding:PoseBinding){return `comfyfield:pose:${binding.userId}:${binding.workspaceId}:${binding.projectId}:${binding.workerId}:${binding.sourceAssetId}:${binding.sourceSha256}`;}
function sameBinding(a:PoseBinding,b:PoseBinding){return Object.keys(bindingSchema.shape).every(key=>a[key as keyof PoseBinding]===b[key as keyof PoseBinding]);}

/** Persists intent before POST. Recovery always uses the same UUID, including a
 * lost POST response or StrictMode unmount. No timer, model retry or global state. */
export class PosePreviewClient{
  private intent:Intent|null=null;
  private status:PoseStatus|null=null;
  constructor(readonly binding:PoseBinding,private call:Call,private store:ReceiptStore,private uuid:()=>string=()=>crypto.randomUUID()){bindingSchema.parse(binding);}
  hasRequest(){return !!this.intent||this.store.getItem(poseRequestKey(this.binding))!==null;}
  saved(){
    const raw=this.store.getItem(poseRequestKey(this.binding));if(raw===null)return null;
    let parsed:Intent;try{parsed=intentSchema.parse(JSON.parse(raw));}catch{throw Error("The saved preview could not be recovered. Keep this clip and check the job history.");}
    if(!sameBinding(parsed,this.binding))throw Error("The saved preview belongs to a different clip.");
    this.intent=parsed;return parsed;
  }
  async recover(signal?:AbortSignal):Promise<PoseStatus|null>{
    const intent=this.intent??this.saved();if(!intent)return null;
    try{return await this.refresh(signal);}
    catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;return this.submit(intent,signal);}
  }
  async start(signal?:AbortSignal){
    signal?.throwIfAborted();
    const old=this.intent??this.saved();
    if(old&&!this.status)return this.recover(signal);
    if(old&&this.status&&!poseTerminal(this.status.state))return this.refresh(signal);
    const intent:Intent={...this.binding,version:1,requestId:this.uuid()};
    // If browser storage is unavailable, do not submit an unrecoverable job.
    this.store.setItem(poseRequestKey(this.binding),JSON.stringify(intent));this.intent=intent;this.status=null;
    return this.submit(intent,signal);
  }
  async refresh(signal?:AbortSignal){
    signal?.throwIfAborted();
    const intent=this.intent??this.saved();if(!intent)throw Error("Start a pose preview first.");
    const value=await this.call<unknown>(workspacePath(this.binding.workspaceId,`pose-previews/${intent.requestId}`),"GET",undefined,{signal});signal?.throwIfAborted();return this.accept(value,intent);
  }
  async cancel(signal?:AbortSignal){
    const intent=this.intent??this.saved();if(!intent)return null;
    await this.call(workspacePath(this.binding.workspaceId,`pose-previews/${intent.requestId}/cancel`),"POST",undefined,{signal});return this.refresh(signal);
  }
  private async submit(intent:Intent,signal?:AbortSignal){
    signal?.throwIfAborted();
    const {requestId,projectId,sourceAssetId,workerId}=intent;
    const value=await this.call<unknown>(workspacePath(this.binding.workspaceId,"pose-previews"),"POST",{requestId,projectId,sourceAssetId,workerId},{signal});signal?.throwIfAborted();return this.accept(value,intent);
  }
  private accept(value:unknown,intent:Intent){
    if(this.intent?.requestId!==intent.requestId)throw Error("This preview was replaced by a newer request.");
    const parsed=statusSchema.safeParse(value);if(!parsed.success)throw Error("The pose preview response could not be verified.");const data=parsed.data;
    if(data.id!==intent.requestId||data.project_id!==intent.projectId||data.worker_id!==intent.workerId||data.source_asset_id!==intent.sourceAssetId||data.source_sha256!==intent.sourceSha256)throw Error("This pose preview belongs to a different clip.");
    const frames:PosePreviewFrame[]=[];
    for(const [i,frame] of data.frames.entries()){
      if(frame.previewId!==intent.requestId||frame.sourceAssetId!==intent.sourceAssetId||frame.sourceSha256!==intent.sourceSha256||frame.seconds!==frame.frameIndex/24||(i>0&&frame.frameIndex<=data.frames[i-1].frameIndex))throw Error("The pose samples do not match this clip's timing.");
      const canvas=frame.pose as {canvas_width?:number;canvas_height?:number}|null;
      const width=canvas?.canvas_width??0,height=canvas?.canvas_height??0;
      if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>1920||height>1920||width*height>2073600)throw Error("The detected pose dimensions are unsupported.");
      const pose=readPoseFrames([frame.pose],{count:1,width,height});if(!pose||i>0&&(pose[0].canvas_width!==frames[0].pose.canvas_width||pose[0].canvas_height!==frames[0].pose.canvas_height))throw Error("The detected pose samples could not be verified.");
      frames.push({frameIndex:frame.frameIndex,seconds:frame.seconds,pose:pose[0]});
    }
    if(data.state==="succeeded"&&!frames.length||data.state!=="succeeded"&&frames.length)throw Error("The pose preview is incomplete.");
    this.status={state:data.state,runId:data.run_id,error:data.error,frames};return this.status;
  }
}
