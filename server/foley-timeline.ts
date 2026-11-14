/** Plan contiguous ControlFoley windows in integer milliseconds.
 * Distribute time evenly so a short final remainder is not below the model's minimum. */
export function planFoleyWindows(durationSeconds:number):Array<{startMs:number;endMs:number}>{
 if(!Number.isFinite(durationSeconds)||durationSeconds<0.7)throw new Error('Video must be at least 0.7 seconds long.');
 const total=Math.round(durationSeconds*1000);
 if(!Number.isSafeInteger(total))throw new Error('Video duration is too large.');
 const count=Math.ceil(total/30000),base=Math.floor(total/count),remainder=total%count;
 if(count>100000)throw new Error('Video duration is too large.');
 const windows:Array<{startMs:number;endMs:number}>=[];let position=0;
 for(let index=0;index<count;index++){const end=position+base+(index<remainder?1:0);windows.push({startMs:position,endMs:end});position=end;}
 return windows;
}
