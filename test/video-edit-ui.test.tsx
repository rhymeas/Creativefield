import {renderToStaticMarkup} from "react-dom/server";
import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {VideoEditStudio} from "../src/team/video-edit";

describe("trim workspace UI",()=>{
  it("shows the implemented trim operation without unavailable extension controls",()=>{
    const html=renderToStaticMarkup(<VideoEditStudio workspace={{id:"workspace",name:"Shared",role:"creator"}} project={{id:"project",name:"Film"}} call={async()=>({items:[],nextCursor:null}) as never} requirements={{contractVersion:1,trim:{state:"ready",missing:[],instructions:"",versions:{ffmpeg:"ffmpeg version 7.1"}},forwardExtension:{workflow:{state:"unsupported",reasons:["Unavailable"],missing:[]},tools:{}},audioPolicies:["mute","preserve"]}} onChanged={()=>{}}/>);
    expect(html).toContain("cf-production__content");
    expect(html).toContain("Cut</span><span class=\"ds-hero__word\"");
    expect(html).toContain("Trim video</button>");
    expect(html).toContain("No video chosen");
    expect(html).toContain("Add a video in Library");
    expect(html).not.toContain("Choose a validated 16 FPS project video to preview the source.");
    expect(html).not.toContain("Forward extension");
    expect(html).not.toContain("Backward extension");
    expect(html).not.toContain("Overlap frames");
  });

  it("puts the source video in the same media box as every other screen, on the design-system drop target",()=>{
    const source=readFileSync("src/team/video-edit/VideoEditStudio.tsx","utf8");
    expect(source).toContain("<TeamMediaInput");
    expect(source).not.toMatch(/onDragOver/);
    expect(readFileSync("src/team/TeamMediaInput.tsx","utf8")).toContain("<DropTarget");
  });
});
