import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {MaskHowItWorks} from "../src/team/mask-how-it-works";

describe("mask how-it-works guide",()=>{
  it("renders three visual steps and the manual-mask boundary",()=>{
    const html=renderToStaticMarkup(<MaskHowItWorks/>);
    expect(html.match(/<svg/g)).toHaveLength(3);
    expect(html).toContain("Choose the clip");
    expect(html).toContain("Add a mask video");
    expect(html).toContain("Describe the white area");
    expect(html).toContain("White marks the edit area");
    expect(html).toContain("encoded export can still have pixel differences");
    expect(html).toContain("Object tracking appears when a compatible local worker is ready");
  });
  it("describes tracking only when a compatible worker is ready",()=>{
    const html=renderToStaticMarkup(<MaskHowItWorks trackingAvailable/>);
    expect(html).toContain("Describe the object and review its mask");
    expect(html).toContain("review the generated mask before using it");
  });
});
