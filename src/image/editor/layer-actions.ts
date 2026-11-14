import {addPaintLayer,emptyDoc,isVisible,groupAncestors,isGroupDescendant,newId,type Doc,type Layer} from "./doc";

export type MergeMode="down"|"selected"|"visible"|"all"|"group";
/** Render a folder's contents without baking any enclosing folder effects twice. */
export function groupMergeSource(doc:Doc,ids:string[],gid:string):Doc{
  const groups={...doc.groups};
  for(let parent=doc.groups?.[gid]?.parent;parent&&groups[parent];parent=groups[parent].parent)groups[parent]={...groups[parent],opacity:1,blend:"pass-through"};
  return {...doc,groups,layers:doc.layers.filter(layer=>ids.includes(layer.id))};
}
export function mergeLayerIds(doc:Doc,selected:string[],mode:MergeMode):string[]{
  const active=doc.layers.find(l=>l.id===doc.selectedId),index=doc.layers.findIndex(l=>l.id===doc.selectedId);
  if(mode==="all")return doc.layers.map(l=>l.id);
  if(mode==="visible")return doc.layers.filter(l=>isVisible(doc,l)).map(l=>l.id);
  if(mode==="group")return active?.group?doc.layers.filter(l=>isGroupDescendant(doc,active.group!,l.group)).map(l=>l.id):[];
  if(mode==="selected")return smartObjectIds(doc,selected);
  return active&&index>0?[doc.layers[index-1].id,active.id]:[];
}

/** Include clipping dependencies so wrapping a stack does not orphan a clipped sibling. */
export function smartObjectIds(doc:Doc,selected:string[]):string[]{
  const ids=new Set(selected);
  let base:Layer|undefined;let stack:Layer[]=[];
  const flush=()=>{if(stack.some(l=>ids.has(l.id)))stack.forEach(l=>ids.add(l.id));};
  for(const layer of doc.layers){
    if(!layer.clip){flush();base=layer;stack=[layer];}
    else if(base)stack.push(layer);
    else if(ids.has(layer.id))throw new Error("Include a base layer before creating this smart object.");
  }
  flush();return doc.layers.filter(l=>ids.has(l.id)).map(l=>l.id);
}

/** Wrap immutable member snapshots; the caller supplies their transparent render cache. */
export function createSmartObject(doc:Doc,selected:string[],src:string):Doc{
  const ids=smartObjectIds(doc,selected),members=doc.layers.filter(l=>ids.includes(l.id));
  if(!members.length)return doc;
  const groupIds=new Set(members.flatMap(l=>groupAncestors(doc,l.group)));
  const inner:Doc={width:doc.width,height:doc.height,layers:members,selectedId:members.at(-1)!.id,selection:null,
    groups:Object.fromEntries(Object.entries(doc.groups??{}).filter(([id])=>groupIds.has(id)))};
  const cached=addPaintLayer(emptyDoc(doc.width,doc.height),src).layers[0];
  const object:Layer={...cached,id:newId(),name:members.length===1?members[0].name+" · Smart":"Smart object",smartObject:inner};
  const index=doc.layers.findIndex(l=>ids.includes(l.id)),layers=doc.layers.filter(l=>!ids.includes(l.id));layers.splice(index,0,object);
  return {...doc,layers,selectedId:object.id};
}

export function applySmartContents(parent:Doc,layerId:string,contents:Doc,src:string):Doc{
  const object=parent.layers.find(l=>l.id===layerId);
  if(!object?.smartObject)throw new Error("The parent smart object is unavailable.");
  if(contents.width!==object.w||contents.height!==object.h)throw new Error("Keep the smart object canvas dimensions unchanged before applying its contents.");
  return {...parent,layers:parent.layers.map(l=>l.id===layerId?{...l,src,smartObject:{...contents,selection:null}}:l),selectedId:layerId};
}
