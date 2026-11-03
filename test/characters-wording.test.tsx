import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {CharacterDetail} from "../src/team/characters/CharacterDetail";
import type {CharacterRecord} from "../src/team/api";

const record:CharacterRecord={id:"character-a",projectId:"project-a",elementId:"element-a",name:"Ari",description:"",createdAt:"2026-10-16T00:00:00.000Z",referencePack:{version:1,references:[{ordinal:0,assetId:"asset-a",assetProjectId:"project-a",assetSha256:"a".repeat(64),assetMediaType:"image",assetContentType:"image/png",assetBytes:12,assetMetadata:{}}]}};

/* The old "Identity generation missing" row promised a feature the app cannot run; it is gone on purpose. */
describe("character detail honesty",()=>{
  it("states what a character does today and offers the next step instead of a missing identity feature",()=>{
    const html=renderToStaticMarkup(<CharacterDetail record={record} loading={false} workspace={{id:"workspace-a",name:"Studio",role:"viewer"}} call={async()=>{throw new Error("not used during server render");}} onMakeScenes={()=>{}}/>);
    expect(html).toContain("Works in Scenes and image edit.");
    expect(html).toContain("Make scenes");
    expect(html).not.toContain("Identity generation missing:");
    expect(html).not.toContain("View requirements");
    expect(html).not.toContain("Generate character");
  });
});
