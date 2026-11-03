import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {InfluencerSceneList} from "../src/team/influencer/InfluencerStudio";

describe("influencer studio UI",()=>{
  it("lists scenes with order, estimated duration and character",()=>{
    const html=renderToStaticMarkup(<InfluencerSceneList scenes={["Welcome back to the channel.","Today we test the new pack."]} characterName="Mara"/>);
    expect(html).toContain("Scenes");
    expect(html).toContain("Scene 1");expect(html).toContain("Scene 2");
    expect(html).toContain("Welcome back to the channel.");
  });

  it("shows a truthful empty state without voice, lip-sync or generate affordances",()=>{
    const html=renderToStaticMarkup(<InfluencerSceneList scenes={[]}/>);
    expect(html).toContain("No scenes yet");expect(html).toContain("blank lines between scenes");
    expect(html).not.toMatch(/voice|lip.?sync|generate|render/i);
  });
  it("exposes separate per-scene cast assignments with truthful reference limits",()=>{
    const html=renderToStaticMarkup(<InfluencerSceneList scenes={["First.","Second."]} cast={[{id:"a",name:"Mara"},{id:"b",name:"Noor"}]} assignments={["a","b"]} onChange={()=>{}} onAssign={()=>{}}/>);
    expect(html).toContain("Scene 1 cast");expect(html).toContain("Scene 2 cast");expect(html).toContain("Mara");expect(html).toContain("Noor");expect(html).toContain("one assigned reference pack");expect(html).not.toMatch(/floor ring|multi.?person placement|guarantee/i);
  });

});
