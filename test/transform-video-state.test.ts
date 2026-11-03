import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {createElement,type ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {Call,Catalogue,Project,User,Worker,Workspace} from "../src/team/api";
import type {Readiness} from "../src/capabilities/types";
import {BACKGROUND_PROMPT,backgroundManifest,seedBackgroundDraft,selectTransformManifest,transformCandidates} from "../src/team/transform-video-state";
import {TransformVideo} from "../src/team/TransformVideo";
import {TeamComposer} from "../src/team/TeamComposer";
import {draftKey} from "../src/team/state";

function manifest(id:string,overrides:Record<string,unknown>={}){
  return {id,title:id,category:"motion",coverage:{local:"implemented"},inputs:[{id:"motion_video",type:"video",required:true}],outputs:[{id:"video",type:"video"}],...overrides} as unknown as Catalogue[number];
}

function ready(...ids:string[]){
  return Object.fromEntries(ids.map(id=>[id,{state:"ready",reasons:[],missing:[]}])) as Record<string,Readiness>;
}

/** The masked edit a new background runs on: the clip plus the area to change. */
function maskedEdit(overrides:Record<string,unknown>={}){
  return manifest("wan21-vace-masked-edit",{title:"Masked edit",category:"replacement",description:"",presets:[],audioPolicies:["mute"],controls:[{id:"prompt",label:"Replacement prompt",type:"string",default:""}],inputs:[{id:"source_video",label:"Source video",type:"video",required:true},{id:"edit_mask",label:"Edit mask",type:"mask",representation:"video",required:true}],routes:[{id:"local",execution:"local_comfy",implementation:"implemented"}],mediaContract:{kind:"aligned_video_mask_v1",sourceInput:"source_video",maskInput:"edit_mask"},...overrides});
}
/** A browser store the seeding step can write to. */
function store(){
  const saved=new Map<string,string>();
  return {getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);},read:(key:string)=>saved.get(key)};
}

