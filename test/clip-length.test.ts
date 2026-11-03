import {beforeAll,describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {normalizeMaskPair,inspectMaskVideo,targetFrames} from "../server/masked-media";
import {prepareFpsVideo} from "../server/fps-prepare";
import {planScailChunks,SCAIL_MAX_CHUNKS,SCAIL_MAX_FRAMES} from "../src/capabilities/replace";
import {planWanAnimateFrames,WAN_ANIMATE_MAX_DESIRED_FRAMES} from "../src/capabilities/motion";
import {maskFixtures} from "./masked-fixtures";

/** A result is as long as its input clip, up to what the model can make.
 *  These tests pin, per workflow, where the frame count comes from and what a
 *  five-second clip becomes. See docs/CLIP-LENGTH.md for the whole table. */
const graph=(id:string)=>JSON.parse(readFileSync(`native-workflows/${id}/template.api.json`,"utf8")) as Record<string,{class_type:string;inputs:Record<string,unknown>}>;
/** A clip of whole frames: five seconds at 16, 24 or 30 frames a second. */
const clipFrames=(seconds:number,fps:number)=>Math.round(seconds*fps);
/** Wan VACE allocates floor((length-1)/4)+1 latent frames and the Wan VAE decodes 4t-3. */
const vaceOutputFrames=(length:number)=>4*Math.floor((length-1)/4)+1;
const secondsOf=(frames:number,fps:number)=>Math.round((frames/fps)*1000)/1000;

describe("Restyle keeps the full 5 s of a 24 or 30 fps clip",()=>{
  const capped=["vace-canny-restyle","vace-canny-restyle-14b","vace-reference-restyle"];
  it("takes the frame count from the source clip and stops at the model's 81 frames",()=>{
    for(const id of capped){
      const g=graph(id),nodes=Object.values(g);
      // The head trim is the only model limit in these graphs: 81 frames.
      expect(nodes.filter(node=>node.class_type==="ImageFromBatch"&&Number(node.inputs.length)===81).length,id).toBeGreaterThan(0);
      // VACE is asked for as many frames as the fitted clip has, and the output runs at the clip's rate.
      const vace=nodes.find(node=>node.class_type==="WanVaceToVideo")!;
      expect(g[String((vace.inputs.length as [string,number])[0])].class_type,id).toBe("GetImageSize");
      const video=nodes.find(node=>node.class_type==="CreateVideo")!;
      expect(g[String((video.inputs.fps as [string,number])[0])].class_type,id).toBe("GetVideoComponents");
    }
  });

  it("prepares the clip to 16 fps before the graph, so 5 s becomes one 81-frame pass",()=>{
    // The server resamples to 16 fps and keeps 4n+1 frames from the duration.
    for(const fps of [24,30])expect(targetFrames(clipFrames(5,fps)/fps)).toBe(81);
    // Five seconds at 16 fps is 80 frames, so the prepare adds the last one to reach 4n+1.
    expect(targetFrames(5)).toBe(81);
    // Two seconds stays whole; seven seconds is cut to the one full pass.
    expect(targetFrames(2)).toBe(33);
    expect(targetFrames(7)).toBe(81);
    // Wan's 4n+1 grid now decodes all 81 frames at 16 fps.
    expect(vaceOutputFrames(81)).toBe(81);
    expect(secondsOf(81,16)).toBe(5.063);
  });

  it("leaves the depth route to its admission envelope, which is already 16 fps",()=>{
    const g=graph("vace-depth-restyle"),nodes=Object.values(g);
    expect(nodes.some(node=>node.class_type==="ImageFromBatch")).toBe(false);
    const vace=nodes.find(node=>node.class_type==="WanVaceToVideo")!;
    expect(g[String((vace.inputs.length as [string,number])[0])].class_type).toBe("GetImageSize");
  });
});

describe("Masked edit keeps the clip's length up to the model's 81 frames",()=>{
  let f:Awaited<ReturnType<typeof maskFixtures>>;
  beforeAll(async()=>{f=await maskFixtures();},120000);
  const pair=async(frames:number,fps:number,name:string)=>{
    const source=await f.make(`${name}-source`,`testsrc2=s=160x96:r=${fps}`,frames);
    const mask=await f.make(`${name}-mask`,`color=c=black:s=160x96:r=${fps},drawbox=x=32:y=16:w=64:h=64:color=white:t=fill`,frames);
    return normalizeMaskPair(source,mask);
  };

  it("turns five seconds of ordinary footage into five seconds of 16 fps frames",async()=>{
    const normalized=await pair(150,30,"clip-length-five");
    try{
      expect(normalized.frames).toBe(81);
      expect(secondsOf(normalized.frames,16)).toBe(5.063);
    }finally{await normalized.cleanup();}
  },60000);

  it("keeps a short clip whole",async()=>{
    const normalized=await pair(75,25,"clip-length-three");
    try{expect(normalized.frames).toBe(49);expect(secondsOf(normalized.frames,16)).toBe(3.063);}finally{await normalized.cleanup();}
  },60000);

  it("cuts a longer clip to the longest pass the model can make",async()=>{
    const normalized=await pair(180,30,"clip-length-six");
    try{expect(normalized.frames).toBe(81);}finally{await normalized.cleanup();}
  },60000);

  it("prepares a plain 5 s clip to 81 frames before the mask step",async()=>{
    // The mask step still opens only the 16 fps 4n+1 envelope; the server prepares the upload first.
    const plain=await f.make("clip-length-object-swap","testsrc2=s=160x96:r=16",80);
    await expect(inspectMaskVideo(plain)).rejects.toThrow(/4n\+1/);
    const prepared=await prepareFpsVideo(plain);
    try{expect(prepared.frames).toBe(81);expect(secondsOf(prepared.frames,16)).toBe(5.063);}finally{await prepared.cleanup();}
  },60000);
});

describe("Workflows that keep a long clip whole",()=>{
  it("Replace character chains 81-frame passes and keeps the clip's frame rate",()=>{
    const plan=planScailChunks(clipFrames(5,24));
    expect(plan.chunkCount).toBe(2);
    expect(plan.chunkFrames).toBe(81);
    // Wan's 4n+1 window can end up to three frames short of the very last source frame.
    expect(plan.frames-plan.emittedFrames).toBeLessThanOrEqual(3);
    expect(secondsOf(plan.emittedFrames,24)).toBe(4.875);
    expect(SCAIL_MAX_FRAMES).toBe(613);
    expect(()=>planScailChunks(SCAIL_MAX_FRAMES+1)).toThrow(String(SCAIL_MAX_CHUNKS));
  });

  it("Motion transfer chains 81-frame windows over a 24 fps copy of the clip",()=>{
    const plan=planWanAnimateFrames(clipFrames(5,24)),emitted=plan.chunks.reduce((total,chunk)=>total+chunk.emittedFrames,0);
    expect(plan.chunkCount).toBe(2);
    expect(plan.desiredFrames).toBe(120);
    expect(emitted).toBe(120);
    expect(secondsOf(emitted,24)).toBe(5);
    expect(WAN_ANIMATE_MAX_DESIRED_FRAMES).toBe(641);
    expect(secondsOf(WAN_ANIMATE_MAX_DESIRED_FRAMES,24)).toBe(26.708);
    expect(()=>planWanAnimateFrames(WAN_ANIMATE_MAX_DESIRED_FRAMES+1)).toThrow();
  });
});
