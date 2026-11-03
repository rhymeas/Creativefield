import {beforeAll,describe,expect,it} from "vitest";
import {createReadStream,readFileSync} from "node:fs";
import {mkdtemp} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import type {PoolClient} from "pg";
import {compileLocal} from "../src/capabilities/compile";
import {validateCapability} from "../src/capabilities/validate";
import type {CapabilityBundle,Invocation} from "../src/capabilities/types";
import {inspectMaskVideo,targetFrames} from "../server/masked-media";
import {clipCutNotice,FPS_PREPARE_MAX_FRAMES,prepareFpsVideo} from "../server/fps-prepare";
import {prepareInvocation,type RunRequest} from "../server/run-submission";
import {DiskStore} from "../server/storage";
import {maskFixtures} from "./masked-fixtures";

/** The 16 fps prepare keeps the whole 5 s of a 24 or 30 fps clip. See docs/CLIP-LENGTH.md. */
const packs=["vace-canny-restyle","vace-canny-restyle-14b","vace-reference-restyle","sam31-video-mask"];
const loadPack=(id:string):CapabilityBundle=>({manifest:JSON.parse(readFileSync(`native-workflows/${id}/manifest.json`,"utf8")),template:JSON.parse(readFileSync(`native-workflows/${id}/template.api.json`,"utf8"))}) as CapabilityBundle;
const secondsOf=(frames:number,fps:number)=>Math.round((frames/fps)*1000)/1000;

describe("the 16 fps prepare joins the restyle packs and mask tracking",()=>{
  it("is declared by every pack that needs it, on the source video",()=>{
    for(const id of packs){
      const bundle=loadPack(id);
      expect(bundle.manifest.fpsPrepare,id).toEqual({kind:"source_16fps_v1",sourceInput:"source_video"});
      expect(validateCapability(bundle),id).toEqual([]);
    }
  });

  it("pins 4n+1 frames from the clip's duration, capped at one 81-frame pass",()=>{
    expect(targetFrames(5)).toBe(81);
    expect(targetFrames(2)).toBe(33);
    expect(targetFrames(7)).toBe(81);
    expect(targetFrames(0.25)).toBe(17);
    expect(FPS_PREPARE_MAX_FRAMES).toBe(81);
  });

  it("says a long clip was cut in one short sentence",()=>{
    expect(clipCutNotice(7)).toBe("Your clip is 7 s; this tool makes up to 5 s, so the first 5 s were used.");
    expect(clipCutNotice(5)).toBeUndefined();
    expect(clipCutNotice(5.0625)).toBeUndefined();
    expect(clipCutNotice(5.4)).toContain("Your clip is 5.4 s");
  });

  it("keeps the prepared receipt to the one envelope the graph can hold",()=>{
    const bundle=loadPack("vace-canny-restyle");
    const invocation=(frames:number):Invocation=>({capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:"comfyfield-source.mp4"},controls:{prompt:""},audioPolicy:"mute",
      fpsPrepare:{validationVersion:1,contract:"source_16fps_v1",sourceAssetId:"source",sourceSha256:"a".repeat(64),preparedAssetId:"prepared",preparedSha256:"b".repeat(64),width:640,height:360,fps:16,frames,timingDigest:"c".repeat(64)}});
    expect(()=>compileLocal(bundle,invocation(81))).not.toThrow();
    expect(()=>compileLocal(bundle,invocation(80))).toThrow("Prepared source envelope is invalid");
  });
});

describe("a 5 s phone clip keeps 5 s at 16 fps",()=>{
  let f:Awaited<ReturnType<typeof maskFixtures>>;
  beforeAll(async()=>{f=await maskFixtures();},60000);
  const clip=async(name:string,frames:number,fps:number)=>{
    const source=await f.make(name,`testsrc2=s=160x96:r=${fps}`,frames);
    return prepareFpsVideo(source);
  };

  it("turns 5 s at 30 fps into 81 frames at 16 fps",async()=>{
    const prepared=await clip("fps-five-30",150,30);
    try{
      expect(prepared.frames).toBe(81);
      expect(secondsOf(prepared.frames,16)).toBe(5.063);
      expect(prepared.notice).toBeUndefined();
      const decoded=await inspectMaskVideo(prepared.path);
      expect(decoded).toMatchObject({fps:16,frames:81,width:160,height:96});
    }finally{await prepared.cleanup();}
  },60000);

  it("keeps a 2 s clip whole at 33 frames",async()=>{
    const prepared=await clip("fps-two-30",60,30);
    try{
      expect(prepared.frames).toBe(33);
      expect(secondsOf(prepared.frames,16)).toBe(2.063);
    }finally{await prepared.cleanup();}
  },60000);

  it("cuts 7 s to the 81-frame pass and says so",async()=>{
    const prepared=await clip("fps-seven-30",210,30);
    try{
      expect(prepared.frames).toBe(81);
      expect(prepared.notice).toBe("Your clip is 7 s; this tool makes up to 5 s, so the first 5 s were used.");
    }finally{await prepared.cleanup();}
  },60000);
});

