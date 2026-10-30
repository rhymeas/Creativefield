/** Reads still frames from a finished sweep clip in the browser. The clip is a same-origin asset, so the canvas stays readable. */
export type SweepStill={blob:Blob;url:string};

function seekTo(video:HTMLVideoElement,time:number){
  return new Promise<void>((resolve,reject)=>{
    const done=()=>{video.removeEventListener("seeked",done);video.removeEventListener("error",fail);resolve();};
    const fail=()=>{video.removeEventListener("seeked",done);video.removeEventListener("error",fail);reject(new Error("The camera clip could not be read."));};
    video.addEventListener("seeked",done);video.addEventListener("error",fail);video.currentTime=time;
  });
}

export async function readSweepFrames(src:string,timesFor:(duration:number)=>number[],signal?:AbortSignal):Promise<SweepStill[]>{
  const video=document.createElement("video");
  video.muted=true;video.preload="auto";video.crossOrigin="use-credentials";video.src=src;
  await new Promise<void>((resolve,reject)=>{
    video.addEventListener("loadeddata",()=>resolve(),{once:true});
    video.addEventListener("error",()=>reject(new Error("The camera clip could not be loaded.")),{once:true});
  });
  const canvas=document.createElement("canvas");canvas.width=video.videoWidth;canvas.height=video.videoHeight;
  const context=canvas.getContext("2d");if(!context)throw new Error("This browser cannot read video frames.");
  const stills:SweepStill[]=[];
  try{
    for(const time of timesFor(video.duration)){
      if(signal?.aborted)throw new DOMException("Aborted","AbortError");
      await seekTo(video,time);context.drawImage(video,0,0);
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("A frame could not be encoded.")),"image/png"));
      stills.push({blob,url:URL.createObjectURL(blob)});
    }
  }catch(error){for(const still of stills)URL.revokeObjectURL(still.url);throw error;}
  finally{video.removeAttribute("src");video.load();}
  return stills;
}
