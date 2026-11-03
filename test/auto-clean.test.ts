import {describe,expect,it,vi} from "vitest";
import {execFile,spawnSync} from "node:child_process";
import {promisify} from "node:util";
import {createReadStream,existsSync,readFileSync} from "node:fs";
import {mkdtemp,rm} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import path from "node:path";
import type {PoolClient} from "pg";
import {cleanSourceRule,maskNamesSource} from "../src/capabilities/clean";
import type {CapabilityManifestV2} from "../src/capabilities/types";
import {admitCleanVideoSource} from "../server/video-extension-prepare";
import type {ResolvedRunAsset} from "../server/element-inputs";
import {DiskStore} from "../server/storage";
import * as overlays from "../server/video-overlay-mask";
import {findCleanRegion} from "../server/video-content-region";

/** Every video tool cleans its input itself. See docs/TRANSFORM-VIDEO.md. */
const execute=promisify(execFile);
const manifest=(id:string):CapabilityManifestV2=>JSON.parse(readFileSync(`native-workflows/${id}/manifest.json`,"utf8"));
const binariesAvailable=spawnSync(process.env.FFMPEG_PATH??"ffmpeg",["-version"],{windowsHide:true}).status===0
  &&spawnSync(process.env.FFPROBE_PATH??"ffprobe",["-version"],{windowsHide:true}).status===0;

describe("every tool that takes a reference clip cleans it at run admission",()=>{
  it("names the clip and the rate each tool's graph takes",()=>{
    const expected:Record<string,[string,16|24|undefined]> = {
      "scail2-character-replace":["source_video",24],
      "wan21-vace-masked-edit":["source_video",16],
      "wan21-vace-masked-edit-reference":["source_video",16],
      "wan21-vace-two-region-edit":["source_video",16],
      "sam31-video-mask":["source_video",16],
      "sam31-video-background-mask":["source_video",16],
      "sam31-video-point-mask":["source_video",16],
      "sam21-video-mask":["source_video",16],
      "vace-canny-restyle":["source_video",16],
      "vace-canny-restyle-14b":["source_video",16],
      "vace-reference-restyle":["source_video",16],
      "video-edit-extend-vace":["source_video",undefined],
    };
    for(const [id,[sourceInput,fps]] of Object.entries(expected)){
      const rule=cleanSourceRule(manifest(id));
      expect(rule?.sourceInput,id).toBe(sourceInput);
      expect(rule?.fps,id).toBe(fps);
    }
  });

  it("keeps the masks of a masked edit with the clip they were measured on",()=>{
    expect(cleanSourceRule(manifest("wan21-vace-masked-edit"))?.maskInputs).toEqual(["edit_mask"]);
    expect(cleanSourceRule(manifest("wan21-vace-two-region-edit"))?.maskInputs).toEqual(["edit_mask","edit_mask_2"]);
    expect(cleanSourceRule(manifest("vace-canny-restyle"))?.maskInputs).toBeUndefined();
  });

  it("leaves an enhancement pack alone: it makes the clip it has bigger",()=>{
    expect(cleanSourceRule(manifest("nvidia-vfx-upscale"))).toBeUndefined();
    expect(cleanSourceRule(manifest("film-frame-interpolation"))).toBeUndefined();
  });

  it("leaves a clip that is paired with a derived second video alone",()=>{
    // Depth restyle admits an aligned depth video; a crop of the source would no longer line up.
    expect(manifest("vace-depth-restyle").inputs.filter(port=>port.type==="video")).toHaveLength(2);
    expect(cleanSourceRule(manifest("vace-depth-restyle"))).toBeUndefined();
  });

  it("reads a mask receipt against the clean copy, both kinds it can be written in",()=>{
    const clean={id:"clean",sha256:"a".repeat(64)};
    expect(maskNamesSource({maskSequence:{sourceAssetId:"clean",sourceSha256:"a".repeat(64)}},clean)).toBe(true);
    expect(maskNamesSource({maskNormalization:{originalSourceAssetId:"clean",originalSourceSha256:"a".repeat(64)}},clean)).toBe(true);
    expect(maskNamesSource({maskSequence:{sourceAssetId:"upload",sourceSha256:"b".repeat(64)}},clean)).toBe(false);
    expect(maskNamesSource({},clean)).toBe(false);
    expect(maskNamesSource(undefined,clean)).toBe(false);
  });
});

