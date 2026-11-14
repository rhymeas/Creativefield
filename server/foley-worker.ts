import {foleySegmentGraph} from './foley-graph';
import {withGeneratedFoleyExcerpt} from './foley-orchestrate';

/** The caller owns durable dispatch, cancellation and recovery for each segment. */
export type FoleySegmentWorker={
 upload:(clip:string,signal?:AbortSignal)=>Promise<string>;
 run:(graph:Record<string,unknown>,segmentKey:string,destination:string,signal?:AbortSignal)=>Promise<void>;
};

/** Adapter for withGeneratedFoley; it never creates its own polling loop. */
export function foleyWorkerGenerator(worker:FoleySegmentWorker,jobId:string,prompt:string,seed:number){
 if(!/^[a-zA-Z0-9-]{1,80}$/.test(jobId))throw new Error('Invalid Foley job ID.');
 if(!prompt.trim()||prompt.length>20000)throw new Error('Enter a sound description.');
 if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw new Error('Invalid Foley seed.');
 return async(clip:string,destination:string,index:number,signal?:AbortSignal):Promise<void>=>{
  if(!Number.isSafeInteger(index)||index<0)throw new Error('Invalid Foley segment index.');
  signal?.throwIfAborted();
  const name=await worker.upload(clip,signal);
  signal?.throwIfAborted();
  const graph=foleySegmentGraph(name,prompt,seed);
  await worker.run(graph,`foley:${jobId}:${index}`,destination,signal);
 };
}

/** The durable job owner supplies the worker and consumes the completed excerpt. */
export async function withWorkerFoleyExcerpt<T>(worker:FoleySegmentWorker,jobId:string,prompt:string,seed:number,video:string,startSeconds:number,durationSeconds:number,consume:(video:string)=>Promise<T>,signal?:AbortSignal):Promise<T>{
 const generate=foleyWorkerGenerator(worker,jobId,prompt,seed);
 return withGeneratedFoleyExcerpt(video,startSeconds,durationSeconds,(clip,audio,abort)=>generate(clip,audio,0,abort),consume,signal);
}
