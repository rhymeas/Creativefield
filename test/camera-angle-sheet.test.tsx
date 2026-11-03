import {describe,expect,it,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {CameraAngleSheet} from "../src/ds/CameraAngleSheet";

const items=["High left","High","High right","Left 45","Right 45","Low left","Low","Low right"].map((label,index)=>({id:`angle-${index}`,label}));

describe("spatial camera angle sheet",()=>{
  it("keeps one original between eight directional controls without fake thumbnails",()=>{
    const html=renderToStaticMarkup(<CameraAngleSheet items={items} source={{src:"/original.png"}} selected={["angle-0","angle-4"]} onChange={vi.fn()}/>);
    expect(html.match(/src="\/original.png"/g)).toHaveLength(1);
    expect(html).not.toContain("data-preview-direction");
    expect(html.match(/width="250" height="250"/g)).toHaveLength(1);
    expect(html.match(/<button/g)).toHaveLength(8);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html.match(/Not generated/g)).toHaveLength(16);
    expect(html.indexOf('aria-label="Left 45"')).toBeLessThan(html.indexOf('aria-label="Original source"'));
    expect(html.indexOf('aria-label="Original source"')).toBeLessThan(html.indexOf('aria-label="Right 45"'));
  });

  it("shows only real result thumbnails and preserves actual unresolved state",()=>{
    const html=renderToStaticMarkup(<CameraAngleSheet items={items.map((item,index)=>index===2?{...item,src:"/actual-result.png"}:index===5?{...item,status:"submission_unknown"}:item)} selected={[]} disabled onChange={vi.fn()}/>);
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain('src="/actual-result.png"');
    expect(html).not.toContain("data-preview-direction");
    expect(html).toContain("Generated result");
    expect(html).toContain("submission_unknown");
    expect(html.match(/disabled=""/g)).toHaveLength(8);
    expect(html).toContain("Choose a source image");
  });

  it("replaces only the completed proxy with its generated result",()=>{
    const html=renderToStaticMarkup(<CameraAngleSheet source={{src:"/original.png"}} items={items.map((item,index)=>index===2?{...item,src:"/actual-result.png"}:item)} selected={[]} onChange={vi.fn()}/>);
    expect(html).not.toContain("data-preview-direction");
    expect(html.match(/src="\/original.png"/g)).toHaveLength(1);
    expect(html.match(/src="\/actual-result.png"/g)).toHaveLength(1);
    expect(html).toContain('data-result="true"');
    expect(html).toContain("Generated result");
  });
});
