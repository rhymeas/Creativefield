import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {ThreeDStudio} from "../src/team/three-d/ThreeDStudio";
import {ModelToolsPanel} from "../src/team/three-d/ModelToolsPanel";
import {threeDContinuationHash} from "../src/team/three-d/tools";

const workspace={id:"qa",name:"QA",role:"creator" as const};
const workers=[{id:"worker",name:"Local ComfyUI",enabled:true,origin:"http://127.0.0.1:8188",checked_at:null,inventory:{online:true}}] as any;
beforeEach(()=>{const location={hash:"#3d"};vi.stubGlobal("window",{location});vi.stubGlobal("location",location);});
afterEach(()=>vi.unstubAllGlobals());

describe("3D studio follows the shared workspace frame",()=>{
  it("renders the overview with the shared mode bar, density and model tiles",()=>{
    const html=renderToStaticMarkup(<ThreeDStudio workspace={workspace} workers={[]} canEdit/>);
    expect(html).toContain('aria-label="3D workspace"');
    expect(html).toContain('aria-label="3D tools"');
    expect(html).toContain('class="ds-density"');
    expect(html).toContain("Preview local models, lighting and materials.");
    expect(html).toContain("Choose a local workflow in the native generation panel.");
  });
  it("never promises a 3D model the app cannot make",()=>{
    const html=renderToStaticMarkup(<ThreeDStudio workspace={workspace} workers={[]} canEdit/>);
    expect(html).not.toMatch(/build 3d|make a 3d|create 3d|get a 3d model|spin/i);
  });
  it("keeps 3D tool destinations in the same selected workspace tabs",()=>{
    const location={hash:"#3d/image"};vi.stubGlobal("window",{location});vi.stubGlobal("location",location);
    const html=renderToStaticMarkup(<ThreeDStudio workspace={workspace} workers={workers} canEdit imagePanel={<div>Native image-to-3D composer</div>}/>);
    expect(html).toContain("Native image-to-3D composer");
    expect(html).not.toContain("<iframe");
    expect(html).toContain('role="tab" aria-selected="true" class="ds-wsbar__tab" data-selected="true">Image to 3D');
    expect(html).not.toContain(">All 3D tools</button>");
    expect(html).not.toContain("Saved workflows");
    expect(html.match(/Image to 3D/g)).toHaveLength(1);
  });
  it("uses native workflow panels without opening the graph editor",()=>{
    const location={hash:"#3d/workflows"};vi.stubGlobal("window",{location});vi.stubGlobal("location",location);
    const html=renderToStaticMarkup(<ThreeDStudio workspace={workspace} workers={workers} canEdit imagePanel={<div>Image composer must not appear here</div>}/>);
    expect(html).toContain("TRELLIS.2 image to 3D");
    expect(html).toContain("Hunyuan3D 2.1 image to 3D");
    expect(html).not.toContain("Image composer must not appear here");
    expect(html).not.toContain("Import saved workflow");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain(">All 3D tools</button>");
  });
  it("centers the model viewer in the shared canvas and keeps continuations typed",()=>{
    const location={hash:"#3d/viewer"};vi.stubGlobal("window",{location});vi.stubGlobal("location",location);
    const project={id:"project",name:"Project"} as any,call=vi.fn(async()=>({items:[],nextCursor:null})) as any;
    const html=renderToStaticMarkup(<ModelToolsPanel mode="viewer" workspace={workspace} project={project} call={call} canEdit onChanged={()=>{}}/>);
    expect(html).toContain('class="ds-canvas"');
    expect(html).toContain("Your 3D model appears here");
    expect(threeDContinuationHash("edit","view")).toBe("imageedit/view");
    expect(threeDContinuationHash("image","view")).toBe("3d/image/auto/view");
    expect(threeDContinuationHash("texture","model")).toBe("3d/texture/model");
    expect(threeDContinuationHash("mesh","model")).toBe("3d/mesh/model");
  });
});
