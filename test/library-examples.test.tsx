import {afterEach,describe,expect,it,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {TeamLibrary} from "../src/team/TeamLibrary";
import {readdirSync} from "node:fs";
import {LIBRARY_EXAMPLE_VIDEOS} from "../src/team/reels";

describe("library example videos",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("includes every bundled example video in the project library",()=>{
    vi.stubGlobal("location",{hash:"#library"});
    const html=renderToStaticMarkup(<TeamLibrary workspace={{id:"w",name:"Shared",role:"creator"}} project={{id:"p",name:"Project"}} user={{id:"u",email:"user@example.test"}} call={async()=>({items:[],nextCursor:null}) as never} canEdit authorized version={0} videoEditReady={false} onEditVideo={()=>{}}/>);
    const bundled=readdirSync("public/reels").filter(name=>name.endsWith(".mp4")).map(name=>`/reels/${name}`).sort();
    expect([...LIBRARY_EXAMPLE_VIDEOS].sort()).toEqual(bundled);
    for(const src of LIBRARY_EXAMPLE_VIDEOS)expect(html).toContain(src);
  });
});
