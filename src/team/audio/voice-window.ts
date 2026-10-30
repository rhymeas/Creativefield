export function voiceWindow(start:number,duration:number|undefined,total:number){
  if(!Number.isFinite(total)||total<=0||!Number.isFinite(start)||start<0||start>=total||duration!==undefined&&(!Number.isFinite(duration)||duration<=0))return null;
  const end=duration===undefined?total:start+duration;
  if(end>total+.025)return null;
  return {start,end:Math.min(total,end)};
}
