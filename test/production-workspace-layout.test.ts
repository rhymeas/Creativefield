import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

const read=(path:string)=>readFileSync(path,"utf8");

describe("production workspace layout",()=>{
  it("keeps guidance, results, history and examples in the shared content column",()=>{
    for(const path of [
      "src/team/TeamComposer.tsx",
      "src/image/ImageStudio.tsx",
      "src/team/TeamStoryboard.tsx",
      "src/team/audio/AudioStudio.tsx",
      "src/team/video-edit/VideoEditStudio.tsx",
      "src/team/TeamApp.tsx",
    ]) expect(read(path),path).toContain("<ProductionContent>");
  });

  it("places storyboard shots above the standard-width composer",()=>{
    const storyboard=read("src/team/TeamStoryboard.tsx");
    expect(storyboard.indexOf("<ShotStrip")).toBeLessThan(storyboard.indexOf("<Panel"));
    expect(storyboard.indexOf("<StoryboardModelChoice")).toBeGreaterThan(storyboard.indexOf("<Panel"));
    expect(read("src/team/team.css")).not.toContain(".cf-storyboard>.ds-panel");
  });

  it("keeps 3D generation on the shared composer and 3D editing on the DS split",()=>{
    expect(read("src/team/three-d/ImageTo3DPanel.tsx")).toContain("<TeamComposer");
    const tools=read("src/team/three-d/ModelToolsPanel.tsx");
    expect(tools).toContain("<Page fill><Split><Panel");
    expect(tools).toContain("<Canvas");
  });
});
