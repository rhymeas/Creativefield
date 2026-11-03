import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {ROUTES,routeState,rootViewFromHash,sectionFromHash,type RouteInput,type RouteState} from "../src/team/route-state";
import {START_TASKS} from "../src/team/start-tasks";

/** This computer can run everything, signed in with creator access and a loaded workflow list. */
const ready:RouteInput={section:"make",mode:"create",canCreate:true,catalogueKnown:true,video:true,motion:true,image:true,audioKnown:true,audio:true,trimKnown:true,trim:true};
const state=(patch:Partial<RouteInput>):RouteState=>routeState({...ready,...patch});
const missing=(patch:Partial<RouteInput>)=>{
  const result=state(patch);
  if(result.kind!=="missing")throw new Error(`expected a named state, got ${result.kind}`);
  return result;
};

describe("route state",()=>{
  it("switches root views when opening or leaving a standalone design page",()=>{
    expect(rootViewFromHash("#nodes")).toBe("app");
    expect(rootViewFromHash("#video/transform")).toBe("app");
    expect(sectionFromHash("#video/transform/edit")).toBe("video");
    expect(rootViewFromHash("#nodedesign")).toBe("node-design");
    expect(rootViewFromHash("#ds")).toBe("showcase");
    expect(rootViewFromHash("#nodedesign")).not.toBe(rootViewFromHash("#nodes"));
  });
  it("opens every screen this app has",()=>{
    for(const section of ["make","projects","imageedit","characters","influencer","3d","nodes","catalogue","library","openjutsu"]){
      expect(state({section}),section).toEqual({kind:"screen"});
    }
    for(const section of ["video","motion","image","audio"])expect(state({section}),section).toEqual({kind:"screen"});
    expect(state({section:"video",mode:"trim"})).toEqual({kind:"screen"});
  });
  it("names an unknown hash instead of showing the Library",()=>{
    const result=missing({section:"nope"});
    expect(result.title).toBe("This page does not exist");
    expect(result.text).toContain("All tools");
    expect(result.next).toEqual({label:"All tools",href:"#make"});
    expect(sectionFromHash("#models")).toBe("catalogue");
    expect(sectionFromHash("#models/old")).toBe("catalogue");
    expect(missing({section:"marketing",image:false}).title).toBe("Ad Studio is not ready here");
    expect(routeState({...ready,section:"marketing",image:true})).toEqual({kind:"screen"});
    expect(state({section:"remix",image:true})).toEqual({kind:"screen"});
    expect(missing({section:"remix",image:false}).title).toBe("Remix Studio is not ready here");
  });
  it("says what is missing on a screen this computer cannot run yet",()=>{
    expect(missing({section:"audio",audio:false}).title).toBe("Audio is not ready here");
    expect(missing({section:"motion",motion:false}).title).toBe("Motion is not ready here");
    expect(missing({section:"image",image:false}).title).toBe("Pictures are not ready here");
    expect(missing({section:"video",video:false}).title).toBe("Video is not ready here");
    expect(missing({section:"video",mode:"trim",trim:false}).title).toBe("Trimming is not ready here");
    for(const patch of [{section:"audio",audio:false},{section:"motion",motion:false},{section:"image",image:false},{section:"video",video:false},{section:"video",mode:"trim",trim:false}]){
      expect(missing(patch).next,patch.section).toEqual({label:"Open Models",href:"#catalogue"});
    }
  });
  it("waits for the server before saying a screen is not ready",()=>{
    expect(state({section:"audio",audioKnown:false,audio:false})).toEqual({kind:"checking"});
    expect(state({section:"video",mode:"trim",trimKnown:false,trim:false})).toEqual({kind:"checking"});
    expect(state({section:"video",video:false,catalogueKnown:false})).toEqual({kind:"checking"});
    expect(state({section:"motion",motion:false,catalogueKnown:false})).toEqual({kind:"checking"});
    expect(state({section:"image",image:false,catalogueKnown:false})).toEqual({kind:"checking"});
  });
  it("shows no action when the person cannot make things here",()=>{
    for(const patch of [{section:"audio",audio:false},{section:"video",mode:"trim",trim:false}]){
      const result=missing({...patch,canCreate:false});
      expect(result.title,patch.section).toBe("You cannot make this here yet");
      expect(result.next,patch.section).toBeUndefined();
    }
  });
  it("offers one action that opens a real screen",()=>{
    const patches:Partial<RouteInput>[]=[{section:"nope"},{section:"audio",audio:false},{section:"motion",motion:false},{section:"image",image:false},{section:"video",video:false},{section:"video",mode:"trim",trim:false}];
    for(const patch of patches){
      const next=missing(patch).next;
      expect(next,patch.section).toBeDefined();
      expect(next!.href.startsWith("#"),next!.href).toBe(true);
      expect(ROUTES,next!.href).toContain(next!.href.slice(1).split("/")[0]);
      expect(next!.label.split(" ").length,next!.label).toBeLessThanOrEqual(3);
    }
  });
  it("uses short, plain copy",()=>{
    const patches:Partial<RouteInput>[]=[{section:"nope"},{section:"audio",audio:false},{section:"motion",motion:false},{section:"image",image:false},{section:"video",video:false},{section:"video",mode:"trim",trim:false},{section:"audio",audio:false,canCreate:false}];
    for(const patch of patches){
      const {title,text}=missing(patch);
      expect(title.length,patch.section).toBeLessThanOrEqual(40);
      expect(title.endsWith("."),title).toBe(false);
      expect(title.split(" ").length,title).toBeLessThanOrEqual(7);
      expect(text.endsWith("."),text).toBe(true);
      expect(`${title} ${text}`,patch.section).not.toMatch(/workflow|capability|render|SCAIL|VACE|Wan|FLUX|ComfyUI/i);
    }
  });
  it("keeps every start-screen task on a hash the app opens",()=>{
    for(const task of START_TASKS)expect(ROUTES,task.href).toContain(task.href.slice(1).split("/")[0]);
  });
});

/* Rule 19: two navigation levels only. The top bar carries the sections, one `WorkspaceBar` carries the
   modes of the open section, and the side rail that repeated the top bar is gone. A screen the rail used
   to reach keeps its door in the top bar or on the All tools screen (`START_TASKS`). */
describe("one navigation surface",()=>{
  const source=readFileSync("src/team/TeamApp.tsx","utf8");
  /* Every hash a top-bar entry points at, plus every task the All tools screen can open. */
  const doors=new Set<string>([
    ...[...source.matchAll(/href:([^,}]+)/g)].flatMap(m=>[...m[1].matchAll(/#([a-z0-9]+)/g)].map(hash=>hash[1])),
    ...START_TASKS.map(task=>task.href.slice(1).split("/")[0]),
  ]);
  it("draws the top bar and one workspace bar, and no side rail",()=>{
    expect(source).not.toMatch(/\bAppRail\b/);
    expect(source.match(/<TopBar[\s>]/g)?.length).toBe(1);
    expect(source.match(/<WorkspaceBar[\s>]/g)?.length).toBe(1);
  });
  it("keeps a door for every screen the side rail used to reach",()=>{
    const railed=["make","video","image","motion","characters","audio","3d","catalogue","nodes","library"];
    for(const section of railed){
      expect([...doors],section).toContain(section);
      expect(ROUTES,section).toContain(section);
    }
  });
});
