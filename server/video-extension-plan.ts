import {createHash} from "node:crypto";
import {z} from "zod";

const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const MAX_CONTINUATION_SOURCE_FRAMES=161;
export const frameRateSchema=z.object({numerator:z.number().int().positive(),denominator:z.number().int().positive()}).strict().superRefine((rate,ctx)=>{
  const ratio=rate.numerator/rate.denominator;
  if(ratio<8||ratio>60)ctx.addIssue({code:"custom",message:"Video must have a constant frame rate between 8 and 60 FPS"});
});
export const videoSourceEnvelopeSchema=z.object({
  validationVersion:z.literal(1),sourceAssetId:z.uuid(),projectId:z.uuid(),sha256:digest,bytes:z.number().int().positive(),
  width:z.number().int().positive(),height:z.number().int().positive(),frameRate:frameRateSchema,frameCount:z.number().int().positive().max(4800),
  timestampDigest:digest,hasAudio:z.boolean(),durationSeconds:z.number().positive(),audioSeconds:z.number().positive().nullable(),container:z.string().min(1),videoCodec:z.string().min(1),
  ffmpegVersion:z.string().min(1),ffprobeVersion:z.string().min(1),
}).strict();
export type VideoSourceEnvelope=z.infer<typeof videoSourceEnvelopeSchema>;

export const videoExtensionIntentSchema=z.object({
  contractVersion:z.literal(1),projectId:z.uuid(),sourceAssetId:z.uuid(),
  startFrame:z.number().int().min(0),endFrameExclusive:z.number().int().positive(),
  extensionFrames:z.number().int().min(0).max(80).default(0),overlapFrames:z.number().int().min(0).max(80).default(0),
  audioPolicy:z.enum(["mute","preserve"]).default("mute"),
}).strict();
export type VideoExtensionIntent=z.infer<typeof videoExtensionIntentSchema>;

export type VideoExtensionPlan={
  contractVersion:1;operation:"trim"|"forward_extend";source:VideoSourceEnvelope;
  trim:{startFrame:number;endFrameExclusive:number;frames:number};
  continuation:null|{contextStartFrame:number;contextEndFrameExclusive:number;overlapFrames:number;requestedFrames:number;generationFrames:number;discardTailFrames:number};
  output:{frameRate:{numerator:16;denominator:1};frames:number;durationTicks:number;timeBase:{numerator:1;denominator:16};audioPolicy:"mute"|"preserve";
    audio:null|{sourceStartFrame:number;sourceEndFrameExclusive:number;continuation:"silent"|null;sampleRate:48000;channels:2}};
  planDigest:string;
};

export function canonicalVideoPlan(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(canonicalVideoPlan).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonicalVideoPlan(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function sha256Text(value:string){return createHash("sha256").update(value).digest("hex");}

/** Smallest Wan-compatible frame count (4n+1) that contains every required frame. */
export function wanGenerationFrames(requiredFrames:number):number{
  if(!Number.isSafeInteger(requiredFrames)||requiredFrames<1)throw new Error("Continuation requires at least one generated frame");
  return 4*Math.ceil((requiredFrames-1)/4)+1;
}

/** Output is always normalized to 16 FPS; a non-16 FPS trim keeps its duration, not its frame count. */
function outputFrames(sourceFrames:number,source:VideoSourceEnvelope):number{
  const fps=source.frameRate.numerator/source.frameRate.denominator;
  return Math.max(1,Math.round(sourceFrames*16/fps));
}

export function planVideoExtension(rawIntent:unknown,rawEnvelope:unknown):VideoExtensionPlan{
  const intent=videoExtensionIntentSchema.parse(rawIntent),source=videoSourceEnvelopeSchema.parse(rawEnvelope);
  if(intent.projectId!==source.projectId||intent.sourceAssetId!==source.sourceAssetId)throw new Error("Source envelope does not match this project and asset");
  if(intent.endFrameExclusive<=intent.startFrame||intent.endFrameExclusive>source.frameCount)throw new Error("Trim range must be a non-empty half-open interval inside the decoded source frames");
  if(intent.audioPolicy==="preserve"&&!source.hasAudio)throw new Error("Source video has no audio stream to preserve");
  const frames=intent.endFrameExclusive-intent.startFrame;
  if(intent.extensionFrames===0&&intent.overlapFrames!==0)throw new Error("Trim-only plans cannot declare continuation overlap");
  if(intent.extensionFrames>0){
    if(source.frameRate.numerator/source.frameRate.denominator!==16)throw new Error("Forward extension requires a 16 FPS source; trim accepts constant 8 to 60 FPS sources");
    if(source.frameCount>MAX_CONTINUATION_SOURCE_FRAMES)throw new Error("Trim the source to at most161 frames before forward extension; the native loader decodes the whole source.");
    if(intent.overlapFrames<1)throw new Error("Forward extension requires at least one context-overlap frame");
    if(intent.overlapFrames>frames)throw new Error("Continuation overlap cannot exceed the retained source range");
    if(source.width%16||source.height%16||Math.max(source.width,source.height)>832||source.width*source.height>399360)throw new Error("Forward extension requires VACE geometry divisible by 16, at most 832 per edge and at most 399360 pixels");
  }
  const generationFrames=intent.extensionFrames?wanGenerationFrames(intent.extensionFrames+intent.overlapFrames):0;
  if(generationFrames>81)throw new Error("Forward extension requires at most 81 VACE generation frames including overlap");
  const withoutDigest:Omit<VideoExtensionPlan,"planDigest">={
    contractVersion:1,operation:intent.extensionFrames?"forward_extend":"trim",source,
    trim:{startFrame:intent.startFrame,endFrameExclusive:intent.endFrameExclusive,frames},
    continuation:intent.extensionFrames?{
      contextStartFrame:intent.endFrameExclusive-intent.overlapFrames,contextEndFrameExclusive:intent.endFrameExclusive,
      overlapFrames:intent.overlapFrames,requestedFrames:intent.extensionFrames,generationFrames,
      discardTailFrames:generationFrames-intent.overlapFrames-intent.extensionFrames,
    }:null,
    output:{frameRate:{numerator:16,denominator:1},frames:outputFrames(frames,source)+intent.extensionFrames,durationTicks:outputFrames(frames,source)+intent.extensionFrames,timeBase:{numerator:1,denominator:16},audioPolicy:intent.audioPolicy,
      audio:intent.audioPolicy==="preserve"?{sourceStartFrame:intent.startFrame,sourceEndFrameExclusive:intent.endFrameExclusive,continuation:intent.extensionFrames?"silent":null,sampleRate:48000,channels:2}:null},
  };
  return {...withoutDigest,planDigest:sha256Text(canonicalVideoPlan(withoutDigest))};
}

