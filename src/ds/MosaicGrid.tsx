import {createContext,useContext,useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import './mosaic-grid.css';

/* A dense mosaic of results in mixed sizes. Each tile takes columns by its media's real shape (portrait narrow,
   landscape wide) plus an optional accent, and rows by its measured height, so tiles of every size pack
   together without gaps or a uniform grid. */
const ROW=4; // px per grid row; a tile's height is rounded up to this
const mosaicContext=createContext<{cols:number}>({cols:12});

/** Columns a tile takes out of 12 (or 6 on a narrow feed). */
export function mosaicSpan(aspect:number,accent:0|1|2,cols:number){
 const base=aspect>=1.6?6:aspect>=1.15?5:aspect>=.85?4:3;
 const span=base+(accent===2?3:accent===1?1:0);
 return Math.min(cols,cols===12?span:Math.max(3,Math.round(span/2)));
}
/** The accent of the tile at this position: the newest is large, every fifth after it a little larger. */
export const mosaicAccent=(index:number):0|1|2=>index===0?2:index%5===3?1:0;

export function MosaicGrid({label,head,children}:{label:string;
 /** The feed's header line; its `end` part (a filter) is revealed on hover or focus. */
 head?:{start:ReactNode;end?:ReactNode};children:ReactNode}){
 const grid=useRef<HTMLDivElement>(null),[cols,setCols]=useState(12);
 useEffect(()=>{const el=grid.current;if(!el||typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(([entry])=>setCols(entry.contentRect.width<720?6:12));observer.observe(el);return()=>observer.disconnect();},[]);
 return <section className="ds-mosaic" aria-label={label}>
  {head&&<div className="ds-mosaic__head"><span className="ds-mosaic__title">{head.start}</span>{head.end&&<span className="ds-mosaic__filter">{head.end}</span>}</div>}
  <div ref={grid} className="ds-mosaic__grid" role="list" style={{['--mosaic-cols' as string]:cols,['--mosaic-row' as string]:`${ROW}px`} as CSSProperties}>
   <mosaicContext.Provider value={{cols}}>{children}</mosaicContext.Provider>
  </div>
 </section>;
}

/** One tile. Its shape comes from the first picture or clip inside once it loads (`aspect` is the guess until then). */
export function MosaicTile({accent=0,aspect:guess=16/9,current,id,children}:{accent?:0|1|2;aspect?:number;
 /** Made in the app that is open now: marked quietly. */
 current?:boolean;id?:string;children:ReactNode}){
 const {cols}=useContext(mosaicContext),cell=useRef<HTMLDivElement>(null),inner=useRef<HTMLDivElement>(null);
 const [aspect,setAspect]=useState(guess),[rows,setRows]=useState(60);
 useEffect(()=>{const el=cell.current;if(!el)return;
  const read=()=>{const media=el.querySelector('img,video');const ratio=media instanceof HTMLImageElement&&media.naturalWidth?media.naturalWidth/media.naturalHeight:media instanceof HTMLVideoElement&&media.videoWidth?media.videoWidth/media.videoHeight:0;if(ratio)setAspect(old=>Math.abs(old-ratio)>.01?ratio:old);};
  read();el.addEventListener('load',read,true);el.addEventListener('loadedmetadata',read,true);
  return()=>{el.removeEventListener('load',read,true);el.removeEventListener('loadedmetadata',read,true);};},[]);
 useEffect(()=>{const el=inner.current;if(!el||typeof ResizeObserver==='undefined')return;
  const observer=new ResizeObserver(()=>setRows(Math.max(1,Math.ceil(el.getBoundingClientRect().height/ROW))));
  observer.observe(el);return()=>observer.disconnect();},[]);
 return <div ref={cell} id={id} className="ds-mosaic__cell" role="listitem" data-current={current||undefined} data-accent={accent||undefined} style={{gridColumn:`span ${mosaicSpan(aspect,accent,cols)}`,gridRow:`span ${rows}`}}>
  <div ref={inner} className="ds-mosaic__inner">{children}</div>
 </div>;
}
