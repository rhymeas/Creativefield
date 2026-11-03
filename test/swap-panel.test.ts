import {describe,expect,it} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {Call,Project,Workspace} from "../src/team/api";
import {SwapThingPanel,progressLabel} from "../src/team/SwapThingPanel";

describe("swap panel",()=>{
  it("says what is happening in the words of the thing being changed",()=>{
    expect(progressLabel("Find the red car…")).toBe("Finding the red car…");
    expect(progressLabel("Change the red car…")).toBe("Changing the red car…");
    expect(progressLabel("")).toBe("");
  });

  it("offers the main action and says what is still missing",()=>{
    const html=renderToStaticMarkup(createElement(SwapThingPanel,{
      workspace:{id:"w"} as Workspace,project:{id:"p"} as Project,workerId:"worker",
      call:(()=>Promise.resolve(null)) as unknown as Call,canEdit:true,onChanged:()=>{},
    }));
    expect(html).toContain("What to change");
    expect(html).toContain("Generate");
    expect(html).toContain("Add your video.");
    expect(html).not.toContain("Cancel");
    // The clip envelope is short words in the drop zone, not a grey line under it.
    expect(html).toContain("Drop a video, up to 5 s");
    expect(html).not.toContain("1 to 5 seconds");
  });

  it("shows the active editing model above the video input",()=>{
    const html=renderToStaticMarkup(createElement(SwapThingPanel,{
      workspace:{id:"w"} as Workspace,project:{id:"p"} as Project,workerId:"worker",
      call:(()=>Promise.resolve(null)) as unknown as Call,canEdit:true,onChanged:()=>{},
      promptOnly:true,modelTitle:"Selected edit model",
    }));
    expect(html).toContain("Selected edit model");
    expect(html.indexOf("Selected edit model")).toBeLessThan(html.indexOf("Your video"));
  });
});
