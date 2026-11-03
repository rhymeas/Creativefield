import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {GettingStartedSteps} from "../src/team/GettingStarted";
import {audienceOf,comfyStep,connectComfyAction,noWorkspaceText,settingsLabel,workspaceFacts} from "../src/team/audience";
import type {Worker} from "../src/team/api";

/* running locally as one person, no screen mentions an administrator, a team, a role or an
   invitation. A shared workspace keeps today's wording. */

const forbidden = /administrator|admin|invitation|invite|workspace role|\bteam\b/i;

describe("who the screen is talking to",()=>{
  it("reads the account's own mode",()=>{
    expect(audienceOf({localSingleUser:true})).toBe("solo");
    expect(audienceOf({})).toBe("team");
    expect(audienceOf(null)).toBe("team");
  });
  it("names the settings dialog in the reader's words",()=>{
    expect(settingsLabel("solo")).toBe("Settings");
    expect(settingsLabel("team")).toBe("Team settings");
    expect(connectComfyAction("solo")).toBe("Settings");
    expect(connectComfyAction("team")).toBe("Worker settings");
  });
  it("never sends one person to an administrator or an invitation",()=>{
    expect(noWorkspaceText("solo")).not.toMatch(forbidden);
    expect(noWorkspaceText("team")).toContain("workspace administrator");
    expect(workspaceFacts("solo",{name:"Studio demo",role:"admin"})).toEqual(["Studio demo"]);
    expect(workspaceFacts("team",{name:"Studio demo",role:"admin"})).toEqual(["Studio demo","admin"]);
  });
  it("tells the truth about ComfyUI in both modes, connected or not",()=>{
    for(const audience of ["solo","team"] as const){
      for(const connected of [true,false]){
        const step=comfyStep(audience,connected);
        expect(step.title).toMatch(/^2\. /);
        expect(step.text.length).toBeGreaterThan(20);
      }
    }
    expect(comfyStep("solo",false).text).not.toMatch(forbidden);
    expect(comfyStep("solo",true).text).not.toMatch(forbidden);
    expect(comfyStep("team",false).text).toContain("Ask your admin");
    // Nobody is sent to start or probe ComfyUI elsewhere and come back to reload the page.
    for(const audience of ["solo","team"] as const) expect(comfyStep(audience,false).text).not.toMatch(/separately|reload this page/i);
  });
  it("gives one person the settings step and no role wording in setup",()=>{
    const workers:Worker[]=[];
    const solo=renderToStaticMarkup(<GettingStartedSteps admin={false} audience="solo" workers={workers} onSettings={()=>{}}/>);
    expect(solo).toContain("2. Connect ComfyUI");
    expect(solo).toContain(">Settings<");
    expect(solo).not.toMatch(forbidden);
    const team=renderToStaticMarkup(<GettingStartedSteps admin={false} audience="team" workers={workers} onSettings={()=>{}}/>);
    expect(team).toContain("Ask your admin");
    expect(team).not.toContain("Worker settings");
    const admin=renderToStaticMarkup(<GettingStartedSteps admin audience="team" workers={workers} onSettings={()=>{}}/>);
    expect(admin).toContain("Worker settings");
    expect(admin).not.toContain("2. Connect ComfyUI");
  });
});
