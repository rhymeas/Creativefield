import {createContext,useRef,type ReactNode} from "react";

export type MediaDirection = -1 | 1;
type Entry = { available: () => boolean; open: () => void };
export const MediaSequenceContext = createContext<Map<HTMLElement, Entry> | null>(null);

/** Scope Full View browsing to one collection, in its rendered item order. */
export function MediaSequence({children}:{children:ReactNode}){
  const entries=useRef(new Map<HTMLElement,Entry>());
  return <MediaSequenceContext.Provider value={entries.current}>{children}</MediaSequenceContext.Provider>;
}

export function adjacentMedia(entries:Map<HTMLElement,Entry>,origin:HTMLElement,direction:MediaDirection){
  const order=[...entries].filter(([element,entry])=>element.isConnected&&element.getClientRects().length&&entry.available())
    .sort(([a],[b])=>a===b?0:a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1);
  return adjacentItem(order,([element])=>element===origin,direction)?.[1];
}

export function adjacentItem<T>(items:readonly T[],isCurrent:(item:T)=>boolean,direction:MediaDirection):T|undefined{
  const index=items.findIndex(isCurrent);
  return index<0?undefined:items[index+direction];
}
