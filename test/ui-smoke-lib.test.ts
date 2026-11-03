import {describe,expect,it} from "vitest";
import {classifyScreen,isForbiddenAction,noticeLooksBroken} from "../scripts/ui-smoke-lib.mjs";

/* The smoke check is read-only: it classifies what the browser saw, it never clicks a control
   that writes. These cases use fake events only; no browser runs here. */
describe("one screen's raw events become findings",()=>{
  it("reports a console error and a page error with the step that caused it",()=>{
    const findings=classifyScreen({
      screen:"Video",
      consoleErrors:[{step:"Create",text:"Failed to load resource: 500"}],
      pageErrors:[{step:"Change",text:"Cannot read properties of undefined"}],
    });
    expect(findings).toEqual([
      {screen:"Video",step:"Create",kind:"console-error",message:"Failed to load resource: 500"},
      {screen:"Video",step:"Change",kind:"page-error",message:"Cannot read properties of undefined"},
    ]);
  });
  it("reports a response of 400 or higher with its url and status",()=>{
    const findings=classifyScreen({screen:"Video",responses:[{step:"Storyboard",url:"http://127.0.0.1:8787/api/v1/ws/runs",status:503}]});
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("http-error");
    expect(findings[0].message).toBe("503 http://127.0.0.1:8787/api/v1/ws/runs");
  });
  it("reports only the Notices that say something broke",()=>{
    const findings=classifyScreen({
      screen:"Library",
      notices:[
        {step:"Assets",text:"Asset request failed Could not reach the team server."},
        {step:"Assets",text:"Drafts remain available. No execution route will be switched."},
        {step:"Runs",text:"You are not allowed to read these runs."},
      ],
    });
    expect(findings.map(finding=>finding.step)).toEqual(["Assets","Runs"]);
    expect(findings.every(finding=>finding.kind==="notice")).toBe(true);
  });
  it("matches the three problem phrases without caring about case",()=>{
    expect(noticeLooksBroken("Something went wrong while saving.")).toBe(true);
    expect(noticeLooksBroken("NOT ALLOWED")).toBe(true);
    expect(noticeLooksBroken("The run failed.")).toBe(true);
    expect(noticeLooksBroken("Runs appear here after you queue one.")).toBe(false);
  });
  it("reports an element that is wider than its parent",()=>{
    const findings=classifyScreen({screen:"Image",overflows:[{step:"Angles",selector:"div.cf-angle-strip",scroll:640,client:420}]});
    expect(findings).toEqual([{screen:"Image",step:"Angles",kind:"overflow",message:"div.cf-angle-strip is 640px wide inside 420px"}]);
  });
  it("reports a blocked write as a finding named after the click",()=>{
    const findings=classifyScreen({screen:"Nodes",blocked:[{step:"Nodes",method:"POST",url:"http://127.0.0.1:8787/api/v1/ws/assets"}]});
    expect(findings).toEqual([{screen:"Nodes",step:"Nodes",kind:"blocked-request",message:"POST http://127.0.0.1:8787/api/v1/ws/assets was blocked (read-only)"}]);
  });
  it("reports a failed check and a body that stayed empty",()=>{
    const findings=classifyScreen({
      screen:"Video",
      checks:[{step:"Full view",name:"actions: Open in",ok:false,message:"The full view has no Open in action."},{step:"Full view",name:"viewer opens",ok:true,message:"ignored"}],
      emptyBody:{step:"Trim",waitedSeconds:5},
    });
    expect(findings).toEqual([
      {screen:"Video",step:"Full view",kind:"check-failed",message:"The full view has no Open in action."},
      {screen:"Video",step:"Trim",kind:"empty-body",message:"the body stayed empty for 5 s"},
    ]);
  });
  it("keeps one finding per message per step",()=>{
    const findings=classifyScreen({
      screen:"Video",
      consoleErrors:[{step:"Create",text:"Boom"},{step:"Create",text:"Boom"},{step:"Create",text:"  Boom  "}],
    });
    expect(findings).toHaveLength(1);
  });
  it("returns nothing for a clean screen",()=>{
    expect(classifyScreen({screen:"Projects",notices:[{step:"Projects",text:"Three projects."}]})).toEqual([]);
  });
  it("never clicks a control that writes",()=>{
    for(const label of ["Generate","Queue video","Upload media","Delete file","Remove","Save","Create project","Apply crop","Confirm","Cancel run","Resolve","Mark as done"]) expect(isForbiddenAction(label)).toBe(true);
    for(const label of ["Open in","Download","Storyboard","Change","View media","All tools"]) expect(isForbiddenAction(label)).toBe(false);
  });
});
