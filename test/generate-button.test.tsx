import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {GenerateButton} from "../src/ds";

describe("the main action is the sparkle and one word",()=>{
  it("shows the sparkle and Generate, no amount and no unit",()=>{
    const html=renderToStaticMarkup(<GenerateButton/>);
    expect(html).toContain("Generate");
    expect(html).toContain("<svg");
    expect(html).not.toMatch(/\bfr\b|\bimg\b|ds-generate__cost/);
  });
  it("lets the loader take the sparkle's place while a run starts",()=>{
    const html=renderToStaticMarkup(<GenerateButton busy/>);
    expect(html).toContain("Generating");
    expect(html).toContain("ds-sparkle");
  });
  it("says in plain view why it cannot run",()=>{
    expect(renderToStaticMarkup(<GenerateButton disabled disabledReason="Add your video."/>)).toContain("Add your video.");
  });
});
