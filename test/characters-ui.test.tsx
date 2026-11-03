import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {CharacterDetail} from "../src/team/characters/CharacterDetail";
import {castDraftWithCharacter,characterCreateBody,characterUsageCaption,characterEmptyAction,characterPath,keepCharacterSelection,requestCharacterDialogClose,updateReferenceSelection} from "../src/team/characters/state";
import type {CharacterRecord} from "../src/team/api";

const record:CharacterRecord={id:"character-a",projectId:"project-a",elementId:"element-a",name:"Ari",description:"",createdAt:"2026-10-16T00:00:00.000Z",referencePack:{version:1,references:[{ordinal:0,assetId:"asset-a",assetProjectId:"project-a",assetSha256:"a".repeat(64),assetMediaType:"image",assetContentType:"image/png",assetBytes:12,assetMetadata:{}}]}};

describe("character team UI state",()=>{
  it("distinguishes proven usage from an older server with no counts",()=>{
    expect(characterUsageCaption()).toBeUndefined();
    expect(characterUsageCaption({referenceRuns:0,completedShots:0})).toBe("0 tracked shots");
    expect(characterUsageCaption({referenceRuns:2,completedShots:1})).toBe("1 tracked shot");
    expect(characterUsageCaption({referenceRuns:2,completedShots:3})).toBe("3 tracked shots");
    expect(characterUsageCaption({referenceRuns:-1,completedShots:3})).toBeUndefined();
    expect(characterUsageCaption({referenceRuns:2,completedShots:Infinity})).toBeUndefined();
    const html=renderToStaticMarkup(<CharacterDetail record={{...record,usage:{referenceRuns:2,completedShots:3}}} loading={false} workspace={{id:"w",name:"Studio",role:"creator"}} call={async()=>{throw new Error("SSR does not fetch");}}/>);
    expect(html).toContain("3 tracked shots");expect(html).toContain("2 verified reference");
    expect(html).toContain("does not evaluate visible identity");
    const missing=renderToStaticMarkup(<CharacterDetail record={record} loading={false} workspace={{id:"w",name:"Studio",role:"creator"}} call={async()=>{throw new Error("SSR does not fetch");}}/>);
    expect(missing).not.toContain("[object Object]");
  });

  it("scopes API paths and clears a selection that is not in the new project",()=>{
    expect(characterPath("workspace a","project/a","character?a")).toBe("/workspaces/workspace%20a/projects/project%2Fa/characters/character%3Fa");
    expect(keepCharacterSelection([record],"stale")).toBe("character-a");
    expect(keepCharacterSelection([],"character-a")).toBe("");
  });

  it("offers the next doable step in the empty state, never a dead action",()=>{
    expect(characterEmptyAction(true,0)).toBe("add-image");
    expect(characterEmptyAction(true,3)).toBe("create");
    expect(characterEmptyAction(false,3)).toBe("none");
    expect(characterEmptyAction(false,0)).toBe("none");
  });

  it("keeps reference selection ordered, unique, removable and capped at sixteen",()=>{
    const selected=Array.from({length:16},(_,index)=>`asset-${index}`);
    expect(updateReferenceSelection(["asset-a"],"asset-b",true)).toEqual(["asset-a","asset-b"]);
    expect(updateReferenceSelection(["asset-a"],"asset-a",true)).toEqual(["asset-a"]);
    expect(updateReferenceSelection(selected,"asset-16",true)).toEqual(selected);
    expect(updateReferenceSelection(["asset-a","asset-b"],"asset-a",false)).toEqual(["asset-b"]);
  });

  it("keeps an in-flight creation dialog open so an old completion cannot close a reopened draft",async()=>{
    let open=true,draft="Ari",busy=true,created=0;
    let release!:()=>void;
    const delayedPost=new Promise<void>(resolve=>{release=resolve;});
    const pending=delayedPost.then(()=>{busy=false;created+=1;open=false;});
    const close=()=>requestCharacterDialogClose(busy,()=>{open=false;});

    expect(close()).toBe(false);
    if(!open){open=true;draft="Replacement draft";}
    expect(open).toBe(true);
    expect(draft).toBe("Ari");

    release();
    await pending;
    expect(created).toBe(1);
    expect(open).toBe(false);
    expect(close()).toBe(true);
  });

  it("sends the trimmed name and the optional one-line description the server stores",()=>{
    expect(characterCreateBody("  Ari  ","  Street magician  ",["asset-a"],"key-1")).toEqual({idempotencyKey:"key-1",name:"Ari",description:"Street magician",referenceAssetIds:["asset-a"]});
    expect(characterCreateBody("Ari","",["asset-a"],"key-1").description).toBe("");
  });

  it("puts the character in the Scenes cast and leaves the rest of the draft alone",()=>{
    const draft={characterId:"",title:"",script:"",castIds:["character-b"],scenes:[{key:"scene-1",text:"Waves.",characterId:"character-b"}]};
    const next=castDraftWithCharacter(draft,"character-a");
    expect(next.castIds).toEqual(["character-b","character-a"]);
    expect(next.scenes).toEqual(draft.scenes);
    expect(castDraftWithCharacter(next,"character-a").castIds).toEqual(["character-b","character-a"]);
    expect(castDraftWithCharacter(null,"character-a").castIds).toEqual(["character-a"]);
  });

  it("shows the description and the one true line without generation controls",()=>{
    const html=renderToStaticMarkup(<CharacterDetail record={{...record,description:"Street magician"}} loading={false} workspace={{id:"workspace-a",name:"Studio",role:"viewer"}} call={async()=>{throw new Error("not used during server render");}}/>);
    expect(html).toContain("Street magician");
    expect(html).toContain("Works in Scenes and image edit.");
    expect(html).toContain("Identity consistency has not been evaluated.");
    expect(html).not.toContain("No approved hosted adapter");
    expect(html).not.toContain("Script, voice, performance foundation");
    expect(html).not.toContain("Later slice");
    expect(html).not.toContain("Generate character");
    expect(html).not.toContain("Open catalogue");
    expect(html).not.toContain("Make scenes");
  });
});
