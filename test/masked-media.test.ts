import {beforeAll,describe,it,expect} from "vitest";
import {randomUUID} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileSha256,inspectMaskVideo,normalizeMaskPair,validateMaskPair,verifyMaskedOutput,withMaskInspection} from "../server/masked-media";
import {maskFixtures} from "./masked-fixtures";
import {loadServerCatalogue} from "../server/catalogue";
import {compileLocal} from "../src/capabilities/compile";
import {validateCapability} from "../src/capabilities/validate";
import {assetMatchesPort} from "../src/capabilities/assets";
import {MediaProbeUnavailableError} from "../server/media";

describe("strict aligned-mask media",()=>{
  it("bounds concurrent decoder work used by tracking admission",async()=>{
    let release!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});
    const first=withMaskInspection(()=>held),second=withMaskInspection(()=>held);
    await expect(withMaskInspection(async()=>undefined)).rejects.toMatchObject({statusCode:429});
    release();await Promise.all([first,second]);
  });
  let f:Awaited<ReturnType<typeof maskFixtures>>;
  beforeAll(async()=>{f=await maskFixtures();}, 120000);
  async function validate(mask=f.mask,source=f.source){return validateMaskPair(source,mask,{sourceAssetId:randomUUID(),sourceSha256:await fileSha256(source),maskSha256:await fileSha256(mask)});}
  it("accepts matched decoded frames and preserves mask polarity in its receipt",async()=>{
    const receipt=await validate();expect(receipt).toMatchObject({width:160,height:96,fps:16,frames:17,semantics:"white_edits_black_preserves"});
    expect(await verifyMaskedOutput(f.source,receipt)).toMatchObject({frames:17,hasAudio:false});
  }, 120000);
  it("distinguishes a missing decoder from invalid media",async()=>{
    const previous=process.env.FFPROBE_PATH;process.env.FFPROBE_PATH=`${f.dir}/missing-ffprobe`;
    try{await expect(inspectMaskVideo(f.source)).rejects.toBeInstanceOf(MediaProbeUnavailableError);}
    finally{if(previous===undefined)delete process.env.FFPROBE_PATH;else process.env.FFPROBE_PATH=previous;}
    const previousFfmpeg=process.env.FFMPEG_PATH;process.env.FFMPEG_PATH=`${f.dir}/missing-ffmpeg`;
    try{await expect(validate()).rejects.toBeInstanceOf(MediaProbeUnavailableError);}
    finally{if(previousFfmpeg===undefined)delete process.env.FFMPEG_PATH;else process.env.FFMPEG_PATH=previousFfmpeg;}
  });
  it("rejects short masks, mismatched dimensions and colored masks",async()=>{
    for(const file of [await f.make("short","color=c=white:s=160x96:r=16",13),await f.make("dimensions","color=c=white:s=192x96:r=16"),await f.make("colored","color=c=red:s=160x96:r=16")])await expect(validate(file)).rejects.toThrow();
  }, 120000);
  it("rejects incorrect rates, frame counts, geometry and timestamps",async()=>{
    for(const file of [await f.make("rate","color=c=white:s=160x96:r=15"),await f.make("count","color=c=white:s=160x96:r=16",18),await f.make("geometry","color=c=white:s=162x96:r=16"),await f.make("offset","color=c=white:s=160x96:r=16",17,["-output_ts_offset","1"])])await expect(inspectMaskVideo(file)).rejects.toThrow();
  }, 120000);
  it("rejects rotation, corruption, hash mismatch and wrong output timing",async()=>{
    const rotated=`${f.dir}/rotated.mp4`;
    await promisify(execFile)(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-display_rotation","90","-i",f.source,"-c","copy",rotated],{windowsHide:true});
    await expect(inspectMaskVideo(rotated)).rejects.toThrow(/rotation/);
    await writeFile(`${f.dir}/broken.mp4`,"not media");await expect(inspectMaskVideo(`${f.dir}/broken.mp4`)).rejects.toThrow();
    await writeFile(`${f.dir}/playlist.mp4`,`ffconcat version 1.0\nfile 'source.mp4'\n`);await expect(inspectMaskVideo(`${f.dir}/playlist.mp4`)).rejects.toThrow();
    await expect(validateMaskPair(f.source,f.mask,{sourceAssetId:randomUUID(),sourceSha256:"0".repeat(64),maskSha256:await fileSha256(f.mask)})).rejects.toThrow(/changed/);
    const longer=await f.make("longer","color=c=white:s=160x96:r=16",21);await expect(verifyMaskedOutput(longer,await validate())).rejects.toThrow(/does not match/);
  }, 120000);
  it("normalizes ordinary 30 FPS camera footage into an aligned 16 FPS pair",async()=>{
    const cameraSource=await f.make("camera-30-source","testsrc2=s=160x96:r=30",30);
    const cameraMask=await f.make("camera-30-mask","color=c=black:s=160x96:r=30,drawbox=x=32:y=16:w=64:h=64:color=white:t=fill",30);
    const normalized=await normalizeMaskPair(cameraSource,cameraMask);
    try{
      expect(normalized).toMatchObject({width:160,height:96,frames:17});
      const source=await inspectMaskVideo(normalized.sourcePath),mask=await inspectMaskVideo(normalized.maskPath);
      expect(source).toMatchObject({width:160,height:96,fps:16,frames:17,hasAudio:false});
      expect(mask.timingDigest).toBe(source.timingDigest);
      expect(mask.timingDigest).toBe(normalized.timingDigest);
    }finally{await normalized.cleanup();}
  },60000);
  it("rejects variable timing, non-square pixels and audio-bearing masks or outputs",async()=>{
    const variable=await f.make("variable","color=c=white:s=160x96:r=16,select=not(eq(n\\,8))",17,["-fps_mode","vfr"]);
    await expect(inspectMaskVideo(variable)).rejects.toThrow();
    const anamorphic=await f.make("anamorphic","color=c=white:s=160x96:r=16,setsar=2");await expect(inspectMaskVideo(anamorphic)).rejects.toThrow(/square pixels/);
    const withAudio=`${f.dir}/audio.mp4`;
    await promisify(execFile)(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-i",f.source,"-f","lavfi","-i","anullsrc=r=48000:cl=mono","-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-shortest",withAudio],{windowsHide:true,timeout:10000});
    await expect(validate(withAudio)).rejects.toThrow(/audio/);
    await expect(verifyMaskedOutput(withAudio,await validate())).rejects.toThrow(/mute policy/);
    expect((await validate(f.mask,withAudio)).frames).toBe(17);
  }, 120000);
});

