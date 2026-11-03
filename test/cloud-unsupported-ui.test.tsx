import {describe,expect,it,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {CloudRenderStudio} from "../src/team/CloudRenderStudio";

describe("cloud target availability",()=>{
  it("explains an unreviewed BYOK route instead of drawing an empty or paid action",()=>{
    const html=renderToStaticMarkup(<CloudRenderStudio feature="unsupported" workspace={{id:"workspace",name:"Workspace",role:"creator"}} project={{id:"project",name:"Project"} as any} user={{id:"user",email:"local@example.invalid",localSingleUser:true} as any} call={vi.fn() as any} version={0} canEdit onQueued={()=>{}} onSettings={()=>{}} onLocal={()=>{}}/>);
    expect(html).toContain("No compatible BYOK cloud model");
    expect(html).toContain("no reviewed Comfy Router contract");
    expect(html).toContain("Choosing a target never starts a render");
    expect(html).not.toContain("Generate in cloud");
  });
});
