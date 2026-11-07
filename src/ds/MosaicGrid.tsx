import {useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import './mosaic-grid.css';
import {useDensity} from './components';

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
/** Width / height of the picture or clip in a finished tile; null while it loads or while the tile is still working. */
function tileShape(cell:Element){
 if(cell.querySelector('[data-develop]'))return null;
 const media=cell.querySelector('video,img');
 if(media instanceof HTMLVideoElement)return media.videoHeight?media.videoWidth/media.videoHeight:null;
 return media instanceof HTMLImageElement&&media.naturalHeight?media.naturalWidth/media.naturalHeight:null;
}

export function MosaicGrid({label,head,children}:{label:string;
 /** The feed's header line; its `end` part (a filter) is revealed on hover or focus. */
 head?:{start:ReactNode;end?:ReactNode};children:ReactNode}){
 const grid=useRef<HTMLDivElement>(null),[density]=useDensity(),[narrow,setNarrow]=useState(false);
 useEffect(()=>{const el=grid.current;if(!el||typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(([entry])=>setNarrow(entry.contentRect.width<720));observer.observe(el);return()=>observer.disconnect();},[]);
 const cols=narrow?Math.min(2,density):density;
 /* Placement is measured, not declared: each tile's height comes from its media, so the grid places the cells
    itself whenever a tile changes size or the feed changes, and React never sets a cell's grid position. */
 useEffect(()=>{const el=grid.current;if(!el||typeof ResizeObserver==='undefined')return;
  let frame=0;
  const layout=()=>{frame=0;const heights=new Array<number>(cols).fill(0),cells=Array.from(el.children) as HTMLElement[],shapes=cells.map(tileShape);
   /* A working tile takes its neighbour's shape until it knows its own, set before the heights are measured. */
   cells.forEach((cell,index)=>{if(!cell.querySelector('[data-develop]'))return;const shape=nearestShape(shapes,index);if(shape)cell.style.setProperty('--mosaic-neighbour',String(shape));else cell.style.removeProperty('--mosaic-neighbour');});
   for(const cell of cells){
    const inner=cell.firstElementChild as HTMLElement|null,rows=Math.max(1,Math.ceil((inner?.getBoundingClientRect().height??0)/ROW));
    let column=0;for(let i=1;i<cols;i++)if(heights[i]<heights[column])column=i;
    cell.style.gridColumn=String(column+1);cell.style.gridRow=`${heights[column]+1} / span ${rows}`;heights[column]+=rows;
   }};
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(layout);};
  const sizes=new ResizeObserver(schedule);
  const watch=()=>{sizes.disconnect();for(const cell of Array.from(el.children))if(cell.firstElementChild)sizes.observe(cell.firstElementChild);schedule();};
  const feed=new MutationObserver(watch);feed.observe(el,{childList:true});watch();
  return()=>{feed.disconnect();sizes.disconnect();if(frame)cancelAnimationFrame(frame);};
 },[cols]);
 return <section className="ds-mosaic" aria-label={label}>
  {head&&<div className="ds-mosaic__head"><span className="ds-mosaic__title">{head.start}</span>{head.end&&<span className="ds-mosaic__filter">{head.end}</span>}</div>}
  <div ref={grid} className="ds-mosaic__grid" role="list" style={{['--mosaic-cols' as string]:cols,['--mosaic-row' as string]:`${ROW}px`} as CSSProperties}>
   {children}
  </div>
 </section>;
}

/** One tile, one column wide; its height is that of the picture or clip inside. */
export function MosaicTile({current,id,children}:{/** No longer changes the size; kept for callers. */accent?:0|1|2;/** Kept for callers; the media sets the height. */aspect?:number;
 /** Made in the app that is open now: marked quietly. */
 current?:boolean;id?:string;children:ReactNode}){
 return <div id={id} className="ds-mosaic__cell" role="listitem" data-current={current||undefined}>
  <div className="ds-mosaic__inner">{children}</div>
 </div>;
}
