import type {Doc} from "./doc";
export const DOCUMENT_FORMAT="comfyfield/layered-document-v1";
export function documentKeys(doc:Doc):string[]{
  const keys=new Set<string>();
  const visit=(d:Doc)=>{if(d.selection)keys.add(d.selection);for(const s of d.saved??[])keys.add(s.key);for(const l of d.layers){if(l.src)keys.add(l.src);if(l.mask)keys.add(l.mask);if(l.smartObject)visit(l.smartObject);}};visit(doc);return [...keys];
}
export function mapDocumentKeys(doc:Doc,map:(key:string)=>string):Doc{
  return {...doc,selection:doc.selection?map(doc.selection):null,saved:doc.saved?.map(s=>({...s,key:map(s.key)})),layers:doc.layers.map(l=>({...l,src:l.src?map(l.src):"",mask:l.mask?map(l.mask):undefined,smartObject:l.smartObject?mapDocumentKeys(l.smartObject,map):undefined}))};
}
