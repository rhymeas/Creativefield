import {createContext,useCallback,useContext,useEffect,useId,useState,type ReactNode} from "react";
import {InfoButton,LinkButton,Meta} from "../ds";
type Entry={owner:string;title:string;content:ReactNode};
const Context=createContext<{entry?:Entry;set:(entry:Entry)=>void;clear:(owner:string)=>void}>({set:()=>{},clear:()=>{}});
export function WorkflowInfoProvider({children}:{children:ReactNode}){
 const [entry,setEntry]=useState<Entry>();const set=useCallback((next:Entry)=>setEntry(next),[]);const clear=useCallback((owner:string)=>setEntry(old=>old?.owner===owner?undefined:old),[]);
 return <Context.Provider value={{entry,set,clear}}>{children}</Context.Provider>;
}
/** Workflow help has one home: the workspace's top-right info dialog. */
export function WorkflowDescription({title,children}:{title:string;children:ReactNode}){
 const owner=useId(),{set,clear}=useContext(Context);useEffect(()=>{set({owner,title,content:children});return()=>clear(owner);},[owner,title,children,set,clear]);return null;
}
/** Where a workflow or idea comes from, with a link to it. Shown at the end of the workspace info dialog. */
export function SourceCredit({credit}:{credit?:{name:string;url:string;license:string;what:string}}){
 if(!credit||!credit.url.startsWith("https://"))return null;
 return <><Meta>{credit.what} comes from {credit.name} ({credit.license}).</Meta><LinkButton href={credit.url} target="_blank" rel="noopener noreferrer">Open {credit.name} on GitHub</LinkButton></>;
}
export function WorkflowInfoButton({title="Workspace guide",children}:{title?:string;children?:ReactNode}){
 const {entry}=useContext(Context);return <InfoButton title={entry?.title??title}>{entry?.content??children??<Meta>Choose inputs, review settings and start the workflow explicitly.</Meta>}</InfoButton>;
}