/** A client that answers the four statements one clean admission makes. */
function fakeClient(source:ResolvedRunAsset,cleanName:string){
  const derived:Array<Record<string,unknown>>=[];
  const client={query:async(sql:string,params:unknown[]=[])=>{
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM projects"))return{rows:[{id:source.project_id}]};
    if(sql.includes("metadata->'videoPrepare'->>'sourceSha256'"))return{rows:derived};
    if(sql.startsWith("INSERT INTO assets")){
      const row={id:params[0],project_id:params[2],name:params[3],media_type:"video",content_type:"video/mp4",sha256:params[5],bytes:params[6],parent_id:params[8],created_at:new Date(),metadata:JSON.parse(String(params[9])),storage_key:params[4]};
      derived.push(row);return{rows:[row]};
    }
    if(sql.includes("FROM assets WHERE workspace_id=$1 AND id=$2"))return{rows:[{...source,...(derived[0]??{}),storage_key:derived[0]?.storage_key??source.storage_key}]};
    if(sql.includes("FROM assets"))return{rows:[source]};
    return{rows:[]};
  }} as unknown as PoolClient;
  return {client,derived,name:cleanName};
}

describe.skipIf(!binariesAvailable)("a run gets the clean copy, or the clip it already had",()=>{
  const font=[(process.env.SystemRoot ?? process.env.WINDIR ?? "") + "/Fonts/arial.ttf",(process.env.SystemRoot ?? process.env.WINDIR ?? "") + "/Fonts/segoeui.ttf","/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find(existsSync);
  const label=(text:string,x:number,y:number)=>`drawtext=${font?`fontfile='${font.replace(/:/g,"\\:")}'`:"font=Sans"}:text='${text}':x=${x}:y=${y}:fontsize=18:fontcolor=white`;

  it("refuses unavailable or partial removal without publishing a clean asset",async()=>{
    const scratch=await mkdtemp(path.join(tmpdir(),"comfyfield-overlay-admission-"));
    const recording=path.join(scratch,"full-frame.mp4");
    const workspaceId=randomUUID(),store=new DiskStore(path.join(scratch,"store"),64*1024*1024);
    try{
      await execute(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-y","-f","lavfi","-i","testsrc2=s=1280x480:r=24:d=2",
        "-vf",`crop=640:480:x='mod(t*60,640)':y=0,drawbox=x=584:y=80:w=44:h=44:color=white@1:t=fill,${label("12.4K",582,126)},drawbox=x=584:y=168:w=44:h=44:color=0xff2f6d:t=fill,pad=640:800:0:160`,
        "-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p",recording],{windowsHide:true,timeout:60000});
      const region=await findCleanRegion(recording);
      expect(region).not.toBeNull();
      const saved=await store.put(workspaceId,createReadStream(recording),randomUUID());
      const source={id:randomUUID(),project_id:randomUUID(),name:"Full frame.mp4",media_type:"video" as const,content_type:"video/mp4",sha256:saved.sha256,bytes:saved.bytes,parent_id:null,metadata:{},storage_key:saved.key,created_by:randomUUID()};
      const {client,derived}=fakeClient(source,"clean");
      const removal=vi.spyOn(overlays,"removeOverlays");
      try{
        for(const state of ["unavailable","incomplete"] as const){
          removal.mockResolvedValue({state,done:0,total:1});
          await expect(admitCleanVideoSource(client,store,workspaceId,source,24,true)).rejects.toThrow(`Overlay removal is ${state}`);
          expect(derived).toHaveLength(0);
        }
        removal.mockResolvedValue({state:"none",done:0,total:0});
        const cleaned=await admitCleanVideoSource(client,store,workspaceId,source,24,true);
        expect(cleaned?.snapshot).toMatchObject({width:region!.width,height:region!.height,region:{x:region!.x,y:region!.y,width:region!.width,height:region!.height}});
        expect(derived).toHaveLength(1);
        // The reported input was already a cropped "clean" asset from an older
        // version. No outer app bars remain, but the in-picture UI still needs checking.
        const cropped=path.join(scratch,"cropped.mp4");
        await execute(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-y","-i",recording,"-vf","crop=640:480:0:160","-an","-c:v","libx264","-preset","ultrafast",cropped],{windowsHide:true,timeout:60000});
        expect(await findCleanRegion(cropped)).toBeNull();
        const prior=await store.put(workspaceId,createReadStream(cropped),randomUUID()),parent=randomUUID();
        const oldClean={...source,id:randomUUID(),storage_key:prior.key,sha256:prior.sha256,bytes:prior.bytes,parent_id:parent,metadata:{videoPrepare:{clean:true,cleanVersion:2,sourceAssetId:parent,region:{width:640,height:480,aspect:"4:3"},output:{width:640,height:480}}}};
        const legacy=fakeClient(oldClean,"old clean");
        removal.mockResolvedValue({state:"unavailable",done:0,total:1});
        await expect(admitCleanVideoSource(legacy.client,store,workspaceId,oldClean,24,true)).rejects.toThrow("Overlay removal is unavailable");
        expect(legacy.derived).toHaveLength(0);
      }finally{removal.mockRestore();}
    }finally{await rm(scratch,{recursive:true,force:true});}
  },120000);

  it("crops the app around a screen recording and records the region it kept",async()=>{
    const scratch=await mkdtemp(path.join(tmpdir(),"comfyfield-auto-clean-")),recording=path.join(scratch,"recording.mp4");
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y",
      "-f","lavfi","-i","color=c=#101820:s=270x480:r=30:d=2",
      "-f","lavfi","-i","life=s=270x152:r=30:mold=10:ratio=0.1:seed=1",
      "-filter_complex",`[1:v]trim=duration=2[vid];[0:v][vid]overlay=0:164,${label("Status bar",10,20)},${label("Search",10,430)}`,
      "-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p",recording],{windowsHide:true,timeout:60000});
    const workspaceId=randomUUID(),store=new DiskStore(await mkdtemp(path.join(tmpdir(),"comfyfield-auto-clean-store-")),64*1024*1024);
    const saved=await store.put(workspaceId,createReadStream(recording),randomUUID());
    const source={id:randomUUID(),project_id:randomUUID(),media_type:"video" as const,content_type:"video/mp4",sha256:saved.sha256,bytes:saved.bytes,parent_id:null,metadata:{},storage_key:saved.key,created_by:randomUUID()};
    try{
      const {client,derived}=fakeClient(source,"Recording.mp4 (clean)");
      const cleaned=await admitCleanVideoSource(client,store,workspaceId,source);
      expect(cleaned,"a screen recording has an overlay region").toBeDefined();
      expect(cleaned!.snapshot).toMatchObject({validationVersion:1,contract:"clean_source_v1",sourceAssetId:source.id,sourceSha256:source.sha256,cleanedAssetId:cleaned!.asset.id});
      expect(cleaned!.snapshot.region.aspect).toBe("16:9");
      expect(cleaned!.snapshot.width).toBeGreaterThan(0);
      expect(cleaned!.snapshot.height).toBeGreaterThan(0);
      expect(cleaned!.asset.storage_key).not.toBe(source.storage_key);
      expect(derived).toHaveLength(1);
      expect(derived[0]).toMatchObject({parent_id:source.id,sha256:cleaned!.asset.sha256});
    }finally{await rm(scratch,{recursive:true,force:true});}
  },120000);

  it("uses a plain clip as it is, with no receipt and no new asset",async()=>{
    const scratch=await mkdtemp(path.join(tmpdir(),"comfyfield-auto-clean-")),plain=path.join(scratch,"plain.mp4");
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","testsrc2=s=270x480:r=30:d=2",
      "-frames:v","60","-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p",plain],{windowsHide:true,timeout:60000});
    const workspaceId=randomUUID(),store=new DiskStore(await mkdtemp(path.join(tmpdir(),"comfyfield-auto-clean-store-")),64*1024*1024);
    const saved=await store.put(workspaceId,createReadStream(plain),randomUUID());
    const source={id:randomUUID(),project_id:randomUUID(),media_type:"video" as const,content_type:"video/mp4",sha256:saved.sha256,bytes:saved.bytes,parent_id:null,metadata:{},storage_key:saved.key,created_by:randomUUID()};
    try{
      const {client,derived}=fakeClient(source,"Plain.mp4 (clean)");
      expect(await admitCleanVideoSource(client,store,workspaceId,source)).toBeUndefined();
      expect(derived).toHaveLength(0);
    }finally{await rm(scratch,{recursive:true,force:true});}
  },120000);
});
