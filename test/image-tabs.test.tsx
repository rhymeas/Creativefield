import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import type {CapabilityManifestV2} from "../src/capabilities/types";
import {WorkspaceBar} from "../src/ds";
import {defaultImageDraft,type ImageDraft} from "../src/image/image-state";
import {ImageStudio} from "../src/image/ImageStudio";
import {angleWorkflow,imageDraftForTab,imageTabFor,imageTabTarget,imageTabs,selectAdModel,videoWorkflowMode} from "../src/team/TeamApp";

function manifest(id:string,presets:string[]=[]):CapabilityManifestV2{
  return {
    schemaVersion:2,id,version:"1.0.0",title:id,category:"image",description:"",
    inputs:[{id:"source_image",label:"Source image",type:"image",required:true}],
    outputs:[{id:"image",label:"Image",type:"image",required:true}],
    controls:[{id:"prompt",label:"Edit prompt",type:"string",default:"Keep the subject.",binding:{node:"1",field:"text"}}],
    presets:presets.map(preset=>({id:preset,title:preset,values:{prompt:`${preset} view`}})),
    routes:[{id:"local",execution:"local_comfy",provider:"ComfyUI",upstreamProviders:[],implementation:"implemented",workflowId:"flux2-klein-edit",requirements:[],evidence:[]}],
    coverage:{local:"implemented",hosted:"planned"},
    licenses:{software:"MIT",weights:[]},
    sources:[],tickets:[],audioPolicies:["mute"],
  };
}

const angles=manifest("flux2-klein-angles",["high-left","low"]),qwen=manifest("qwen-image-21-angles"),relight=manifest("flux2-klein-relight",["golden-hour"]),create=manifest("qwen-image-21-t2i"),moss=manifest("moss-image-t2i");
create.inputs=[]; // A real text-to-image pack has no required source image.
moss.inputs=[];
const picture="asset-roof";

