import {describe,expect,it} from "vitest";
import {checkFeatureEdit,featureFileName} from "../server/feature-edit";
import {loadWorkspaceCatalogue} from "../server/workflow-imports";
import {loadServerCatalogue} from "../server/catalogue";
import {loadFeatureGraph,loadedFeatureMatches,parseFeature,showFeatureError,workspaceFromPath} from "../server/comfy-feature.mjs";

describe("editing a feature in the node editor",()=>{
  it("accepts an edited graph that keeps every bound node and field",async()=>{
    const bundle=(await loadServerCatalogue()).find(b=>b.manifest.id==="flux2-klein-relight")!;
    const edited=structuredClone(bundle.template!);
    const anyControl=bundle.manifest.controls.find(c=>c.binding)!;
    (edited[anyControl.binding!.node].inputs as Record<string,unknown>).extra_tweak=1;
    edited["999"]={class_type:"ImageScaleBy",inputs:{image:["1",0],upscale_method:"lanczos",scale_by:1}};
    const result=checkFeatureEdit(bundle.manifest,bundle.template!,edited);
    expect(result.errors).toEqual([]);
    expect(result.changes.added).toEqual(["999 ImageScaleBy"]);
    expect(result.changes.changed.length).toBeGreaterThan(0);
  });
  it("refuses an edit that removes a node or field the screen needs, or the result node",async()=>{
    const bundle=(await loadServerCatalogue()).find(b=>b.manifest.id==="flux2-klein-relight")!;
    const control=bundle.manifest.controls.find(c=>c.binding)!;
    const noNode=structuredClone(bundle.template!);delete noNode[control.binding!.node];
    expect(checkFeatureEdit(bundle.manifest,bundle.template!,noNode).errors.join(" ")).toContain("missing");
    const noField=structuredClone(bundle.template!);delete (noField[control.binding!.node].inputs as Record<string,unknown>)[control.binding!.field];
    expect(checkFeatureEdit(bundle.manifest,bundle.template!,noField).errors.join(" ")).toContain(control.binding!.field);
    const noOutput=Object.fromEntries(Object.entries(bundle.template!).filter(([,n])=>!/^Save|^Preview/.test(n.class_type)));
    expect(checkFeatureEdit(bundle.manifest,bundle.template!,noOutput).errors.join(" ")).toContain("result node");
  });
  it("opens only well-formed feature ids inside a workspace editor path",()=>{
    expect(parseFeature("?v=1&comfyfield_feature=flux2-klein-relight")).toBe("flux2-klein-relight");
    expect(parseFeature("?comfyfield_feature=../x")).toBeNull();
    expect(workspaceFromPath("/comfy/51cdde46-e5f3-467d-a6fc-2e468846d39f/")).toBe("51cdde46-e5f3-467d-a6fc-2e468846d39f");
    expect(workspaceFromPath("/other/")).toBeNull();
    expect(featureFileName("flux2-klein-relight")).toBe("ComfyField - flux2-klein-relight");
  });
  it("does not mistake a previous link-rich tab for the selected starter",async()=>{
    const workflow={nodes:[{id:1,type:"LoadImage",inputs:[]},{id:2,type:"SaveImage",inputs:[{name:"images"}]}],links:[[1,1,0,2,0,"IMAGE"]],extra:{comfyfield:{ids:{"1":"source","2":"save"}}}};
    let current: {nodes:Array<{id:number;type:string;inputs?:Array<{name:string}>}>;links:Array<Array<string|number>>;extra:{comfyfield:{ids:Record<string,string>}}}={nodes:[{id:1,type:"Other"},{id:2,type:"SaveImage"},{id:3,type:"Extra"}],links:[[1,1,0,2,0,"IMAGE"],[2,3,0,2,0,"IMAGE"]],extra:{comfyfield:{ids:{"1":"other"}}}},loads=0;
    const app={graph:{serialize:()=>current},loadGraphData:async(graph:typeof workflow,_clean:boolean,_restore:boolean,name:string)=>{
      loads++;
      expect(name).toBe("CreativeField - starter");
      if(loads===2)current=structuredClone(graph);
    }};
    await expect(loadFeatureGraph(app,workflow,"CreativeField - starter",async()=>{})).resolves.toBeUndefined();
    expect(loads).toBe(2);
    expect(loadedFeatureMatches(current,workflow)).toBe(true);
    const normalized=structuredClone(workflow);
    normalized.nodes[1].inputs=[{name:"filename_prefix"},{name:"images"}];
    normalized.links=[[9,1,0,2,1,"IMAGE"]];
    expect(loadedFeatureMatches(normalized,workflow)).toBe(true);

    current={nodes:[{id:1,type:"Other"},{id:2,type:"SaveImage"}],links:[[1,1,0,2,0,"IMAGE"]],extra:{comfyfield:{ids:{"1":"source","2":"save"}}}};
    loads=0;
    const stuck={graph:app.graph,loadGraphData:async()=>{loads++;}};
    await expect(loadFeatureGraph(stuck,workflow,"CreativeField - starter",async()=>{})).rejects.toThrow("did not keep");
    expect(loads).toBe(2);
  });
  it("shows a visible error after the bounded load attempts fail",()=>{
    const appended:Array<{textContent?:string;attributes:Record<string,string>}>=[];
    const doc={createElement:()=>({style:{},attributes:{} as Record<string,string>,setAttribute(name:string,value:string){this.attributes[name]=value;}}),body:{append:(node:typeof appended[number])=>appended.push(node)}};
    showFeatureError(doc,"Try again.");
    expect(appended).toHaveLength(1);
    expect(appended[0].attributes.role).toBe("alert");
    expect(appended[0].textContent).toContain("Try again");
  });
  it("lets a published feature edit replace that feature's graph and keeps ordinary imports additive",async()=>{
    const base=await loadServerCatalogue(),relight=base.find(b=>b.manifest.id==="flux2-klein-relight")!;
    const edited={...structuredClone(relight.template!),"999":{class_type:"ImageScaleBy",inputs:{image:["1",0],upscale_method:"lanczos",scale_by:1}}};
    const rows=[{manifest:relight.manifest,template:edited,mapping:{featureEdit:true}}];
    const pool={query:async()=>({rows})} as never;
    const catalogue=await loadWorkspaceCatalogue(pool,base,"w");
    expect(catalogue.length).toBe(base.length);
    expect(catalogue.find(b=>b.manifest.id==="flux2-klein-relight")!.template).toEqual(edited);
  });
});

