/*
 * Touch gestures for the phone layout (rule 27). Plain pointer events, no library: the element follows the
 * finger, a long or fast enough pull finishes the gesture, anything shorter springs back. Desktop never sees
 * them: every hook is idle unless the phone query matches.
 */
import {useEffect,useSyncExternalStore,type RefObject} from "react";

/** The one phone breakpoint. CSS uses the same width in `mobile.css`; keep them equal. */
export const PHONE_QUERY="(max-width: 760px)";

const subscribe=(change:()=>void)=>{if(typeof matchMedia==="undefined")return()=>{};const q=matchMedia(PHONE_QUERY);q.addEventListener("change",change);return()=>q.removeEventListener("change",change);};
/** True on a phone-sized window; follows rotation and resizing. */
export function usePhone(){
  return useSyncExternalStore(subscribe,()=>typeof matchMedia!=="undefined"&&matchMedia(PHONE_QUERY).matches,()=>false);
}

/** How far and how fast a pull must go before it counts. */
export const PULL={distance:96,speed:.55};
/** Whether a pull of `dy` pixels over `ms` milliseconds should finish the gesture. */
export function pullFinishes(dy:number,ms:number){return dy>=PULL.distance||(dy>24&&dy/Math.max(ms,1)>=PULL.speed);}

const reduced=()=>typeof matchMedia!=="undefined"&&matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Pull a sheet down to close it. The pull starts on its grab handle or head (`[data-sheet-grab]`), or anywhere
 * on the sheet while its content is scrolled to the top. `ref` is the sheet, or a wrapper whose `[data-sheet]`
 * child is the sheet.
 */
export function useDragDismiss(ref:RefObject<HTMLElement|null>,onClose:()=>void,active=true){
  const phone=usePhone();
  useEffect(()=>{
    const root=ref.current;if(!root||!active||!phone)return;
    let start:{y:number;t:number;id:number}|null=null,sheet:HTMLElement|null=null,dy=0;
    const down=(e:PointerEvent)=>{
      if(e.pointerType==="mouse")return;
      sheet=(root.matches("[data-sheet]")?root:root.querySelector<HTMLElement>("[data-sheet]"));if(!sheet)return;
      const target=e.target as HTMLElement,grab=!!target.closest("[data-sheet-grab]");
      const scroller=target.closest<HTMLElement>("[data-sheet-scroll]");
      if(!grab&&(!sheet.contains(target)||(scroller&&scroller.scrollTop>0)||target.closest("input,textarea,select,video,[data-no-pull]")))return;
      start={y:e.clientY,t:performance.now(),id:e.pointerId};dy=0;
    };
    const move=(e:PointerEvent)=>{
      if(!start||e.pointerId!==start.id||!sheet)return;
      dy=Math.max(0,e.clientY-start.y);
      if(dy<6)return;
      sheet.style.transition="none";sheet.style.transform=`translateY(${dy}px)`;
      if(e.cancelable)e.preventDefault();
    };
    const up=(e:PointerEvent)=>{
      if(!start||e.pointerId!==start.id||!sheet)return;
      const done=pullFinishes(dy,performance.now()-start.t),el=sheet;start=null;
      el.style.transition=reduced()?"none":"transform var(--dur-med) var(--ease)";
      if(done){el.style.transform="translateY(100%)";setTimeout(onClose,reduced()?0:160);}
      else{el.style.transform="";setTimeout(()=>{el.style.transition="";},220);}
    };
    root.addEventListener("pointerdown",down);
    addEventListener("pointermove",move,{passive:false});
    addEventListener("pointerup",up);addEventListener("pointercancel",up);
    return()=>{root.removeEventListener("pointerdown",down);removeEventListener("pointermove",move);removeEventListener("pointerup",up);removeEventListener("pointercancel",up);};
  },[ref,onClose,active,phone]);
}

/**
 * Swipe the media in the full view down to close it, as in a phone gallery. The media follows the finger and
 * the backdrop fades with it; a short swipe springs back.
 */
export function useSwipeClose(ref:RefObject<HTMLElement|null>,onClose:()=>void,active=true){
  const phone=usePhone();
  useEffect(()=>{
    const el=ref.current;if(!el||!active||!phone)return;
    let start:{x:number;y:number;t:number;id:number}|null=null,dy=0,vertical:boolean|null=null;
    const down=(e:PointerEvent)=>{
      if(e.pointerType==="mouse"||(e.target as HTMLElement).closest("button,a,input,[data-no-pull]"))return;
      const scroller=el.closest<HTMLElement>("[data-sheet-scroll]");if(scroller&&scroller.scrollTop>0)return;
      start={x:e.clientX,y:e.clientY,t:performance.now(),id:e.pointerId};dy=0;vertical=null;
    };
    const move=(e:PointerEvent)=>{
      if(!start||e.pointerId!==start.id)return;
      const dx=e.clientX-start.x;dy=e.clientY-start.y;
      if(vertical===null&&Math.hypot(dx,dy)>10)vertical=Math.abs(dy)>Math.abs(dx)&&dy>0;
      if(!vertical)return;
      el.style.transition="none";el.style.transform=`translateY(${Math.max(0,dy)}px) scale(${1-Math.min(.12,Math.max(0,dy)/2400)})`;
      el.style.setProperty("--pull",String(Math.min(1,Math.max(0,dy)/320)));
      if(e.cancelable)e.preventDefault();
    };
    const up=(e:PointerEvent)=>{
      if(!start||e.pointerId!==start.id)return;
      const done=vertical&&pullFinishes(dy,performance.now()-start.t);start=null;
      el.style.transition=reduced()?"none":"transform var(--dur-med) var(--ease)";
      if(done){onClose();return;}
      el.style.transform="";el.style.removeProperty("--pull");setTimeout(()=>{el.style.transition="";},220);
    };
    el.addEventListener("pointerdown",down);
    addEventListener("pointermove",move,{passive:false});
    addEventListener("pointerup",up);addEventListener("pointercancel",up);
    return()=>{el.removeEventListener("pointerdown",down);removeEventListener("pointermove",move);removeEventListener("pointerup",up);removeEventListener("pointercancel",up);};
  },[ref,onClose,active,phone]);
}
