import {useState} from 'react';
import {MediaViewer,setAssetDrag} from './components';
import './compare-strip.css';

/** Inputs and result side by side, so identity and placement can be judged at a glance. The last item is the result. */
export function CompareStrip({items,label="Compare"}:{items:Array<{src:string;label:string;asset?:{id:string;contentType?:string}}>;label?:string}){
  const [viewing,setViewing]=useState<{src:string;label:string}|null>(null);
  if(items.length<2)return null;
  return <><div className="ds-comparestrip" role="group" aria-label={label} style={{gridTemplateColumns:`repeat(${items.length},minmax(0,1fr))`}}>
    {items.map((item,i)=><figure key={`${item.label}-${i}`} className="ds-comparestrip__item" data-result={i===items.length-1||undefined} draggable={!!item.asset} onDragStart={item.asset?event=>setAssetDrag(event,item.asset!.id,item.src,item.asset!.contentType??"image/*"):undefined}>
      <button type="button" className="ds-comparestrip__open" aria-label={`Open ${item.label} full view`} onClick={()=>setViewing(item)}><img src={item.src} alt="" draggable={false}/></button>
      <figcaption>{item.label}</figcaption>
    </figure>)}
  </div><MediaViewer open={!!viewing} src={viewing?.src??''} name={viewing?.label??''} onClose={()=>setViewing(null)}/></>;
}
