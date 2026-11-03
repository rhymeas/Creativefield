import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {NodeGraphDesign} from "../src/team/nodes/NodeGraphDesign";

describe("node design preview",()=>{
  it("identifies the example and offers the real editor without fake run controls",()=>{
    const html=renderToStaticMarkup(<NodeGraphDesign/>);
    expect(html).toContain("Node design preview");
    expect(html).toContain("Preview only");
    expect(html).toContain('href="#nodes"');
    expect(html).toContain("Open node editor");
    expect(html).not.toContain('aria-label="Add node"');
    expect(html).not.toContain('aria-label="Undo"');
    expect(html).not.toContain('aria-label="Redo"');
  });
});
