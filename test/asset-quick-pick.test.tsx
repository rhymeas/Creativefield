import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {AssetQuickPick} from "../src/team/AssetQuickPick";
import {TeamMediaInput} from "../src/team/TeamMediaInput";
import type {Asset} from "../src/team/api";

const video=(id:string,name:string,created:string)=>({id,project_id:"project",name,media_type:"video",content_type:"video/mp4",bytes:"10",created_at:created,parent_id:null});
const older=video("old","First cut","2026-10-18T10:00:00Z"),newer=video("new","Latest generation","2026-10-18T12:00:00Z");

describe("reusing generated media",()=>{
  it("lists newest project videos first and makes each one draggable",()=>{
    const html=renderToStaticMarkup(<AssetQuickPick workspace="workspace" assets={[older,newer]} selectedId="new" label="Recent project videos" onSelect={()=>{}}/>);
    expect(html.indexOf("Latest generation")).toBeLessThan(html.indexOf("First cut"));
    expect(html).toContain("draggable");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('aria-label="Preview Latest generation (selected)"');
    expect(html).not.toContain('role="checkbox"');
  });

  it("keeps every media input to one drop zone and one Library choice",()=>{
    // Reuse goes through the Library picker (a picture grid, newest first); no second strip of thumbnails under the field.
    const html=renderToStaticMarkup(<TeamMediaInput label="Source clip" type="video" file={null} selected={undefined} options={[older,newer]} disabled={false} canUpload workspace="workspace" onFile={()=>{}} onSelect={()=>{}} onUpload={()=>{}}/>);
    expect(html).toContain("Source clip");
    expect(html).toContain("Choose from library");
    expect(html).not.toContain("Recent source clip media");
  });

  it("builds the media field from design-system parts, with one hover stack",()=>{
    const slot=(selected?:Asset)=>renderToStaticMarkup(<TeamMediaInput label="Source clip" type="video" file={null} selected={selected} options={[]} disabled={false} canUpload workspace="workspace" onFile={()=>{}} onSelect={()=>{}} onUpload={()=>{}}/>);
    // Empty: a drop target around the upload slot. Nothing about the zone is hand-written in the feature.
    const empty=slot();
    expect(empty).toContain("ds-droptarget");
    expect(empty).toContain("ds-upload");
    expect(empty).not.toContain("cf-media");
    // Chosen: one media card, one stack of tile actions that shows on hover and focus.
    const filled=slot(newer);
    expect(filled).toContain("ds-mediacard__overlay");
    expect(filled.match(/ds-mediacard__overlay/g)?.length).toBe(1);
    expect(filled).toContain('aria-label="View Source clip"');
    expect(filled).not.toContain("ds-upload");
    expect(filled).not.toContain("cf-media");
  });
});
