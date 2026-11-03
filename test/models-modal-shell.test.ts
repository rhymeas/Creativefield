import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

const team=readFileSync("src/team/TeamApp.tsx","utf8");
const components=readFileSync("src/ds/components.tsx","utf8");

describe("models modal shell",()=>{
  it("opens Models from the top bar without replacing the active canvas route",()=>{
    expect(components).toContain("onSelect?: () => void");
    expect(team).toContain('{label:"Models",href:"#catalogue",onSelect:openModels}');
    expect(team).toContain('<Dialog wide className="cf-models-dialog" open={modelsOpen&&authorized} title="Models" onClose={closeModels}>');
    expect(team).toContain("<CapabilityCatalogue embedded");
  });

  it("keeps the modal tall and gives a worker problem its own fix",()=>{
    const teamCss=readFileSync("src/team/team.css","utf8");
    const library=readFileSync("src/team/ComfyLibrary.tsx","utf8");
    expect(teamCss).toContain(".cf-models-dialog { height: min(720px");
    expect(components).toContain('(!inDialog || global)');
    // the offline worker is one centred stage whose action is the fix (rule 36),
    // and a failed read retries from that same stage.
    expect(library).toContain('title: "The ComfyUI library did not load"');
    expect(library).toContain('"Start ComfyUI"');
    expect(library).toContain('"Check connection"');
  });

  it("routes setup actions from each supported workspace into the same modal",()=>{
    expect(team).toContain("onOpenModels={openModels}");
    expect(team).toContain("onModels={openModels}");
  });

  it("keeps the worker cards above the folders once a worker answers",()=>{
    const library=readFileSync("src/team/ComfyLibrary.tsx","utf8");
    const readyBranch=library.slice(library.lastIndexOf('return <div className="cf-library">'));
    expect(readyBranch.indexOf("{workerChoice}")).toBeGreaterThan(-1);
    expect(readyBranch.indexOf("{workerChoice}")).toBeLessThan(readyBranch.indexOf("cf-library__scroll"));
  });

  it("keeps the legacy catalogue deep link recoverable",()=>{
    expect(team).toContain('sectionFromHash(location.hash)==="catalogue"');
    expect(team).toContain('location.hash=modelsReturnHash.current.replace(/^#/,"")||"make"');
  });
});
