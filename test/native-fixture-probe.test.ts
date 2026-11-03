import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {probeFixtureVideo} from '../src/workflow/native-fixture-probe';

afterEach(()=>vi.unstubAllEnvs());
describe('native video fixture probe',()=>{
 it('uses the configured FFprobe executable for a real video',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fixture-probe-'));
  try{
   execFileSync(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i','color=red:size=32x32:rate=8:duration=1','-c:v','libx264','-y',join(dir,'clip.mp4')]);
   const command=process.platform==='win32'?'where.exe':'which';
   const executable=process.env.FFPROBE_PATH??execFileSync(command,['ffprobe'],{encoding:'utf8'}).trim().split(/\r?\n/)[0];
   vi.stubEnv('FFPROBE_PATH',executable);
   expect(probeFixtureVideo(dir,'clip.mp4')).toEqual({frames:8,fps:8});
   vi.stubEnv('FFPROBE_PATH',join(dir,'missing-ffprobe'));
   expect(()=>probeFixtureVideo(dir,'clip.mp4')).toThrow('cannot probe video fixture');
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
});
