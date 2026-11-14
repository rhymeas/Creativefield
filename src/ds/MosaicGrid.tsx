import {useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import './mosaic-grid.css';
import {useDensity} from './components';
import {usePhone} from './gestures';
import {MediaSequence} from './MediaSequence';

/* The shared result feed. Its columns follow the global size slider (useDensity) like every result grid; each
   tile is one column wide and as tall as its media. Tiles go, in feed order, into the column that is shortest so
   far (masonry), so columns grow evenly and no gaps open between tiles. */
const ROW=1; // px per grid row, so every gap between tiles is exactly the same

/** Columns a tile took in the earlier 12-column mosaic; kept for callers, the feed itself now gives every tile one column. */
export function mosaicSpan(aspect:number,accent:0|1|2,cols:number){
 const base=aspect>=1.6?6:aspect>=1.15?5:aspect>=.85?4:3;
 const span=base+(accent===2?3:accent===1?1:0);
 return Math.min(cols,cols===12?span:Math.max(3,Math.round(span/2)));
}
/** Kept for callers: tiles no longer grow by position, the size slider sets every tile's width. */
export const mosaicAccent=(index:number):0|1|2=>index===0?2:index%5===3?1:0;

/** The shape of the finished tile closest to this one in the feed, the earlier one on a tie; undefined when none is finished. */
export function nearestShape(shapes:ReadonlyArray<number|null>,index:number){
 for(let distance=1;distance<shapes.length;distance++){const shape=shapes[index-distance]??shapes[index+distance];if(shape)return shape;}
 return undefined;
}
/** Where the next tile goes: the columns whose tallest is lowest, starting below that tallest column so a
 *  tile spanning two columns never lies on top of the tile in the taller one. `heights` are column heights in rows. */
export function placeTile(heights:readonly number[],span:number):{column:number;top:number}{
 const width=Math.min(span,heights.length);let column=0,top=Number.POSITIVE_INFINITY;
 for(let i=0;i+width<=heights.length;i++){const tallest=Math.max(...heights.slice(i,i+width));if(tallest<top){top=tallest;column=i;}}
 return {column,top};
}
/** Width / height of the picture or clip in a finished tile; null while it loads or while the tile is still working. */
function tileShape(cell:Element){
 if(cell.querySelector('[data-develop]'))return null;
 const media=cell.querySelector('video,img');
 if(media instanceof HTMLVideoElement&&media.videoHeight)return media.videoWidth/media.videoHeight;
 if(media instanceof HTMLImageElement&&media.naturalHeight)return media.naturalWidth/media.naturalHeight;
 /* Not loaded yet: the shape the tile declared, so a landscape picture takes its two columns at once instead of jumping later. */
 const declared=parseFloat((cell.firstElementChild as HTMLElement|null)?.style.getPropertyValue('--mosaic-shape')??'');
 return declared>0?declared:null;
}

export function MosaicGrid({label,head,children,maxColumns}:{label:string;
 /** The feed's header line; its `end` part (a filter) is revealed on hover or focus. */
 head?:{start:ReactNode;end?:ReactNode};children:ReactNode;
 /** A denser screen may cap the feed so its pictures stay large (3 columns for the library). */
 maxColumns?:number}){
 const grid=useRef<HTMLDivElement>(null),[density]=useDensity(),[narrow,setNarrow]=useState(false);
 useEffect(()=>{const el=grid.current;if(!el)return;setNarrow(el.getBoundingClientRect().width<720);if(typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(([entry])=>{setNarrow(entry.contentRect.width<720);});observer.observe(el);return()=>observer.disconnect();},[]);
 const phone=usePhone(),width=narrow||phone?Math.min(2,density):density,cols=Math.max(1,Math.min(width,maxColumns??width));
 /* Placement is measured, not declared: each tile's height comes from its media, so the grid places the cells
    itself whenever a tile changes size or the feed changes, and React never sets a cell's grid position. */
 useEffect(()=>{const el=grid.current;if(!el||typeof ResizeObserver==='undefined')return;
  let frame=0;
  const layout=()=>{frame=0;const heights=new Array<number>(cols).fill(0),cells=Array.from(el.children) as HTMLElement[],shapes=cells.map(tileShape);
   /* A working tile takes its neighbour's shape until it knows its own, set before the heights are measured. */
   cells.forEach((cell,index)=>{if(!cell.querySelector('[data-develop]'))return;const shape=nearestShape(shapes,index);if(shape)cell.style.setProperty('--mosaic-neighbour',String(shape));else cell.style.removeProperty('--mosaic-neighbour');});
   /* A landscape clip takes two columns when there is room, so it reads bigger than a portrait tile instead of
      every tile looking equally small; portrait and square tiles keep one column. Every width is set first and
      every height measured after, so a tile is never placed with the height it had at the other width. */
   const spans=shapes.map(shape=>shape&&shape>=1.15&&cols>=3?2:1);
   /* The old row goes too: tiles left in one fixed row would make the grid add columns and measure every tile too narrow. */
   cells.forEach((cell,index)=>{cell.style.gridRow='';cell.style.gridColumn=`span ${spans[index]}`;});
   cells.forEach((cell,index)=>{
    const inner=cell.firstElementChild as HTMLElement|null,rows=Math.max(1,Math.ceil((inner?.getBoundingClientRect().height??0)/ROW));
    const span=spans[index],{column,top}=placeTile(heights,span);
    cell.style.gridColumn=`${column+1} / span ${span}`;cell.style.gridRow=`${top+1} / span ${rows}`;
    for(let i=column;i<column+span;i++)heights[i]=top+rows;
   });};
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(layout);};
  const sizes=new ResizeObserver(schedule);
  const watch=()=>{sizes.disconnect();for(const cell of Array.from(el.children))if(cell.firstElementChild)sizes.observe(cell.firstElementChild);schedule();};
  const feed=new MutationObserver(watch);feed.observe(el,{childList:true});watch();
  return()=>{feed.disconnect();sizes.disconnect();if(frame)cancelAnimationFrame(frame);};
 },[cols]);
 return <section className="ds-mosaic" aria-label={label}>
  {head&&<div className="ds-mosaic__head"><span className="ds-mosaic__title">{head.start}</span>{head.end&&<span className="ds-mosaic__filter">{head.end}</span>}</div>}
  <div ref={grid} className="ds-mosaic__grid" role="list" style={{['--mosaic-cols' as string]:cols,['--mosaic-row' as string]:`${ROW}px`} as CSSProperties}>
   <MediaSequence>{children}</MediaSequence>
  </div>
 </section>;
}

/** One tile, one column wide; its height is that of the picture or clip inside. */
export function MosaicTile({current,id,shape,children}:{/** No longer changes the size; kept for callers. */accent?:0|1|2;/** Kept for callers; the media sets the height. */aspect?:number;
 /** Width / height of the media when it is already known: the tile keeps that shape while the media loads. */
 shape?:number|null;
 /** Made in the app that is open now: marked quietly. */
 current?:boolean;id?:string;children:ReactNode}){
 return <div id={id} className="ds-mosaic__cell" role="listitem" data-current={current||undefined}>
  <div className="ds-mosaic__inner" data-shaped={shape?true:undefined} style={shape?{['--mosaic-shape' as string]:shape} as CSSProperties:undefined}>{children}</div>
 </div>;
}