describe("Image workspace tabs",()=>{
  it("puts Angles and Relight in the one row beside Create; editing has its own top entry, FotoField",()=>{
    expect(imageTabs([create,angles,relight])).toEqual([
      {id:"create",label:"Create"},
      {id:"angles",label:"Angles"},
      {id:"relight",label:"Relight"},
    ]);
  });

  it("leaves out a tool whose workflow is not ready here (rule 26)",()=>{
    expect(imageTabs([create]).map(tab=>tab.id)).toEqual(["create"]);
    expect(imageTabs([create,qwen]).map(tab=>tab.id)).toEqual(["create","angles"]);
    expect(imageTabs([]).map(tab=>tab.id)).toEqual([]);
  });

  it("opens whichever angle workflow is really ready",()=>{
    expect(angleWorkflow([create,angles,qwen])?.id).toBe("flux2-klein-angles");
    expect(angleWorkflow([create,qwen])?.id).toBe("qwen-image-21-angles");
    expect(angleWorkflow([create])).toBeUndefined();
    expect(imageTabTarget("angles",[create,qwen])?.id).toBe("qwen-image-21-angles");
    expect(imageTabTarget("relight",[create,relight])?.id).toBe("flux2-klein-relight");
    expect(imageTabTarget("relight",[create])).toBeUndefined();
    expect(imageTabTarget("create",[angles,create,relight])?.id).toBe("qwen-image-21-t2i");
    expect(imageTabTarget("create",[angles,moss,relight])).toBeUndefined();
  });

  it("keeps editing and angle tools out of the Create target, including when they sort first",()=>{
    const edit=manifest("flux2-klein-edit"),turbo={...manifest("z-image-turbo-t2i"),inputs:[]};
    expect(imageTabTarget("create",[angles,edit,turbo])).toBeUndefined();
    expect(imageTabTarget("create",[angles,relight,edit])).toBeUndefined();
    expect(imageTabs([angles,edit]).some(tab=>tab.id==="create")).toBe(false);
  });
  it("keeps explicit video edits accessible outside the Create picker",()=>{
    const source={...create,category:"video" as const,outputs:[{id:"video",label:"Video",type:"video" as const,required:true}],inputs:[{id:"source_video",label:"Source",type:"video" as const,required:true}]};
    expect(videoWorkflowMode({...source,id:"h3-effects"})).toBe("effects");
    expect(videoWorkflowMode({...source,id:"video-edit"})).toBe("trim");
    expect(videoWorkflowMode({...source,id:"reference-restyle"})).toBe("workflow");
    expect(videoWorkflowMode({...source,id:"text-video",inputs:[]})).toBe("create");
  });
  it("marks the tab the open workflow belongs to",()=>{
    expect(imageTabFor("flux2-klein-angles","image")).toBe("angles");
    expect(imageTabFor("qwen-image-21-angles","image")).toBe("angles");
    expect(imageTabFor("flux2-klein-relight","image")).toBe("relight");
    expect(imageTabFor("qwen-image-21-t2i","image")).toBe("create");
    expect(imageTabFor("flux2-klein-relight","imageedit")).toBe("edit");
  });

  it("keeps the picture you chose when you switch to another tab",()=>{
    const showing:ImageDraft={...defaultImageDraft(angles),inputs:{source_image:picture},presetId:"high-left"};
    const landed=imageDraftForTab(relight,{},showing);
    expect(landed.inputs).toEqual({source_image:picture});
    // The other tab's angle is not an angle of this tool, so it is not carried over.
    expect(landed.presetId).toBeUndefined();
  });

  it("comes back to the tab you left with its own picture and preset",()=>{
    const angleDraft:ImageDraft={...defaultImageDraft(angles),inputs:{source_image:picture},presetId:"high-left"};
    const relightDraft:ImageDraft={...defaultImageDraft(relight),inputs:{source_image:"asset-street"}};
    expect(imageDraftForTab(angles,{"flux2-klein-angles":angleDraft},relightDraft)).toBe(angleDraft);
    expect(imageDraftForTab(angles,{},relightDraft).inputs).toEqual({source_image:"asset-street"});
  });

  it("never hands a picture to a workflow that has no port for it",()=>{
    const textOnly={...create,inputs:[]} as CapabilityManifestV2;
    expect(imageDraftForTab(textOnly,{},{controls:{},inputs:{source_image:picture}}).inputs).toBeUndefined();
  });

  it("draws the row with one selected tab in the shared workspace bar",()=>{
    const items=imageTabs([create,angles,relight]);
    const html=renderToStaticMarkup(<WorkspaceBar tabs={{label:"Image workspace",value:imageTabFor("flux2-klein-relight","image"),items,onChange:()=>{}}} />);
    expect(html).toContain('aria-label="Image workspace"');
    expect([...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]+)<\/button>/g)].map(match=>match[1])).toEqual(["Create","Angles","Relight"]);
    expect([...html.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
    expect(html).toMatch(/aria-selected="true"[^>]*>Relight</);
  });

  it("shows the carried picture on the tab it lands on",()=>{
    const draft=imageDraftForTab(relight,{},{controls:{},inputs:{source_image:picture}});
    const html=renderToStaticMarkup(<ImageStudio
      workspace={{id:"w",name:"Studio",role:"creator" as const}}
      project={{id:"p",name:"Roof"}}
      manifest={relight}
      readiness={{state:"ready",reasons:[],missing:[]}}
      assets={[{id:picture,project_id:"p",name:"roof.png",media_type:"image",content_type:"image/png",sha256:"abc",bytes:"12",created_at:"2026-10-21T00:00:00Z",parent_id:null}]}
      runs={[]}
      draft={draft}
      onDraftChange={()=>{}}
      onGenerate={()=>{}}
    />);
    expect(html).toContain("roof.png");
    expect(html).toContain("Choose from library");
    expect(html).toContain("Remove source image");
  });

  it("uses the image box instead of a filename row for an empty source",()=>{
    const html=renderToStaticMarkup(<ImageStudio
      workspace={{id:"w",name:"Studio",role:"creator" as const}}
      project={{id:"p",name:"Roof"}}
      manifest={relight}
      readiness={{state:"ready",reasons:[],missing:[]}}
      assets={[]}
      runs={[]}
      draft={defaultImageDraft(relight)}
      onDraftChange={()=>{}}
      onGenerate={()=>{}}
    />);
    expect(html).toContain("Add source image");
    expect(html).toContain("Drop a picture or choose from project");
    expect(html).toContain('type="file"');
    expect(html).not.toContain("Choose from project</span>");
  });

  it("uses the shared model card and exposes the angle prompt",()=>{
    const html=renderToStaticMarkup(<ImageStudio
      workspace={{id:"w",name:"Studio",role:"creator" as const}}
      project={{id:"p",name:"Roof"}}
      manifest={angles}
      readiness={{state:"ready",reasons:[],missing:[]}}
      assets={[]}
      runs={[]}
      draft={defaultImageDraft(angles)}
      modelOptions={[{value:angles.id,label:angles.title},{value:qwen.id,label:qwen.title}]}
      onModel={()=>{}}
      onDraftChange={()=>{}}
      onGenerate={()=>{}}
    />);
    expect(html).toContain('class="ds-modelcard"');
    expect(html).toContain("Edit prompt");
    expect(html).not.toContain('class="ds-row"');
  });

  it("does not expose or send style presets in the Create panel",()=>{
    const styled={...create,presets:[{id:"cinematic",title:"Cinematic still",values:{prompt:"Preset text"}}]};
    const html=renderToStaticMarkup(<ImageStudio
      workspace={{id:"w",name:"Studio",role:"creator" as const}}
      project={{id:"p",name:"Roof"}}
      manifest={styled}
      readiness={{state:"ready",reasons:[],missing:[]}}
      assets={[]}
      runs={[]}
      draft={{...defaultImageDraft(styled),presetId:"cinematic"}}
      onDraftChange={()=>{}}
      onGenerate={()=>{}}
    />);
    expect(html).not.toContain("Cinematic still");
    expect(html).not.toContain(">Preset<");
  });
});


it("prefers a ready product editor while respecting an explicitly selected model",()=>{
  const fibo=manifest("fibo2-edit");
  const flux=manifest("flux2-klein-edit");
  const status={"fibo2-edit":{state:"download_required" as const,reasons:[],missing:[]},"flux2-klein-edit":{state:"ready" as const,reasons:[],missing:[]}};
  expect(selectAdModel([fibo,flux],status,"","")).toBe("flux2-klein-edit");
  expect(selectAdModel([fibo,flux],status,"flux2-klein-edit","fibo2-edit")).toBe("fibo2-edit");
});