describe("a restyle run compiles the prepared asset and keeps one copy per source",()=>{
  const fakePrepare=(bundle:CapabilityBundle,projectId:string,source:Record<string,unknown>)=>{
    const inventory={online:true,nodes:[...new Set(bundle.manifest.routes[0].requirements.filter(r=>r.kind==="node").map(r=>r.name))],models:[...new Set(bundle.manifest.routes[0].requirements.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`))],credentials:[],objectInfoChecked:true,checkedModelFolders:[...new Set(bundle.manifest.routes[0].requirements.filter(r=>r.kind==="model"&&r.location).map(r=>r.location!))]};
    const derived:Array<Record<string,any>>=[];
    let inserts=0;
    const client={query:async(sql:string,params:unknown[]=[])=>{
      if(sql.includes("FROM projects"))return{rowCount:1,rows:[{id:projectId}]};
      if(sql.includes("FROM workers"))return{rowCount:1,rows:[{kind:"local",checked_at:new Date().toISOString(),inventory}]};
      if(sql.includes("metadata->>'fpsPrepareKey'"))return{rowCount:derived.length,rows:derived.filter(row=>row.metadata?.fpsPrepareKey===params[3])};
      if(sql.includes("SELECT created_by,name FROM assets"))return{rowCount:1,rows:[{created_by:randomUUID(),name:"clip.mp4"}]};
      if(sql.startsWith("INSERT INTO assets")){inserts++;const row={id:params[0],workspace_id:params[1],project_id:params[2],name:params[3],media_type:"video",content_type:"video/mp4",storage_key:params[4],sha256:params[5],bytes:params[6],created_by:params[7],parent_id:params[8],metadata:JSON.parse(String(params[9]))};derived.push(row);return{rowCount:1,rows:[row]};}
      if(sql.includes("INSERT INTO workflow_revisions"))return{rowCount:1,rows:[{id:randomUUID()}]};
      if(sql.includes("FROM assets"))return{rowCount:1,rows:[source]};
      return{rowCount:0,rows:[]};
    }} as unknown as PoolClient;
    return {client,derived,inserts:()=>inserts};
  };
  const putSource=async(store:DiskStore,workspaceId:string,projectId:string,sourceFile:string)=>{
    const saved=await store.put(workspaceId,createReadStream(sourceFile));
    return {id:randomUUID(),project_id:projectId,parent_id:null,media_type:"video",content_type:"video/mp4",sha256:saved.sha256,bytes:saved.bytes,created_by:randomUUID(),metadata:{},storage_key:saved.key};
  };
  const bodyFor=(bundle:CapabilityBundle,projectId:string,sourceId:string,extra:Partial<RunRequest>={}):RunRequest=>({projectId,workerId:randomUUID(),idempotencyKey:randomUUID(),capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:sourceId},controls:{},audioPolicy:"mute",...extra});

  it("replaces the upload with the derived asset and carries the cut line in the run",async()=>{
    const f=await maskFixtures(),sourceFile=await f.make("fps-run-seven-30","testsrc2=s=160x96:r=30",210);
    const workspaceId=randomUUID(),projectId=randomUUID(),root=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/fps-store-"),store=new DiskStore(root,128*1024*1024);
    const source=await putSource(store,workspaceId,projectId,sourceFile),sourceId=source.id as string;
    const bundle=loadPack("vace-canny-restyle"),{client,derived,inserts}=fakePrepare(bundle,projectId,source);
    const first=await prepareInvocation(client,[bundle],workspaceId,bodyFor(bundle,projectId,sourceId),store),second=await prepareInvocation(client,[bundle],workspaceId,bodyFor(bundle,projectId,sourceId),store);
    expect(first.invocation.inputs.source_video).not.toBe(sourceId);
    expect(first.invocation.fpsPrepare).toMatchObject({contract:"source_16fps_v1",sourceAssetId:sourceId,frames:81,fps:16,width:160,height:96,notice:"Your clip is 7 s; this tool makes up to 5 s, so the first 5 s were used."});
    expect(first.invocation.fpsPrepare!.preparedAssetId).toBe(first.invocation.inputs.source_video);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({parent_id:sourceId,media_type:"video",sha256:first.invocation.fpsPrepare!.preparedSha256});
    expect(second.invocation.inputs.source_video).toBe(first.invocation.inputs.source_video);
    expect(inserts()).toBe(1);
  },90000);

  it("prepares a 5 s 30 fps clip before mask tracking, so Object swap accepts it",async()=>{
    const f=await maskFixtures(),sourceFile=await f.make("fps-run-swap-five-30","testsrc2=s=160x96:r=30",150);
    const workspaceId=randomUUID(),projectId=randomUUID(),root=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/fps-store-"),store=new DiskStore(root,128*1024*1024);
    const source=await putSource(store,workspaceId,projectId,sourceFile),sourceId=source.id as string;
    const bundle=loadPack("sam31-video-mask"),{client,derived}=fakePrepare(bundle,projectId,source);
    const prepared=await prepareInvocation(client,[bundle],workspaceId,bodyFor(bundle,projectId,sourceId,{tracking:{prompt:"jacket"}}),store);
    expect(prepared.invocation.inputs.source_video).not.toBe(sourceId);
    expect(prepared.invocation.fpsPrepare).toMatchObject({frames:81,fps:16,width:160,height:96});
    expect(prepared.invocation.fpsPrepare!.notice).toBeUndefined();
    expect(prepared.invocation.trackingSnapshot).toMatchObject({sourceAssetId:prepared.invocation.fpsPrepare!.preparedAssetId,frames:81,fps:16,trackingMode:"prompt"});
    expect(derived).toHaveLength(1);
  },90000);
});
