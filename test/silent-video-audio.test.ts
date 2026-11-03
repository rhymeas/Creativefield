import {afterEach,describe,expect,it,vi} from "vitest";
import {execFileSync,spawnSync} from "node:child_process";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {withVideoAudio} from "../server/silent-video-audio";
import {ExecutionService,compileRunGraph} from "../server/execution";
import type {Pool} from "pg";
import type {DiskStore} from "../server/storage";
import type {CapabilityBundle} from "../src/capabilities/types";

const ffmpeg=process.env.FFMPEG_PATH??"ffmpeg",ffprobe=process.env.FFPROBE_PATH??"ffprobe";
const available=[ffmpeg,ffprobe].every(tool=>spawnSync(tool,["-version"],{windowsHide:true}).status===0);
describe.skipIf(!available)("object swap audio preparation",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("adds silent audio only to silent clips and preserves the original",async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),"cf-silent-test-"));
    try{
      const source=path.join(dir,"silent.mp4");
      execFileSync(ffmpeg,["-v","error","-y","-f","lavfi","-i","color=size=64x64:rate=10:duration=1","-c:v","libx264","-pix_fmt","yuv420p",source],{windowsHide:true});
      let temporary="";
      await withVideoAudio(source,async file=>{
        temporary=file;
        expect(file).not.toBe(source);
        const streams=JSON.parse(execFileSync(ffprobe,["-v","error","-show_entries","stream=codec_type","-of","json",file],{encoding:"utf8",windowsHide:true})).streams;
        expect(streams.map((s:{codec_type:string})=>s.codec_type)).toEqual(["video","audio"]);
        await withVideoAudio(file,async existing=>expect(existing).toBe(file));
      });
      await expect(stat(source)).resolves.toBeDefined();
      await expect(stat(temporary)).rejects.toMatchObject({code:"ENOENT"});
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it("uploads the prepared video and binds its actual name to the H3 graph",async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),"cf-silent-upload-"));
    try{
      const source=path.join(dir,"silent.mp4"),received=path.join(dir,"received.mkv");
      execFileSync(ffmpeg,["-v","error","-y","-f","lavfi","-i","color=size=64x64:rate=10:duration=1","-c:v","libx264","-pix_fmt","yuv420p",source],{windowsHide:true});
      const original=await readFile(source);
      vi.stubGlobal("fetch",async(_url:RequestInfo|URL,init?:RequestInit)=>{
        const file=(init!.body as FormData).get("image") as File;
        await writeFile(received,Buffer.from(await file.arrayBuffer()));
        return Response.json({name:file.name,subfolder:""});
      });
      const service=new ExecutionService({} as Pool,{file:async()=>source} as unknown as DiskStore,[]);
      const upload=(service as unknown as {uploadInputs:(run:unknown,worker:unknown,assets:unknown[],motion:undefined,prepare:boolean)=>Promise<Record<string,string>>}).uploadInputs.bind(service);
      const names=await upload({id:"run-1",workspace_id:"workspace-1"},{origin:"http://127.0.0.1:8199",api_prefix:"",kind:"local"},[{id:"asset-1",role:"source_video",content_type:"video/mp4",storage_key:"source"}],undefined,true);
      expect(names.source_video).toBe("comfyfield-run-1-asset-1.mkv");
      const streams=JSON.parse(execFileSync(ffprobe,["-v","error","-show_entries","stream=codec_type","-of","json",received],{encoding:"utf8",windowsHide:true})).streams;
      expect(streams.map((s:{codec_type:string})=>s.codec_type)).toEqual(["video","audio"]);
      expect(await readFile(source)).toEqual(original);
      const root="native-workflows/h3-object-swap";
      const bundle:CapabilityBundle={manifest:JSON.parse(await readFile(`${root}/manifest.json`,"utf8")),template:JSON.parse(await readFile(`${root}/template.api.json`,"utf8"))};
      const invocation={capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:"asset-1",character_image:"asset-2"},controls:{},audioPolicy:"preserve" as const};
      const graph=compileRunGraph(bundle,invocation,{...names,character_image:"comfyfield-run-1-asset-2.png"});
      expect(graph["5"].inputs.video).toBe(names.source_video);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
});
