/** Inputs and result side by side, so identity and placement can be judged at a glance. The last item is the result. */
export function CompareStrip({items,label="Compare"}:{items:Array<{src:string;label:string}>;label?:string}){
  if(items.length<2)return null;
  return <div className="ds-comparestrip" role="group" aria-label={label} style={{gridTemplateColumns:`repeat(${items.length-1},minmax(0,1fr)) minmax(0,1.6fr)`}}>
    {items.map((item,i)=><figure key={`${item.label}-${i}`} className="ds-comparestrip__item" data-result={i===items.length-1||undefined}>
      <img src={item.src} alt={item.label}/>
      <figcaption>{item.label}</figcaption>
    </figure>)}
  </div>;
}
