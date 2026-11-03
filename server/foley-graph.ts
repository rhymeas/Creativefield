import candidate from '../workflow-candidates/controlfoley-video-sound.api.json';

/** Build a single selected video excerpt; ControlFoley accepts at most 30 seconds. */
export function foleySingleVideoGraph(uploadName:string,prompt:string,seed:number,startSeconds:number,durationSeconds:number):Record<string,unknown>{
 if(!/^comfyfield-[a-zA-Z0-9-]+\.mp4$/.test(uploadName))throw new Error('Invalid Foley video upload name.');
 if(!prompt.trim()||prompt.length>20000)throw new Error('Enter a sound description.');
 if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw new Error('Invalid Foley seed.');
 if(!Number.isFinite(startSeconds)||startSeconds<0||!Number.isFinite(durationSeconds)||durationSeconds<0.7||durationSeconds>30)throw new Error('Choose an excerpt between 0.7 and 30 seconds.');
 const graph=structuredClone(candidate);
 graph['1'].inputs.file=uploadName;
 graph['3'].inputs.prompt=prompt;
 graph['3'].inputs.seed=seed;
 // The pinned ControlFoley node derives duration from a connected video. Keep
 // the explicit value consistent as well, but the slice below is what bounds it.
 graph['3'].inputs.duration=durationSeconds;
 // ControlFoley prefers a VIDEO object's underlying filename and would bypass
 // Video Slice's trim window. Rebuild a video from the sliced frames so its
 // path-based input is materialized from exactly the selected excerpt.
 graph['3'].inputs.video_input=['8',0];
 graph['4'].inputs.video=['7',0];
 return {...graph,'7':{class_type:'Video Slice',inputs:{video:['1',0],start_time:startSeconds,duration:durationSeconds,strict_duration:false}},
  '8':{class_type:'CreateVideo',inputs:{images:['4',0],fps:['4',2]}}};
}

/** Bind one already-uploaded video window to the pinned ControlFoley candidate. */
export function foleySegmentGraph(uploadName:string,prompt:string,seed:number):Record<string,unknown>{
 if(!/^comfyfield-[a-zA-Z0-9-]+\.mp4$/.test(uploadName))throw new Error('Invalid Foley segment upload name.');
 if(!prompt.trim()||prompt.length>20000)throw new Error('Enter a sound description.');
 if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw new Error('Invalid Foley seed.');
 const graph=structuredClone(candidate);
 graph['1'].inputs.file=uploadName;
 graph['3'].inputs.prompt=prompt;
 graph['3'].inputs.seed=seed;
 return {'1':graph['1'],'2':graph['2'],'3':graph['3'],'6':{class_type:'SaveAudio',inputs:{audio:['3',0],filename_prefix:'ComfyField/foley-segment'}}};
}
