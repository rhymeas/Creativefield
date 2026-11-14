import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

/** Inspect a fixture without queueing a ComfyUI job. */
export function probeFixtureVideo(directory:string,filename:string,ffprobe=process.env.FFPROBE_PATH??'ffprobe'):{frames:number;fps:number}{
 const probe=spawnSync(ffprobe,['-v','error','-select_streams','v:0','-count_frames','-show_entries','stream=nb_read_frames,avg_frame_rate','-of','json',join(directory,filename)],{encoding:'utf8',timeout:30_000});
 if(probe.status!==0)throw new Error(`cannot probe video fixture: ${probe.error?.message??probe.stderr?.trim()}`);
 const stream=JSON.parse(probe.stdout).streams?.[0] as {nb_read_frames?:string;avg_frame_rate?:string}|undefined;
 const [numerator,denominator]=(stream?.avg_frame_rate??'').split('/').map(Number),frames=Number(stream?.nb_read_frames);
 if(!Number.isSafeInteger(frames)||frames<1)throw new Error('video fixture must have a readable frame count');
 return {frames,fps:denominator?numerator/denominator:NaN};
}
