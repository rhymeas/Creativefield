import {readFileSync} from "node:fs";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach,describe,expect,it,vi} from "vitest";
import {ComfyNodes,nodeStarters} from "../src/team/nodes/ComfyNodes";

const workspace={id:"workspace",name:"Studio",role:"admin" as const};
const offlineWorker={id:"worker",name:"Local ComfyUI",enabled:true,origin:"http://127.0.0.1:8188",checked_at:null,inventory:{online:false}} as never;
/** The one centred area empty state (rule 34, 36) and the actions it carries. */
const stageOf=(html:string)=>{
  const at=html.indexOf('class="ds-empty ds-empty--stage"');
  expect(at).toBeGreaterThan(-1);
  const stage=html.slice(at);
  return {stage,actions:(stage.match(/<button/g)??[]).length};
};
afterEach(()=>vi.unstubAllGlobals());
describe("node editor availability",()=>{
  it("offers searchable ready model starters with existing feature links",()=>{
    vi.stubGlobal("location",{hash:"#nodes"});
    const starter={id:"fibo2-edit",title:"Fibo image edit",description:"Change an image",coverage:{local:"implemented"}};
    const unavailable={id:"h3-t2v",title:"H3 video",description:"Video",coverage:{local:"planned"}};
    const other={id:"wan-t2v",title:"Other video",description:"Video",coverage:{local:"implemented"}};
    const catalogue=[starter,unavailable,other] as never;
    expect(nodeStarters(catalogue,"fibo").map(item=>item.id)).toEqual(["fibo2-edit"]);
    expect(nodeStarters(catalogue,"video")).toEqual([]);
    const onlineWorker={...offlineWorker as object,inventory:{online:true}} as never;
    const html=renderToStaticMarkup(<ComfyNodes workspace={workspace} workers={[onlineWorker]} catalogue={catalogue} onWorkerSettings={()=>{}}/>);
    expect(html).toContain("Start from a workflow");
    expect(html).toContain('href="#nodes/feature/fibo2-edit"');
    expect(html).not.toContain("#nodes/feature/wan-t2v");
  });
  it("opens the editor when an enabled online worker follows an offline worker",()=>{
    vi.stubGlobal("location",{hash:"#nodes"});
    const onlineWorker={id:"online",name:"This computer (H3)",enabled:true,origin:"http://127.0.0.1:8288",checked_at:null,inventory:{online:true}} as never;
    const html=renderToStaticMarkup(<ComfyNodes workspace={workspace} workers={[offlineWorker,onlineWorker]} onWorkerSettings={()=>{}}/>);
    expect(html).not.toContain("ComfyUI is offline");
    expect(html).toContain("Node editor");
  });
  it("explains when the team server is offline and offers the retry",()=>{
    vi.stubGlobal("location",{hash:"#nodes"});
    const html=renderToStaticMarkup(<ComfyNodes workspace={workspace} workers={[]} serverOffline onWorkerSettings={()=>{}}/>);
    expect(html).toContain("CreativeField is offline");
    expect(html).toContain("Reconnect to the team server");
    const {stage,actions}=stageOf(html);
    expect(stage).toContain("Retry connection");
    expect(actions).toBe(1);
  });
  it("offers a real retry when the team server can be refreshed",()=>{
    vi.stubGlobal("location",{hash:"#nodes"});
    const html=renderToStaticMarkup(<ComfyNodes workspace={workspace} workers={[]} serverOffline onChanged={()=>{}} onWorkerSettings={()=>{}}/>);
    expect(html).toContain("Retry connection");
  });
  it("sends a missing worker to the place that registers one",()=>{
    vi.stubGlobal("location",{hash:"#nodes"});
    const html=renderToStaticMarkup(<ComfyNodes workspace={workspace} workers={[]} onWorkerSettings={()=>{}}/>);
    expect(html).toContain("No ComfyUI worker");
    expect(html).toContain("Add a ComfyUI worker to open its node editor here.");
    const {stage,actions}=stageOf(html);
    expect(stage).toContain("Add a worker");
    expect(actions).toBe(1);
  });
  it("starts a local worker that can be started here",()=>{
    vi.stubGlobal("location",{hash:"#nodes"});
    const html=renderToStaticMarkup(<ComfyNodes workspace={workspace} workers={[offlineWorker]} canStartLocal onWorkerSettings={()=>{}}/>);
    expect(html).toContain("ComfyUI is offline");
    const {stage,actions}=stageOf(html);
    expect(stage).toContain("Start ComfyUI");
    expect(stage).not.toContain("reload this page");
    expect(actions).toBe(1);
  });
  it("opens worker settings when the worker exists but cannot be started here",()=>{
    vi.stubGlobal("location",{hash:"#nodes"});
    const html=renderToStaticMarkup(<ComfyNodes workspace={workspace} workers={[offlineWorker]} onWorkerSettings={()=>{}}/>);
    expect(html).toContain("ComfyUI is offline");
    const {stage,actions}=stageOf(html);
    expect(stage).toContain("Open worker settings");
    expect(stage).not.toContain("Start ComfyUI");
    expect(actions).toBe(1);
  });
  it("keeps one centred action in every state this component renders",()=>{
    vi.stubGlobal("location",{hash:"#nodes"});
    const states=[
      <ComfyNodes key="server" workspace={workspace} workers={[]} serverOffline onWorkerSettings={()=>{}}/>,
      <ComfyNodes key="none" workspace={workspace} workers={[]} onWorkerSettings={()=>{}}/>,
      <ComfyNodes key="start" workspace={workspace} workers={[offlineWorker]} canStartLocal onWorkerSettings={()=>{}}/>,
      <ComfyNodes key="settings" workspace={workspace} workers={[offlineWorker]} onWorkerSettings={()=>{}}/>,
    ];
    for(const state of states){
      const html=renderToStaticMarkup(state);
      expect(html).not.toContain("reload this page");
      expect(stageOf(html).actions).toBe(1);
    }
    const source=readFileSync("src/team/nodes/ComfyNodes.tsx","utf8");
    for(const empty of source.matchAll(/<EmptyState[^>]*>/g))expect(empty[0]).toContain("stage");
  });
});
