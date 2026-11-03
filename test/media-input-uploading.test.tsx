import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {TeamMediaInput} from "../src/team/TeamMediaInput";

const input=(extra:{uploading?:string;type?:string}={})=>renderToStaticMarkup(<TeamMediaInput label="Motion video" type={extra.type??"video"} file={null} selected={undefined} options={[]} disabled={false} canUpload workspace="w" onFile={()=>{}} onSelect={()=>{}} onUpload={()=>{}} uploading={extra.uploading}/>);

describe("the media box says when a file is on its way in",()=>{
  it("shows the words inside the drop box while uploading",()=>{
    const html=input({uploading:"Uploading…"});
    expect(html).toContain('class="ds-droptarget__busy"');
    expect(html).toContain("Uploading…");
    // The words sit inside the same drop target that holds the zone, not beside it.
    expect(html.indexOf("ds-droptarget__busy")).toBeGreaterThan(html.indexOf("ds-droptarget"));
    expect(html.indexOf("ds-droptarget__busy")).toBeLessThan(html.indexOf("Choose from library"));
  });
  it("shows nothing extra when no upload is running",()=>{
    expect(input()).not.toContain("ds-droptarget__busy");
  });
  it("draws a video zone the same way as an image zone: icon, label, hint, full size",()=>{
    const video=input({type:"video"}),image=input({type:"image"});
    expect(video).not.toContain("ds-upload--compact");
    expect(image).not.toContain("ds-upload--compact");
  });
});