describe("Transform Video mode selection",()=>{
  it("prefers a ready workflow over the first implemented workflow",()=>{
    const slow=manifest("motion-slow"),fast=manifest("motion-fast");
    expect(selectTransformManifest([slow,fast],ready("motion-fast"),"motion")?.id).toBe("motion-fast");
  });

  it("falls back to another implemented mode when the selected mode is empty",()=>{
    const restyle=manifest("restyle",{category:"finishing",inputs:[{id:"source_video",type:"video",required:true}],outputs:[{id:"video",type:"video"}]});
    expect(selectTransformManifest([restyle],{},"motion")?.id).toBe("restyle");
  });

  it("returns undefined when no implemented workflow exists",()=>{
    const remote=manifest("remote",{coverage:{local:"unavailable"}});
    expect(selectTransformManifest([remote],ready("remote"),"motion")).toBeUndefined();
  });

  it("classifies motion, masked-edit swap and video-effect restyle independently",()=>{
    const motion=manifest("motion");
    const swap=manifest("swap",{category:"replacement",inputs:[{id:"source_video",type:"video"}],mediaContract:{kind:"aligned_video_mask_v1"}});
    const restyle=manifest("restyle",{category:"finishing",inputs:[{id:"source_video",type:"video"}],outputs:[{id:"video",type:"video"}]});
    const candidates=transformCandidates([motion,swap,restyle]);
    expect(candidates.motion.map(item=>item.id)).toEqual(["motion"]);
    expect(candidates.swap.map(item=>item.id)).toEqual(["swap"]);
    expect(candidates.restyle.map(item=>item.id)).toEqual(["restyle"]);
  });

  it("keeps depth-guided and interpolation effects out of the restyle mode",()=>{
    const video={id:"video",type:"video"};
    const canny=manifest("vace-canny-restyle",{category:"finishing",inputs:[{id:"source_video",type:"video",required:true}],outputs:[video]});
    const reference=manifest("vace-reference-restyle",{category:"finishing",inputs:[{id:"source_video",type:"video",required:true},{id:"style_reference",type:"image",required:true}],outputs:[video]});
    const depth=manifest("vace-depth-restyle",{category:"finishing",inputs:[{id:"source_video",type:"video",required:true},{id:"depth_video",type:"video",required:true}],outputs:[video]});
    const interpolation=manifest("film-frame-interpolation",{category:"enhance",inputs:[{id:"source_video",type:"video",required:true}],outputs:[video]});
    expect(transformCandidates([canny,reference,depth,interpolation]).restyle.map(item=>item.id)).toEqual(["vace-canny-restyle","vace-reference-restyle"]);
  });

  it("opens the picked restyle workflow instead of the first ready one",()=>{
    const video={id:"video",type:"video"};
    const canny=manifest("vace-canny-restyle",{category:"finishing",inputs:[{id:"source_video",type:"video",required:true}],outputs:[video]});
    const reference=manifest("vace-reference-restyle",{category:"finishing",inputs:[{id:"source_video",type:"video",required:true},{id:"style_reference",type:"image",required:true}],outputs:[video]});
    expect(selectTransformManifest([canny,reference],ready("vace-canny-restyle"),"restyle")?.id).toBe("vace-canny-restyle");
    expect(selectTransformManifest([canny,reference],ready("vace-canny-restyle"),"restyle","vace-reference-restyle")?.id).toBe("vace-reference-restyle");
  });

  it("ignores a pick that belongs to another tool",()=>{
    const video={id:"video",type:"video"};
    const motion=manifest("motion");
    const canny=manifest("vace-canny-restyle",{category:"finishing",inputs:[{id:"source_video",type:"video",required:true}],outputs:[video]});
    const reference=manifest("vace-reference-restyle",{category:"finishing",inputs:[{id:"source_video",type:"video",required:true},{id:"style_reference",type:"image",required:true}],outputs:[video]});
    expect(selectTransformManifest([motion,canny,reference],ready("vace-canny-restyle"),"restyle","motion")?.id).toBe("vace-canny-restyle");
  });

  it("offers a new background only where its masked edit is ready here",()=>{
    expect(backgroundManifest([maskedEdit()],{})).toBeUndefined();
    expect(backgroundManifest([maskedEdit()],ready("wan21-vace-masked-edit"))?.id).toBe("wan21-vace-masked-edit");
  });

  it("starts the masked edit's saved draft with the background words, and keeps words already written",()=>{
    const draft=store();
    seedBackgroundDraft(draft,"work");
    const written=JSON.parse(draft.read("work")!).controls.prompt;
    expect(written).toBe(BACKGROUND_PROMPT);
    expect(BACKGROUND_PROMPT).toContain("background");
    const typed=JSON.stringify({controls:{prompt:"A red mug instead."},inputs:{}});
    draft.setItem("mine",typed);
    seedBackgroundDraft(draft,"mine");
    expect(draft.read("mine")).toBe(typed);
    seedBackgroundDraft(draft,"mine");
    expect(draft.read("mine")).toBe(typed);
  });
});

describe("Change a video switcher",()=>{
  const base={manifests:[] as Catalogue,statuses:{},user:{id:"u"} as User,workspace:{id:"w"} as Workspace,project:{id:"p"} as Project,workers:[] as Worker[],call:(()=>Promise.resolve(null)) as unknown as Call,canQueue:true,authorized:true,onCapability:()=>{},onQueued:()=>{}};
  const render=(extra:Record<string,unknown>)=>renderToStaticMarkup(createElement(TransformVideo,{...base,...extra} as unknown as Parameters<typeof TransformVideo>[0]));
  /** The four tool boxes, in the order the panel shows them. */
  const boxes=(html:string)=>[...html.matchAll(/<span class="ds-preset__label">([^<]+)<\/span>/g)].map(match=>match[1]);

  it("names the four tools in boxes at the top of the panel, not in a tab row",()=>{
    const html=render({replace:(top:ReactNode)=>top});
    expect(boxes(html)).toEqual(["Replace character","Motion transfer","Object swap","Restyle"]);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Change a video"');
    expect(html).not.toContain('role="tab"');
  });

  it("keeps the four boxes compact, two by two, above the tool",()=>{
    const css=readFileSync("src/team/pick.css","utf8");
    expect(css).toContain(".cf-change-cards .ds-preset__art { aspect-ratio: 5 / 2; }");
    expect(render({replace:(top:ReactNode)=>top})).toContain('class="cf-change-cards"');
  });

  it("leaves out a tool that cannot run here",()=>{
    expect(boxes(render({}))).toEqual(["Motion transfer","Object swap","Restyle"]);
  });

  it("hands the same boxes to whichever tool is open",()=>{
    const html=render({initial:"swap",swapThing:(top:ReactNode)=>createElement("div",{"data-swap":"1"},top)});
    expect(html).toContain('data-swap="1"');
    expect(boxes(html)).toEqual(["Motion transfer","Object swap","Restyle"]);
    expect([...html.matchAll(/aria-checked="true"/g)]).toHaveLength(1);
  });

  it("opens a restyle workflow's own inputs in New look",()=>{
    // The results panel reads the run link from the page hash; the render test has no browser.
    (globalThis as unknown as {location:{hash:string}}).location={hash:""};
    const video={id:"video",type:"video"};
    const reference=manifest("vace-reference-restyle",{title:"Reference restyle",category:"finishing",description:"Style from a picture.",presets:[],controls:[],audioPolicies:["mute"],inputs:[{id:"source_video",label:"Source clip",type:"video",required:true},{id:"style_reference",label:"Style reference",type:"image",required:true}],outputs:[video]});
    const html=render({manifests:[reference] as Catalogue,initial:"restyle"});
    expect(html).toContain("Style reference");
    expect(html).not.toContain("Look");
  });
});

