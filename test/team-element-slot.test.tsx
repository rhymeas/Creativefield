import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {TeamMediaInput} from "../src/team/TeamMediaInput";
import {assetUrl,type Asset} from "../src/team/api";

const slot=(element?:{name:string;src:string},selected?:Asset)=>renderToStaticMarkup(<TeamMediaInput label="Character image" type="image" file={null} selected={selected} element={element} options={[]} disabled={false} canUpload workspace="w" onFile={()=>{}} onSelect={()=>{}} onUpload={()=>{}}/>);

describe("the media slot shows the saved character",()=>{
  it("fills the slot with the Element asset and names it",()=>{
    const element={name:"Ari",src:assetUrl("w","22222222-2222-4222-8222-222222222222")},html=slot(element);
    // The drop zone shows the saved character's picture, never an empty placeholder.
    expect(html).toContain(`<img src="${element.src}"`);
    expect(html).toContain("Ari");
    // Something already fills the port, so the library pill offers to change it.
    expect(html).toContain("Change");
    expect(html).not.toContain("Choose from library");
  });
  it("stays an empty drop zone when no Element fills the port",()=>{
    const html=slot();
    expect(html).not.toContain("<img src=");
    expect(html).toContain("Choose from library");
  });
});
