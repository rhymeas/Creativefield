import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {HistoryItem,MediaCard,MediaEditProvider} from "../src/ds/components";

describe("library media controls",()=>{
  it("makes a media thumbnail a keyboard-accessible view action",()=>{
    const html=renderToStaticMarkup(<MediaCard quiet media={<img src="/asset.png" alt=""/>} viewLabel="View portrait.png" onView={()=>{}} actions={<button type="button">Edit</button>}/>);
    expect(html).toContain("aria-label=\"View portrait.png\"");
    expect(html).toContain("ds-mediacard__view");
    expect(html).toContain("Edit");
  });
  it("offers the same view and edit actions on generated history images",()=>{
    const html=renderToStaticMarkup(<MediaEditProvider onEdit={()=>{}}><HistoryItem media={<img src="/asset.png" alt="Result"/>} model="Local workflow" prompt="A scene" meta="Complete" date=""/></MediaEditProvider>);
    expect(html).toContain('aria-label="Full view"');
    expect(html).toContain('aria-label="Edit media"');
    expect(html).not.toContain('class="ds-details"');
  });
  it("keeps audio controls playable without image preview actions",()=>{
    const html=renderToStaticMarkup(<MediaCard quiet media={<audio src="/audio.wav" controls/>}/>);
    expect(html).toContain("<audio");
    expect(html).not.toContain("ds-mediacard__view");
    expect(html).not.toContain('aria-label="Full view"');
  });

});
