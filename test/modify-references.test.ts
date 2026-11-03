import {describe,expect,it} from "vitest";
import {canAttachSelectionGuide,mapAnnotationReferenceMentions,modifyReferenceBindings} from "../src/image/editor/modify-references";
describe("Modify reference inputs",()=>{
 const ports=["reference_image","reference_image_2","reference_image_3"];
 it("adds a selection guide only when a model has a free reference slot",()=>{
  expect(canAttachSelectionGuide(ports,["a","b",null])).toBe(true);
  expect(canAttachSelectionGuide(ports,["a","b","c"])).toBe(false);
  expect(canAttachSelectionGuide([],[])).toBe(false);
 });
 it("binds two references and resolves mentions without forcing a character identity",()=>{
  expect(modifyReferenceBindings("canvas",undefined,["a","b",null],ports,"Replace @Image 1 with @Image 2")).toEqual({inputs:{source_image:"canvas",reference_image:"a",reference_image_2:"b"},prompt:"Replace image 2 with image 3"});
 });
 it("reserves the first reference for the annotation guide",()=>{
  expect(modifyReferenceBindings("canvas","guide",["a","b",null],ports,"Use @Image 1 and @Image 2")).toEqual({inputs:{source_image:"canvas",reference_image:"guide",reference_image_2:"a",reference_image_3:"b"},prompt:"Use image 3 and image 4"});
 });
 it("maps references inside each annotation while keeping its geometry",()=>{
  const boxes=[{x:.1,y:.2,w:.3,h:.4,instruction:"Place @Image 2 beside @Image 1"}];
  expect(mapAnnotationReferenceMentions(boxes,"canvas","guide",["a","b",null],ports)).toEqual([{...boxes[0],instruction:"Place image 4 beside image 3"}]);
  expect(boxes[0].instruction).toBe("Place @Image 2 beside @Image 1");
 });
 it("refuses to silently drop references when the model has too few ports",()=>{
  expect(()=>modifyReferenceBindings("canvas","guide",["a","b","c"],ports,"")).toThrow("cannot use all references");
 });
});
