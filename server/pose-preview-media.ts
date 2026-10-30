import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,readFile,rm,stat} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {poseFramePlan} from "../src/capabilities/pose-preview";
import {HttpError} from "./auth";
import {fileSha256} from "./masked-media";
import {motionReceiptSchema,verifyMotionOutput,type MotionMediaReceipt} from "./motion-media";
import type {DiskStore} from "./storage";
const execute=promisify(execFile);
/** Extract measured samples from an existing verified 24-CFR normalization.
 * The caller owns the normalized asset and any subsequent durable publication. */
export async function extractPoseSamples(store:DiskStore,workspaceId:string,input:MotionMediaReceipt,cancel?:AbortSignal){
  cancel?.throwIfAborted();const receipt=motionReceiptSchema.parse(input);
  if(receipt.workspaceId!==workspaceId)throw new HttpError(422,"The driving receipt belongs to another workspace.");
  const source=await store.file(workspaceId,receipt.sourceKey),normalized=await store.file(workspaceId,receipt.normalizedKey);
  if(await fileSha256(source)!==receipt.sourceSha256)throw new HttpError(422,"The driving clip changed before pose extraction.");
  await verifyMotionOutput({store,workspaceId,key:receipt.normalizedKey},receipt,cancel);
  const plan=poseFramePlan(receipt.decodedFrameCount),root=path.resolve(store.root),scratch=await mkdtemp(path.join(root,"pose-samples-"));
  if(path.dirname(scratch)!==root)throw Error("Invalid pose scratch directory");
  const signal=cancel?AbortSignal.any([cancel,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000);
  try{
    const selection=plan.map(frame=>`eq(n\\,${frame.frameIndex})`).join("+");
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-protocol_whitelist","file,pipe","-i",normalized,"-map","0:v:0","-vf",`select=${selection}`,"-fps_mode","vfr","-threads","1","-start_number","0",path.join(scratch,"pose-%02d.png")],{signal,windowsHide:true,timeout:60000,maxBuffer:65536});
    const frames=[];for(const [ordinal,frame] of plan.entries()){
      signal.throwIfAborted();const file=path.join(scratch,`pose-${String(ordinal).padStart(2,"0")}.png`);if((await stat(file)).size>16*1024*1024)throw new HttpError(422,"The pose sample exceeds the supported size.");
      const bytes=await readFile(file);if(bytes.length<24||bytes.toString("ascii",1,4)!=="PNG"||bytes.readUInt32BE(16)!==receipt.width||bytes.readUInt32BE(20)!==receipt.height)throw new HttpError(422,"Pose samples do not match the normalized driving clip.");
      frames.push({...frame,bytes,sha256:createHash("sha256").update(bytes).digest("hex")});
    }
    const [sourceHash,normalizedHash]=await Promise.all([fileSha256(source),fileSha256(normalized)]);if(sourceHash!==receipt.sourceSha256||normalizedHash!==receipt.normalizedSha256)throw new HttpError(422,"The driving media changed during pose extraction.");
    signal.throwIfAborted();return {version:1 as const,sourceSha256:receipt.sourceSha256,normalizedSha256:receipt.normalizedSha256,width:receipt.width,height:receipt.height,fps:24 as const,frames};
  }finally{if(path.dirname(scratch)===root)await rm(scratch,{recursive:true,force:true});}
}
