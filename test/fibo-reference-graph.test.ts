import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {compileLocal} from "../src/capabilities/compile";
import type {CapabilityBundle} from "../src/capabilities/types";
import {imageRunBody} from "../src/image/image-state";
import {mapAnnotationReferenceMentions,modifyReferenceBindings} from "../src/image/editor/modify-references";
import {annotationInstruction} from "../src/image/annotations";
const root="native-workflows/fibo2-edit";
const bundle={manifest:JSON.parse(readFileSync(`${root}/manifest.json`,"utf8")),template:JSON.parse(readFileSync(`${root}/template.api.json`,"utf8"))} as CapabilityBundle;
const target={projectId:"p",workerId:"w",idempotencyKey:"test-12345678",routeId:"local"};
function compile(inputs:Record<string,string>,prompt:string,improve_prompt=false){return compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs,controls:{prompt,improve_prompt},audioPolicy:"mute"});}
describe("Fibo image reference graph",()=>{
 it("connects the chosen scene and reference and preserves the resolved user instruction",()=>{
  const body=imageRunBody(target,bundle.manifest,{inputs:{source_image:"comfyfield-scene.png",reference_image:"comfyfield-reference.png"},controls:{prompt:"Use @Image 2 for @Image 1"}});
  const graph=compile(body.inputs,body.controls.prompt as string,body.controls.improve_prompt as boolean);
  expect(graph["10"].inputs.image).toBe("comfyfield-scene.png");expect(graph["30"].inputs.image).toBe("comfyfield-reference.png");
  expect(graph["4"].inputs["images.image_1"]).toEqual(["10",0]);expect(graph["4"].inputs["images.image_2"]).toEqual(["30",0]);
  expect(graph["4"].inputs).not.toHaveProperty("images.image_3");expect(graph["13"].inputs.value).toBe("Use image 2 for image 1");expect(graph["15"].inputs.switch).toBe(false);
 });
 it("retains numbered instructions and mapped references in the compiled annotation prompt",()=>{
  const refs=["comfyfield-a.png","comfyfield-b.png",null],ports=bundle.manifest.inputs.map(port=>port.id),source="comfyfield-scene.png",guide="comfyfield-guide.png";
  const mapped=modifyReferenceBindings(source,guide,refs,ports,"Use @Image 1"),annotations=mapAnnotationReferenceMentions([{x:.1,y:.1,w:.2,h:.2,instruction:"Add @Image 2"}],source,guide,refs,ports);
  const graph=compile(mapped.inputs,annotationInstruction(annotations,mapped.prompt));const prompt=String(graph["13"].inputs.value);
  expect(prompt).toContain("Use image 3");expect(prompt).toContain("Region 1: Add image 4");expect(prompt).toContain("Image 2 is a guide");expect(prompt).not.toContain("@Image");
 });
 it("keeps an annotation guide and two explicit references on distinct inputs",()=>{
  const mapped=modifyReferenceBindings("comfyfield-scene.png","comfyfield-guide.png",["comfyfield-a.png","comfyfield-b.png",null],bundle.manifest.inputs.map(port=>port.id),"Use @Image 2");
  const graph=compile(mapped.inputs,mapped.prompt);
  expect([graph["10"].inputs.image,graph["30"].inputs.image,graph["31"].inputs.image,graph["32"].inputs.image]).toEqual(["comfyfield-scene.png","comfyfield-guide.png","comfyfield-a.png","comfyfield-b.png"]);
  expect(graph["13"].inputs.value).toBe("Use image 4");
 });
});
