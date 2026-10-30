import {useEffect,useRef,useState,type PointerEvent} from "react";
import {Trash2} from "lucide-react";
import {Button,Dialog,IconButton,Meta,Notice} from "./components";
import {imageAnnotationsSchema,type ImageAnnotation} from "../image/annotations";

export function AnnotationEditor({open,src,initial=[],onClose,onApply}:{open:boolean;src:string;initial?:ImageAnnotation[];onClose:()=>void;onApply:(boxes:ImageAnnotation[])=>void|Promise<void>}) {
  const [boxes,setBoxes]=useState<ImageAnnotation[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const board=useRef<HTMLDivElement>(null),start=useRef<{x:number;y:number}|null>(null),[drawing,setDrawing]=useState<ImageAnnotation|null>(null);
  useEffect(()=>{if(open){setBoxes(initial.map(box=>({...box})));setError("");setDrawing(null);}},[open,src]);
  const point=(event:PointerEvent)=>{const r=board.current!.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))};};
  const valid=imageAnnotationsSchema.safeParse(boxes).success;
  async function apply(){if(!valid||busy)return;setBusy(true);setError("");try{await onApply(imageAnnotationsSchema.parse(boxes));}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  return <Dialog wide open={open} title="Annotate image" onClose={()=>{if(!busy)onClose();}} footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy} aria-disabled={!valid} aria-describedby={!valid?"annotation-hint":undefined} onClick={()=>void apply()}>Use annotations</Button></>}>
    <Meta>Draw a box, then describe its change. Add another box for each edit.</Meta>
    {boxes.length<8&&<Button disabled={busy} onClick={()=>setBoxes(old=>old.length<8?[...old,{x:.05+(old.length%3)*.3,y:.05+Math.floor(old.length/3)*.3,w:.25,h:.2,instruction:""}]:old)}>Add region</Button>}
    <div ref={board} className="ds-annotation" onPointerDown={event=>{if(event.button!==0||busy||boxes.length>=8||(event.target as HTMLElement).closest("input,button"))return;event.preventDefault();start.current=point(event);event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{if(!start.current)return;const p=point(event),s=start.current;setDrawing({x:Math.min(p.x,s.x),y:Math.min(p.y,s.y),w:Math.abs(p.x-s.x),h:Math.abs(p.y-s.y),instruction:""});}}
      onPointerUp={event=>{if(start.current){const p=point(event),s=start.current,box={x:Math.min(p.x,s.x),y:Math.min(p.y,s.y),w:Math.abs(p.x-s.x),h:Math.abs(p.y-s.y),instruction:""};if(box.w>.005&&box.h>.005)setBoxes(old=>old.length<8?[...old,box]:old);}start.current=null;setDrawing(null);}}
      onPointerCancel={()=>{start.current=null;setDrawing(null);}}>
      <img src={src} alt="Image to annotate" draggable={false}/>
      {[...boxes,...(drawing?[drawing]:[])].map((box,index)=><div key={index} className="ds-annotation__box" tabIndex={index<boxes.length?0:undefined} role="group" aria-label={`Region ${index+1}. Arrow keys move; Shift and arrows resize; Delete removes.`} onKeyDown={event=>{
        if((event.target as HTMLElement).closest("input,button"))return;
        if(event.key==="Delete"&&!busy){event.preventDefault();event.stopPropagation();setBoxes(old=>old.filter((_,i)=>i!==index));return;}
        if(!event.key.startsWith("Arrow")||busy)return;event.preventDefault();event.stopPropagation();
        const dx=event.key==="ArrowRight"?.01:event.key==="ArrowLeft"?-.01:0,dy=event.key==="ArrowDown"?.01:event.key==="ArrowUp"?-.01:0;
        setBoxes(old=>old.map((item,i)=>i!==index?item:event.shiftKey?{...item,w:Math.max(.02,Math.min(1-item.x,item.w+dx)),h:Math.max(.02,Math.min(1-item.y,item.h+dy))}:{...item,x:Math.max(0,Math.min(1-item.w,item.x+dx)),y:Math.max(0,Math.min(1-item.h,item.y+dy))}));
      }} style={{left:`${box.x*100}%`,top:`${box.y*100}%`,width:`${box.w*100}%`,height:`${box.h*100}%`}}>
        <span className="ds-annotation__number">{index+1}</span>
        {index<boxes.length&&<div className="ds-annotation__caption" style={box.x>.65?{right:0}:{left:0}}><input aria-label={`Change for region ${index+1}`} placeholder="What should change here?" value={box.instruction} maxLength={500} disabled={busy} onChange={event=>setBoxes(old=>old.map((item,i)=>i===index?{...item,instruction:event.target.value}:item))}/><IconButton label={`Remove region ${index+1}`} disabled={busy} onClick={()=>setBoxes(old=>old.filter((_,i)=>i!==index))}><Trash2 size={12}/></IconButton></div>}
      </div>)}
    </div>
    {!valid&&<div id="annotation-hint"><Meta>{!boxes.length?"Draw the first region on the image.":boxes.some(box=>!box.instruction.trim())?"Describe the change for each region.":"Keep up to eight regions inside the image."}</Meta></div>}
    {error&&<Notice inline priority={20} title="Annotations not applied">{error}</Notice>}
  </Dialog>;
}
