import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp} from "node:fs/promises";
import path from "node:path";
const execute=promisify(execFile);
export async function maskFixtures(){
  const dir=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/mask-fixture-");
  async function make(name:string,filter:string,frames=17,extra:string[]=[]){
    const file=path.join(dir,`${name}.mp4`);
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-y","-f","lavfi","-i",filter,"-frames:v",String(frames),"-c:v","libx264","-crf","0","-pix_fmt","yuv420p",...extra,file],{windowsHide:true,timeout:15000});return file;
  }
  const source=await make("source","color=c=gray:s=160x96:r=16");
  const mask=await make("mask","color=c=black:s=160x96:r=16,drawbox=x=32:y=16:w=64:h=64:color=white:t=fill");
  return {dir,source,mask,make};
}