describe("New background inside Restyle",()=>{
  const base={manifests:[] as Catalogue,statuses:{},user:{id:"u"} as User,workspace:{id:"w"} as Workspace,project:{id:"p"} as Project,workers:[] as Worker[],call:(()=>Promise.resolve(null)) as unknown as Call,canQueue:true,authorized:true,onCapability:()=>{},onQueued:()=>{}};
  const render=(extra:Record<string,unknown>)=>renderToStaticMarkup(createElement(TransformVideo,{...base,...extra} as unknown as Parameters<typeof TransformVideo>[0]));
  const video={id:"video",type:"video"};
  const restyle=manifest("vace-canny-restyle",{title:"Canny restyle",category:"finishing",description:"",presets:[],controls:[],audioPolicies:["mute"],inputs:[{id:"source_video",label:"Source clip",type:"video",required:true}],outputs:[video]});
  const renderRestyle=(extra:{manifests?:Catalogue}&Record<string,unknown>={})=>{
    (globalThis as unknown as {location:{hash:string}}).location={hash:""};
    return render({...extra,manifests:[restyle,...(extra.manifests??[])] as Catalogue,initial:"restyle"});
  };

  it("is a second choice inside Restyle, not another tool box",()=>{
    const html=renderRestyle({manifests:[maskedEdit()] as Catalogue,statuses:ready("wan21-vace-masked-edit")});
    expect(html).toContain("New background");
    expect(html).toContain("New look");
    expect(html).toContain('aria-label="What changes"');
    expect([...html.matchAll(/aria-label="Change a video"/g)]).toHaveLength(1);
  });

  it("stays out of sight until its masked edit can run here",()=>{
    expect(renderRestyle({manifests:[maskedEdit()] as Catalogue,statuses:{}})).not.toContain("New background");
    expect(renderRestyle({})).not.toContain("New background");
  });

  it("opens the masked edit with the background words already written",()=>{
    // The composer reads its saved draft and the run link from the browser; the render test has no browser.
    (globalThis as unknown as {location:{hash:string}}).location={hash:""};
    const edit=maskedEdit(),saved=store(),globals=globalThis as unknown as Record<"localStorage"|"sessionStorage",unknown>;
    const before={localStorage:globals.localStorage,sessionStorage:globals.sessionStorage};
    const empty={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
    Object.defineProperty(globalThis,"localStorage",{value:saved,configurable:true});
    Object.defineProperty(globalThis,"sessionStorage",{value:empty,configurable:true});
    try{
      seedBackgroundDraft(saved,draftKey("u","w","p",edit.id));
      const html=renderToStaticMarkup(createElement(TeamComposer,{manifest:edit,catalogue:[edit],workflowIds:[edit.id],onCapability:()=>{},user:base.user,workspace:base.workspace,project:base.project,workers:[] as Worker[],call:base.call,canQueue:true,authorized:true,onQueued:()=>{}}));
      expect(html).toContain("Replace the selected background");
    }finally{
      Object.defineProperty(globalThis,"localStorage",{value:before.localStorage,configurable:true});
      Object.defineProperty(globalThis,"sessionStorage",{value:before.sessionStorage,configurable:true});
    }
  });
});
