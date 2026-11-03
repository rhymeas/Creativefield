import {describe,expect,it,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {TeamMediaInput} from "../src/team/TeamMediaInput";
import {LIBRARY_EXAMPLE_VIDEOS} from "../src/team/reels";

vi.mock("../src/team/LibraryChoice",()=>({LibraryChoice:({options}:{options:{value:string}[]})=><div data-options={options.map(option=>option.value).join(",")}/> }));

describe("media input example choices",()=>{
  function render(accept:string){
    return renderToStaticMarkup(<TeamMediaInput label="Reference" type="image" accept={accept} file={null} selected={undefined} options={[]} disabled={false} canUpload workspace="w" onFile={()=>{}} onSelect={()=>{}} onUpload={()=>{}}/>);
  }
  it("offers video examples when an image input also accepts video",()=>{
    const options=render("image/png,video/mp4");
    for(const source of LIBRARY_EXAMPLE_VIDEOS)expect(options).toContain(`example:${source}`);
    expect(render("image/png,image/jpeg")).not.toContain("example:/reels/");
  });
});
