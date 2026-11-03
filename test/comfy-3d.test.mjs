import { afterEach, describe, it, expect, vi } from "vitest";
import { parseTool, tools, openTool, workflowReady, viewerFilename,viewerWorkspace,findViewer } from "../server/comfy-3d.mjs";
afterEach(() => vi.unstubAllGlobals());

describe("isolated 3D entry points", () => {
  it("accepts only explicit supported tools", () => {
    for (const mode of Object.keys(tools)) expect(parseTool(`?v=0&studio3d=${mode}`)).toBe(mode);
    for (const search of ["", "?studio3d=constructor", "?studio3d=__proto__", "?studio3d=run", "?studio3d=https://example.com"])
      expect(parseTool(search)).toBe(null);
  });
  it("routes to native template filters rather than executing generation", () => {
    expect(tools.image.tasks).toEqual(["Image to 3D", "Image to Model"]);
    expect(tools.text.tasks).toEqual(["Text to Model"]);
    expect(tools.texture.search).toBe("texture");
    expect(tools.mesh.search).toBe("mesh");
    expect(openTool.toString()).not.toMatch(/queuePrompt|fetch\(|graph\.clear/);
  });
  it("ignores unknown actions even outside the browser", async () => {
    await expect(openTool("run")).resolves.toBeUndefined();
  });
  it("waits for workflow restoration and refuses to add a viewer to another graph", () => {
    expect(workflowReady({})).toBe(false);
    const store = { activeWorkflow: { isLoading: false }, isBusy: false, isSyncLoading: false };
    const app = { extensionManager: { workflow: store } };
    expect(workflowReady(app)).toBe(true);
    for (const key of ["isBusy", "isSyncLoading"]) {
      store[key] = true;expect(workflowReady(app)).toBe(false);store[key] = false;
    }
    store.activeWorkflow.isLoading = true;expect(workflowReady(app)).toBe(false);
  });
  it("never adds the viewer node when loading leaves another workflow active", async () => {
    vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("location",{pathname:"/comfy/51cdde46-e5f3-467d-a6fc-2e468846d39f/"});
    vi.stubGlobal("document", { documentElement: {}, querySelector: selector => selector.includes("global-load3d-viewer")?null:({}) });
    const add = vi.fn();
    const app = {
      vueAppReady: true, graph: { id: "original", add }, canvas: {},
      extensionManager: {
        command: { commands: { blank: { id: "Comfy.NewBlankWorkflow" } } },
        workflow: { activeWorkflow: { path: "original" }, isBusy: false, isSyncLoading: false,
          createNewTemporary: vi.fn(async () => ({ path: "viewer" })) },
      },
      loadGraphData: vi.fn(async () => {}),
    };
    vi.stubGlobal("window", { comfyAPI: { app: { app } }, LiteGraph: { registered_node_types: { Load3D: true } } });
    await expect(openTool("viewer")).rejects.toThrow(/did not become active/);
    expect(add).not.toHaveBeenCalled();
    expect(app.graph.id).toBe("original");
  });
  it("does not reuse an existing open viewer workflow name", () => {
    expect(viewerFilename()).toBe("3D viewer.json");
    const open = [{ path: "workflows/3D viewer.json" }, { path: "workflows/3D viewer 2.json" }];
    expect(viewerFilename(open)).toBe("3D viewer 3.json");
    expect(open).toHaveLength(2);
  });
  it("only recognizes marked viewers in this workspace, never a matching filename",()=>{
    const id="51cdde46-e5f3-467d-a6fc-2e468846d39f";
    expect(viewerWorkspace(`/comfy/${id}/?a=1`)).toBe(id);
    expect(viewerWorkspace("/viewer/")).toBe(null);
    expect(viewerWorkspace("/comfy/------------------------------------/")).toBe(null);
    const own={path:"renamed.json",activeState:{extra:{comfyfield:{viewerVersion:1,workspaceId:id}},nodes:[{type:"Load3D"}]}};
    const unmarked={path:"3D viewer.json",activeState:{nodes:[{type:"Load3D"}]}};
    const store={activeWorkflow:unmarked,openWorkflows:[own,unmarked]};
    expect(findViewer(store,id)).toBe(own);
    expect(findViewer(store,"other")).toBe(null);
    expect(findViewer(store,null)).toBe(null);
    own.activeState.nodes=[];expect(findViewer(store,id)).toBe(null);
  });
  it("creates once, coalesces concurrent entry, and restores the edited viewer without replacing graphs",async()=>{
    vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("location",{pathname:"/comfy/51cdde46-e5f3-467d-a6fc-2e468846d39f/"});
    let preview=null;const click=vi.fn(()=>{preview={dataset:{},focus:vi.fn(),transientSetting:"keep"};});vi.stubGlobal("document",{documentElement:{},querySelector:selector=>selector.includes("global-load3d-viewer")?preview:({click})});
    const original={path:"workflows/original.json",activeState:{id:"original",nodes:[{type:"Note",title:"User work"}],extra:{}}};
    const originalJson=JSON.stringify(original);
    const store={activeWorkflow:original,openWorkflows:[original],isBusy:false,isSyncLoading:false,
      createNewTemporary:vi.fn(async(path,graph)=>{const workflow={path,activeState:structuredClone(graph),changeTracker:{captureCanvasState:vi.fn(()=>{workflow.activeState={...workflow.activeState,id:app.graph.id,nodes:structuredClone(app.graph._nodes)};})}};store.openWorkflows.push(workflow);return workflow;}),
      openWorkflow:vi.fn(async(workflow)=>{store.activeWorkflow=workflow;app.graph.id=workflow.activeState.id;app.graph._nodes=workflow.activeState.nodes;})};
    const add=vi.fn(node=>app.graph._nodes.push(node));
    const app={vueAppReady:true,graph:{id:"original",_nodes:[],add},canvas:{centerOnNode:vi.fn()},extensionManager:{workflow:store,command:{commands:{blank:{id:"Comfy.NewBlankWorkflow"}}}},
      loadGraphData:vi.fn(async(graph,_a,_b,workflow)=>{store.activeWorkflow=workflow;app.graph.id=graph.id;app.graph._nodes=structuredClone(graph.nodes);})};
    const create=vi.fn(()=>({id:1,type:"Load3D",widgets_values:["model.obj"]}));
    vi.stubGlobal("window",{comfyAPI:{app:{app}},LiteGraph:{registered_node_types:{Load3D:true},createNode:create}});
    await Promise.all([openTool("viewer"),openTool("viewer")]);
    expect(store.createNewTemporary).toHaveBeenCalledTimes(1);expect(add).toHaveBeenCalledTimes(1);
    const viewer=store.activeWorkflow;app.graph._nodes[0].widgets_values=["edited-model.obj"];
    // The installed frontend's cached state lags visible widget edits until captured.
    preview=null;
    await openTool("viewer");
    preview=null;store.activeWorkflow=original;app.graph.id="original";app.graph._nodes=original.activeState.nodes;
    await openTool("viewer");await openTool("viewer");
    expect(store.openWorkflow).not.toHaveBeenCalled();expect(store.openWorkflows).toHaveLength(2);
    expect(viewer.activeState.nodes[0].widgets_values).toEqual(["edited-model.obj"]);
    expect(app.loadGraphData).toHaveBeenCalledTimes(2);expect(add).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(original)).toBe(originalJson);expect(click).toHaveBeenCalledTimes(3);
    expect(preview.transientSetting).toBe("keep");expect(preview.focus).toHaveBeenCalledTimes(1);
  });
  it("refuses an inconsistent active tab before capturing or creating anything",async()=>{
    vi.stubGlobal("MutationObserver",class{observe(){}disconnect(){}});
    vi.stubGlobal("document",{documentElement:{},querySelector:()=>({})});
    vi.stubGlobal("location",{pathname:"/comfy/51cdde46-e5f3-467d-a6fc-2e468846d39f/"});
    const capture=vi.fn(),create=vi.fn();
    const app={vueAppReady:true,graph:{id:"visible-graph"},canvas:{},extensionManager:{command:{commands:{blank:{id:"Comfy.NewBlankWorkflow"}}},workflow:{activeWorkflow:{path:"other.json",activeState:{id:"different-graph"},changeTracker:{captureCanvasState:capture}},createNewTemporary:create}}};
    vi.stubGlobal("window",{comfyAPI:{app:{app}},LiteGraph:{registered_node_types:{Load3D:true}}});
    await expect(openTool("viewer")).rejects.toThrow(/still changing/);
    expect(capture).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();
    expect(app.graph.id).toBe("visible-graph");
  });
  it("preserves an unbound or different-node modal instead of switching its graph or discarding settings",async()=>{
    vi.stubGlobal("MutationObserver",class{observe(){}disconnect(){}});
    const preview={dataset:{comfyfieldViewerGraph:"other-graph",comfyfieldViewerNode:"1"},focus:vi.fn(),unsavedGrid:false};
    vi.stubGlobal("document",{documentElement:{},querySelector:selector=>selector.includes("global-load3d-viewer")?preview:({})});
    vi.stubGlobal("location",{pathname:"/comfy/51cdde46-e5f3-467d-a6fc-2e468846d39f/"});
    const capture=vi.fn(),create=vi.fn(),loadGraphData=vi.fn();
    const app={vueAppReady:true,graph:{id:"visible-graph",_nodes:[{id:1,type:"Load3D"}]},canvas:{},loadGraphData,extensionManager:{command:{commands:{blank:{id:"Comfy.NewBlankWorkflow"}}},workflow:{activeWorkflow:{path:"current.json",activeState:{id:"visible-graph"},changeTracker:{captureCanvasState:capture}},createNewTemporary:create}}};
    vi.stubGlobal("window",{comfyAPI:{app:{app}},LiteGraph:{registered_node_types:{Load3D:true}}});
    await expect(openTool("viewer")).rejects.toMatchObject({code:"viewer_preview_open"});
    expect(capture).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();expect(loadGraphData).not.toHaveBeenCalled();
    expect(preview.unsavedGrid).toBe(false);
  });
  it.each([false,true])("waits for the restored inline model before opening its modal (switch away: %s)",async(switchAway)=>{
    const observers=new Set(),frames=[];
    vi.stubGlobal("MutationObserver",class{
      constructor(callback){this.callback=callback;}
      observe(){observers.add(this);}
      disconnect(){observers.delete(this);}
    });
    vi.stubGlobal("requestAnimationFrame",callback=>frames.push(callback));
    vi.stubGlobal("location",{pathname:"/comfy/51cdde46-e5f3-467d-a6fc-2e468846d39f/"});
    const changed=()=>[...observers].forEach(observer=>observer.callback());
    const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
    let preview=null,loading=true;
    const click=vi.fn(()=>{preview={dataset:{}};});
    vi.stubGlobal("document",{documentElement:{},querySelector:selector=>{
      if(selector.includes("global-load3d-viewer"))return preview;
      if(selector.includes("loading-overlay"))return loading?{}:null;
      return {click};
    }});
    const model={name:"model_file",value:"3d/restored.obj"};
    const node={id:1,type:"Load3D",widgets:[model]};
    const workflow={path:"viewer.json",activeState:{id:"viewer",extra:{comfyfield:{viewerVersion:1,workspaceId:"51cdde46-e5f3-467d-a6fc-2e468846d39f"}},nodes:[node]}};
    const app={vueAppReady:true,graph:{id:"viewer",_nodes:[node]},canvas:{centerOnNode:vi.fn()},extensionManager:{
      workflow:{activeWorkflow:workflow,openWorkflows:[workflow]},command:{commands:{blank:{id:"Comfy.NewBlankWorkflow"}}}
    }};
    vi.stubGlobal("window",{comfyAPI:{app:{app}},LiteGraph:{registered_node_types:{Load3D:true}}});
    const pending=openTool("viewer");await flush();
    expect(click).not.toHaveBeenCalled();expect(frames).toHaveLength(0);
    Object.defineProperty(model,"value",{get:()=>"3d/restored.obj",set:()=>{},configurable:true});
    changed();await flush();
    frames.shift()();frames.shift()();await flush();
    expect(click).not.toHaveBeenCalled();
    if(switchAway)app.graph._nodes=[];
    loading=false;changed();
    if(switchAway){await expect(pending).rejects.toThrow(/changed while its model was loading/);expect(click).not.toHaveBeenCalled();}
    else{await pending;expect(click).toHaveBeenCalledTimes(1);expect(preview.dataset.comfyfieldViewerGraph).toBe("viewer");}
    expect(observers.size).toBe(0);
  });
});