describe("finding the saved feature workflow",()=>{
  it("takes the newest file of the feature, also a renamed second copy",async()=>{
    const {newestFeatureFile}=await import("../server/feature-edit");
    const files=[{path:"ComfyField - flux2-klein-relight.json",modified:10},{path:"ComfyField - flux2-klein-relight (2).json",modified:20},{path:"ComfyField - flux2-klein-relight-x.json",modified:99},{path:"Other.json",modified:50}];
    expect(newestFeatureFile("flux2-klein-relight",files)).toBe("ComfyField - flux2-klein-relight (2).json");
    expect(newestFeatureFile("flux2-klein-relight",[files[0]])).toBe("ComfyField - flux2-klein-relight.json");
    expect(newestFeatureFile("missing",files)).toBeNull();
  });
});

describe("ids survive the editor",()=>{
  it("maps editor ids back to the feature's own ids and folds added primitives into their field",async()=>{
    const {restoreFeatureIds}=await import("../server/feature-edit");
    const edited={"1":{class_type:"SaveImage",inputs:{images:["2",0],filename_prefix:"x"}},"2":{class_type:"VAEDecode",inputs:{samples:["3",0]}},"3":{class_type:"KSampler",inputs:{seed:1,note:["4",0]}},"4":{class_type:"PrimitiveStringMultiline",inputs:{value:"[]"}},"5":{class_type:"ImageScaleBy",inputs:{image:["2",0],scale_by:1}}} as never;
    const ids={"1":"9","2":"75:65","3":"75:63","4":"~inline:75:63:note"};
    const restored=restoreFeatureIds(edited,ids);
    expect(restored["9"].inputs.images).toEqual(["75:65",0]);
    expect(restored["75:63"].inputs.note).toBe("[]");
    expect(Object.keys(restored).some(id=>id.startsWith("~inline"))).toBe(false);
    expect(restored["5"].inputs.image).toEqual(["75:65",0]);
  });
});
