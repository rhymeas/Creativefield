import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createReadStream} from "node:fs";
import {mkdir,mkdtemp} from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import path from "node:path";
import {DiskStore} from "../server/storage";
import {fileSha256} from "../server/masked-media";
const execute=promisify(execFile);
export async function motionFixtures(){
  const base=(process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform";await mkdir(base,{recursive:true});
  const dir=await mkdtemp(path.join(base,"motion-fixture-"));
  const store=new DiskStore(path.join(dir,"store"),256*1024*1024),workspaceId=randomUUID();
  const ffmpeg=process.env.FFMPEG_PATH??"ffmpeg";
  async function make(name:string,filter:string,frames=48,extra:string[]=[]){
    const file=path.join(dir,`${name}.mp4`);
    await execute(ffmpeg,["-v","error","-y","-f","lavfi","-i",filter,"-frames:v",String(frames),"-c:v","libx264","-preset","ultrafast","-crf","18","-pix_fmt","yuv420p",...extra,file],{windowsHide:true,timeout:60000});
    return file;
  }
  async function put(file:string){return store.put(workspaceId,createReadStream(file));}
  async function makeStored(name:string,filter:string,frames=48,extra:string[]=[]){
    const file=await make(name,filter,frames,extra),stored=await put(file);
    return {file,key:stored.key,sha256:stored.sha256};
  }
  async function withAudio(name:string,source:string){
    const file=path.join(dir,`${name}.mp4`);
    await execute(ffmpeg,["-v","error","-y","-i",source,"-f","lavfi","-i","anullsrc=r=48000:cl=mono","-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-shortest",file],{windowsHide:true,timeout:30000});
    return file;
  }
  async function rotated(name:string,source:string){
    const file=path.join(dir,`${name}.mp4`);
    await execute(ffmpeg,["-v","error","-y","-display_rotation","90","-i",source,"-c","copy","-metadata","title=fixture-secret",file],{windowsHide:true,timeout:30000});
    return file;
  }
  async function sarAndRotated(name:string,source:string){
    const sarFile=path.join(dir,`${name}-sar.mp4`),file=path.join(dir,`${name}.mp4`);
    await execute(ffmpeg,["-v","error","-y","-i",source,"-vf","setsar=2/1","-c:v","libx264","-preset","ultrafast","-crf","18","-pix_fmt","yuv420p",sarFile],{windowsHide:true,timeout:30000});
    await execute(ffmpeg,["-v","error","-y","-display_rotation","90","-i",sarFile,"-c","copy",file],{windowsHide:true,timeout:30000});
    return file;
  }
  return {dir,store,workspaceId,make,put,makeStored,withAudio,rotated,sarAndRotated,sha256:fileSha256};
}
export function expectedTimingDigest(frames:number){
  return createHash("sha256").update(JSON.stringify(Array.from({length:frames},(_,i)=>Math.round(i*1000000/24)))).digest("hex");
}
