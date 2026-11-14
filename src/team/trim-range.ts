/** Keep the moved edge in bounds while respecting the input's duration limits. */
export function constrainTrimRange(start:number,end:number,previousStart:number,total:number,minimum:number,maximum:number):[number,number]{
 const movedStart=start!==previousStart;
 if(end-start>maximum)movedStart?end=start+maximum:start=end-maximum;
 if(end-start<minimum)movedStart?start=Math.max(0,end-minimum):end=Math.min(total,start+minimum);
 return [Math.max(0,start),Math.min(total,end)];
}
