/** Link two local previews by elapsed time, over their common duration.
 * Native media events drive synchronization; no timer or background polling. */
export function linkMediaPlayback(left:HTMLMediaElement,right:HTMLMediaElement,onBlocked?:(message:string)=>void){
  let disposed=false,driver=left;
  const echo=new WeakMap<HTMLMediaElement,number>();
  const removers:Array<()=>void>=[];
  const other=(media:HTMLMediaElement)=>media===left?right:left;
  const duration=()=>Math.min(left.duration,right.duration);
  const setTime=(media:HTMLMediaElement,time:number)=>{
    if(!Number.isFinite(media.duration)||media.duration<=0)return;
    const value=Math.max(0,Math.min(time,media.duration));
    if(Math.abs(media.currentTime-value)<.04)return;
    echo.set(media,value);media.currentTime=value;
  };
  const align=(source:HTMLMediaElement)=>{
    const end=duration();if(!Number.isFinite(end)||end<=0)return;
    const time=Math.min(source.currentTime,end);setTime(source,time);setTime(other(source),time);
  };
  const pauseBoth=()=>{if(!left.paused)left.pause();if(!right.paused)right.pause();};
  const play=(source:HTMLMediaElement)=>{
    // Native events can arrive after a user has already paused/restarted.
    if(disposed||source.paused)return;
    driver=source;
    const end=duration();if(Number.isFinite(end)&&source.currentTime>=end-.04){setTime(left,0);setTime(right,0);}
    align(source);const target=other(source);
    if(target.paused)void target.play().catch((error:unknown)=>{if(disposed||source.paused||(error instanceof Error&&error.name==="AbortError"))return;pauseBoth();onBlocked?.("Playback was blocked. Press play again, or unlink the previews to play each separately.");});
  };
  const listen=(media:HTMLMediaElement,event:string,handler:()=>void)=>{media.addEventListener(event,handler);removers.push(()=>media.removeEventListener(event,handler));};
  for(const media of [left,right]){
    listen(media,"play",()=>play(media));
    listen(media,"pause",()=>{if(!media.paused)return;const target=other(media);if(!target.paused)target.pause();});
    listen(media,"seeking",()=>{
      const expected=echo.get(media);echo.delete(media);
      if(expected!==undefined&&Math.abs(media.currentTime-expected)<.04)return;
      driver=media;align(media);
    });
    listen(media,"timeupdate",()=>{if(media===driver&&!media.paused&&!media.seeking)align(media);});
    listen(media,"loadedmetadata",()=>align(driver));
    listen(media,"ended",pauseBoth);
  }
  align(left);
  if(!left.paused)play(left);else if(!right.paused)play(right);
  return()=>{disposed=true;removers.forEach(remove=>remove());};
}
