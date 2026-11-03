import {readFileSync} from "node:fs";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {GettingStarted,GettingStartedSteps,onboardingDismissed,onboardingKey,saveOnboarding} from "../src/team/GettingStarted";
import {StartScreen} from "../src/team/StartScreen";

describe("getting started",()=>{
  it("isolates dismissal by account and workspace and supports reopening",()=>{
    const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
    const a=onboardingKey("alice","one"),b=onboardingKey("bob","one"),c=onboardingKey("alice","two");
    expect(onboardingDismissed(storage,a)).toBe(false);saveOnboarding(storage,a,true);
    expect(onboardingDismissed(storage,a)).toBe(true);expect(onboardingDismissed(storage,b)).toBe(false);expect(onboardingDismissed(storage,c)).toBe(false);
    saveOnboarding(storage,a,false);expect(onboardingDismissed(storage,a)).toBe(false);
  });
  it("survives denied browser storage",()=>{
    const denied=()=>{throw new Error("denied");};
    expect(onboardingDismissed({getItem:denied},"key")).toBe(false);
    expect(()=>saveOnboarding({setItem:denied,removeItem:denied},"key",true)).not.toThrow();
  });
  it("gives admins setup navigation and other roles an actionable explanation",()=>{
    const props={userId:"a",workspaceId:"w",workers:[],onSettings:()=>{}};
    const admin=renderToStaticMarkup(<GettingStartedSteps workers={props.workers} onSettings={props.onSettings} admin/>);
    const viewer=renderToStaticMarkup(<GettingStartedSteps workers={props.workers} onSettings={props.onSettings} admin={false}/>);
    expect(admin).toContain("Worker settings");expect(viewer).not.toContain("Worker settings");expect(viewer).toContain("Ask your admin");
    for(const html of [admin,viewer]){expect(html).toContain("Projects");expect(html).toContain("Models");}
    const trigger=renderToStaticMarkup(<GettingStarted {...props} admin/>);
    expect(trigger).toContain("Workspace setup");
    expect(trigger).not.toContain("1. Choose your project");
    expect(trigger).not.toContain("Hide guide");
  });
  it("keeps setup in the workspace bar and lists the available tool groups under the hero",()=>{
    const team=readFileSync("src/team/TeamApp.tsx","utf8");
    const css=readFileSync("src/team/team.css","utf8");
    const screen=renderToStaticMarkup(<StartScreen ready={{always:true}}/>);
    expect(team).toContain('route==="make"&&<GettingStarted');
    expect(screen).not.toContain("Workspace setup");
    expect(screen).toContain('class="cf-start__tools"');
    expect(css).toContain(".cf-start__tools { flex:1; display:grid; align-content:start; gap:var(--gap-block)");
    expect(css).toContain("repeat(auto-fit");
  });
});