it("registers the qualified manual-mask graph with actual parameter and preservation bindings",async()=>{
  const b=(await loadServerCatalogue()).find(b=>b.manifest.id==="wan21-vace-masked-edit")!;
  expect(validateCapability(b)).toEqual([]);expect(b.manifest.coverage.local).toBe("implemented");
  const i={capabilityId:b.manifest.id,version:b.manifest.version,routeId:"local",inputs:{source_video:"comfyfield-source.mp4",edit_mask:"comfyfield-mask.mp4"},controls:{prompt:"Blue vase",negative:"bad",seed:1,strength:1.2},audioPolicy:"mute" as const};
  const graph=compileLocal(b,i);
  expect(graph["4"].inputs.file).toBe(i.inputs.source_video);expect(graph["6"].inputs.file).toBe(i.inputs.edit_mask);
  expect(graph["10"].inputs.text).toBe("Blue vase");expect(graph["11"].inputs.text).toBe("bad");expect(graph["17"].inputs.seed).toBe(1);expect(graph["15"].inputs.strength).toBe(1.2);
  expect(graph["19"].inputs).toMatchObject({destination:["5",0],source:["18",0],mask:["8",0]});expect(graph["20"].inputs).toEqual({images:["19",0],fps:["5",2]});
  expect(()=>compileLocal(b,{...i,controls:{...i.controls,width:832}})).toThrow(/Unknown control/);
  expect(compileLocal(b,{...i,controls:{...i.controls,negative:""}})["11"].inputs.text).toBe("");
  const port=b.manifest.inputs[1];expect(assetMatchesPort({media_type:"video",content_type:"video/mp4"},port)).toBe(false);expect(assetMatchesPort({media_type:"mask",content_type:"video/mp4"},port)).toBe(true);
});
