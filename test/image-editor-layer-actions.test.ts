import {describe,it,expect} from "vitest";
import {docFromImage,addImageLayer,updateLayer,commit,startHistory,undo,GROUP_DEPTH_LIMIT,groupLayers,groupSelectionState,isVisible,toggleGroup,ungroupGroup,mergeInto} from "../src/image/editor/doc";
import {groupMergeSource,mergeLayerIds,smartObjectIds,createSmartObject,applySmartContents} from "../src/image/editor/layer-actions";

function fixture(){let doc=docFromImage("Base","a",64,48);doc=addImageLayer(doc,"Middle","b",32,24);return addImageLayer(doc,"Top","c",16,12);}
describe("layer operations",()=>{
  it("distinguishes all, visible, selected, down and group without reversing stack order",()=>{
    let doc=fixture();const [a,b,c]=doc.layers.map(l=>l.id);doc={...doc,groups:{g:{name:"Hidden group",visible:false}},layers:doc.layers.map(l=>l.id===b?{...l,group:"g"}:l.id===c?{...l,visible:false}:l)};
    expect(mergeLayerIds(doc,[],"visible")).toEqual([a]);expect(mergeLayerIds(doc,[],"all")).toEqual([a,b,c]);
    expect(mergeLayerIds(doc,[c,a],"selected")).toEqual([a,c]);expect(mergeLayerIds(doc,[],"down")).toEqual([b,c]);
    expect(mergeLayerIds({...doc,selectedId:b},[],"group")).toEqual([b]);expect(mergeLayerIds({...doc,selectedId:a},[],"down")).toEqual([]);
  });
  it("keeps grouping within the save format depth budget and leaves the document unchanged at its limit",()=>{
    const doc=fixture(),[base,middle,top]=doc.layers.map(layer=>layer.id);
    doc.groups=Object.fromEntries(Array.from({length:GROUP_DEPTH_LIMIT},(_,index)=>[`g${index}`,{name:`Folder ${index}`,visible:true,...(index?{parent:`g${index-1}`}:{})}]));
    doc.layers[0].group=`g${GROUP_DEPTH_LIMIT-1}`;
    expect(groupSelectionState(doc,[base,middle])).toBe("depth-limit");
    expect(groupLayers(doc,[base,middle])).toBe(doc);
    expect(groupLayers(doc,[base])).toBe(doc);
    expect(groupSelectionState(doc,[middle,top])).toBe("available");
    const shallow={...doc,groups:{...doc.groups}};delete shallow.groups[`g${GROUP_DEPTH_LIMIT-1}`];
    shallow.layers=doc.layers.map(layer=>layer.id===base?{...layer,group:`g${GROUP_DEPTH_LIMIT-2}`}:layer);
    expect(groupSelectionState(shallow,[base,middle])).toBe("available");
    const deepest=groupLayers(shallow,[base,middle]);
    expect(groupSelectionState(deepest,[base,top])).toBe("depth-limit");
  });
  it("keeps the base layer when flattening a selected clipped layer",()=>{
    const doc=fixture(),[base,clipped,top]=doc.layers.map(l=>l.id),withClip=updateLayer(doc,clipped,{clip:true});
    expect(mergeLayerIds(withClip,[clipped],"selected")).toEqual([base,clipped]);
    expect(mergeLayerIds(withClip,[clipped,top],"selected")).toEqual([base,clipped,top]);
  });
  it("nests existing groups when grouping mixed selections and retains hierarchy",()=>{
    const doc=fixture(),[base,middle,top]=doc.layers.map(l=>l.id),grouped=groupLayers(doc,[middle,top]);
    expect(groupSelectionState(grouped,[middle,top])).toBe("already-grouped");
    expect(groupSelectionState(grouped,[base,middle])).toBe("available");
    const nested=groupLayers(grouped,[base,middle]),parent=nested.layers.find(l=>l.id===base)!.group!,child=grouped.layers.find(l=>l.id===middle)!.group!;
    expect(nested.groups?.[child].parent).toBe(parent);
    expect(nested.layers.find(l=>l.id===top)?.group).toBe(child);
    expect(nested.layers.find(l=>l.id===base)?.group).toBe(parent);
    expect(groupSelectionState(nested,[base,middle])).toBe("already-grouped");
  });
  it("inherits visibility from every parent group",()=>{
    const doc=fixture(),[base,middle,top]=doc.layers.map(l=>l.id),child=groupLayers(doc,[middle,top]),childId=child.layers[1].group!,nested=groupLayers(child,[base,middle]),parentId=nested.layers[0].group!;
    expect(isVisible(nested,nested.layers[2])).toBe(true);
    expect(isVisible(toggleGroup(nested,parentId),nested.layers[2])).toBe(false);
    expect(isVisible(toggleGroup(nested,childId),nested.layers[2])).toBe(false);
  });
  it("dissolves a parent group without flattening its child groups",()=>{
    const doc=fixture(),[base,middle,top]=doc.layers.map(l=>l.id),child=groupLayers(doc,[middle,top]),childId=child.layers[1].group!,nested=groupLayers(child,[base,middle]),parentId=nested.layers[0].group!;
    const flat=ungroupGroup(nested,parentId);
    expect(flat.groups?.[parentId]).toBeUndefined();
    expect(flat.groups?.[childId].parent).toBeUndefined();
    expect(flat.layers.find(l=>l.id===base)?.group).toBeUndefined();
    expect(flat.layers.find(l=>l.id===top)?.group).toBe(childId);
  });
  it("merges a whole nested group and prunes folders with no remaining layers",()=>{
    const doc=fixture(),[base,middle,top]=doc.layers.map(l=>l.id),child=groupLayers(doc,[middle,top]),parent=groupLayers(child,[base,middle]),parentId=parent.layers[0].group!,childId=parent.layers[1].group!;
    const ids=mergeLayerIds(parent,[middle],"group");
    expect(ids).toEqual([middle,top]);
    expect(groupMergeSource(parent,ids,childId).groups?.[parentId]).toMatchObject({opacity:1,blend:"pass-through"});
    const merged=mergeInto(parent,ids,"merged","Merged",parent.groups?.[childId]?.parent??null);
    expect(merged.groups?.[childId]).toBeUndefined();
    expect(merged.groups?.[parentId]).toBeDefined();
    expect(merged.layers.find(l=>l.name==="Merged")?.group).toBe(parentId);
  });
  it("retains editable originals inside a smart object and supports atomic Undo",()=>{
    const doc=fixture(),before=structuredClone(doc),ids=doc.layers.slice(1).map(l=>l.id),next=createSmartObject(doc,ids,"cache");
    expect(next.layers).toHaveLength(2);expect(next.layers[1].smartObject?.layers).toEqual(before.layers.slice(1));expect(doc).toEqual(before);
    expect(undo(commit(startHistory(doc),next)).present).toEqual(doc);
  });
  it("keeps object transforms when contents change and rejects incompatible canvas size",()=>{
    const doc=fixture();let parent=createSmartObject(doc,doc.layers.map(l=>l.id),"cache");
    const id=parent.selectedId!;parent=updateLayer(parent,id,{x:10,y:20,scale:.7,rotation:35,flipX:true});
    const inner=parent.layers[0].smartObject!,edited=updateLayer(inner,inner.layers[0].id,{name:"Edited"});
    const next=applySmartContents(parent,id,edited,"new-cache");expect(next.layers[0]).toMatchObject({src:"new-cache",x:10,y:20,scale:.7,rotation:35,flipX:true});expect(next.layers[0].smartObject?.layers[0].name).toBe("Edited");
    expect(()=>applySmartContents(parent,id,{...inner,width:128},"bad")).toThrow(/dimensions/);
  });
  it("wraps clipping dependencies together",()=>{
    let doc=fixture();const [a,b,c]=doc.layers.map(l=>l.id);doc=updateLayer(doc,b,{clip:true});expect(smartObjectIds(doc,[b])).toEqual([a,b]);expect(smartObjectIds(doc,[a])).toEqual([a,b]);expect(smartObjectIds(doc,[c])).toEqual([c]);
  });
});
