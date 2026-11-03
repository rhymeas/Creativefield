import {readFileSync} from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe,it,expect } from "vitest";
import { CapabilityCatalogue,filterCatalogue,requirementKindLabel,statusReasons } from "../src/ui/CapabilityCatalogue";
import { CatalogueSections,catalogueView,missingText } from "../src/ui/CatalogueSections";
import { ComfyLibraryPanel } from "../src/team/ComfyLibrary";
import { plannedCapabilities,buildCatalogue,visibleCapabilities } from "../src/capabilities/catalogue";
import { loadServerCatalogue } from "../server/catalogue";
import { providers,enhancers } from "../src/pipelines/registry";
import { Corkboard,ResultGrid,ThumbGrid,TileGrid,densityColumns } from "../src/ds/components";
describe("capability catalogue",()=>{
  const all=buildCatalogue([...providers,...enhancers]).map(b=>b.manifest);
  const shown=visibleCapabilities(all);
  it("shows only workflows that exist, never planned placeholders",()=>{
    expect(plannedCapabilities).toHaveLength(20);
    expect(visibleCapabilities(plannedCapabilities)).toHaveLength(0);
    expect(shown).toHaveLength(all.length-plannedCapabilities.length);
    expect(filterCatalogue(shown,"","all")).toHaveLength(shown.length);
    expect(filterCatalogue(shown,"","supported")).toHaveLength(6);
    expect(filterCatalogue(shown,"","supported").every(m=>m.coverage.local==="implemented")).toBe(true);
    expect(filterCatalogue(shown,"object replacement","all")).toHaveLength(0);
    expect(shown.find(manifest=>manifest.category==="motion")?.coverage.local).toBe("implemented");
  });
  it("offers setup requirements without incorrectly saying a connected worker is offline",()=>{
    const manifest=shown[0];
    const html=renderToStaticMarkup(<CapabilityCatalogue manifests={[manifest]} statuses={{[manifest.id]:{state:"download_required",missing:[]}}} checking={false} onChoose={()=>{}} onRecheck={()=>{}} onLibrary={()=>{}}/>);
    expect(html).toContain("Setup required");expect(html).toContain("available model downloads");expect(html).not.toContain("Start or connect a compatible ComfyUI worker");
  });
  it("names each roadmap entry the one way the app names it",()=>{
    const titles=plannedCapabilities.map(m=>m.title);
    expect(new Set(titles).size).toBe(titles.length);
    // One word per place: no second "Studio" name for a screen that the top bar names plainly.
    expect(plannedCapabilities.filter(m=>m.category==="studios").map(m=>m.title)).toEqual(["Characters","Static ads","Ads"]);
    // The shipped card is "Replace character"; the roadmap must not rename it.
    expect(plannedCapabilities.find(m=>m.id==="replace-character")?.description).toContain("Replace character");
  });
  it("lists the workflows the server sends, native packs included",async()=>{
    const server=await loadServerCatalogue();
    const manifests=visibleCapabilities(server.map(bundle=>bundle.manifest));
    expect(manifests.map(m=>m.id)).toEqual(expect.arrayContaining(["flux2-klein-t2i","sam31-video-mask","chatterbox-tts"]));
    expect(manifests.some(m=>m.coverage.local==="planned")).toBe(false);
    const html=renderToStaticMarkup(<CapabilityCatalogue manifests={manifests} statuses={{}} checking={false} onChoose={()=>{}} onRecheck={()=>{}} onLibrary={()=>{}}/>);
    expect(html).toContain("Klein");
    expect(html).toContain("SAM 3.1");
  });
  it("shows a two-column gallery with the workflow filters and no execution controls",()=>{
    const html=renderToStaticMarkup(<CapabilityCatalogue manifests={shown} statuses={{}} checking={false} onChoose={()=>{}} onRecheck={()=>{}} onLibrary={()=>{}}/>);
    expect(html).toContain(">Models<");
    expect(html).not.toContain(">Catalogue<");
    // Models is a main studio page; the narrow form frame caused the header to drift inward.
    expect(html).not.toContain("ds-page--narrow");
    expect(html).toContain('aria-label="Items per row"');
    expect(html).not.toContain(">Per row<");
    expect(html).toContain("Search workflows");
    expect(html).toContain("Supported");
    // Rule 26: no planned filter and no hosted-provider switch, because neither can show a workflow.
    expect(html).not.toContain("Planned");
    expect(html).not.toContain("Independent API");
    expect(html).not.toContain("Camera and Cinema");
    expect(html).not.toContain(`data-columns=`);
    expect(html).toContain(`data-roomy="true"`);
    expect(html).not.toContain("Open workflow");
    expect(html).not.toContain("Generate");
  });
  it("embeds the same catalogue inside a modal without duplicating the dialog title",()=>{
    const html=renderToStaticMarkup(<CapabilityCatalogue embedded manifests={shown} statuses={{}} checking={false} onChoose={()=>{}} onRecheck={()=>{}} onLibrary={()=>{}}/>);
    expect(html).toContain('class="ds-catalogue ds-catalogue--modal"');
    expect(html).not.toContain('class="ds-sectionhead__title">Models</h1>');
    expect(html).toContain("Search workflows");
    expect(html).toContain('aria-label="Items per row"');
    expect(html.indexOf('class="ds-search"')).toBeLessThan(html.indexOf('aria-label="Items per row"'));
  });
  it("uses the shared density and caps columns at the visible item count",()=>{
    const tiles=renderToStaticMarkup(<TileGrid label="Two visible tiles"><i/><i/></TileGrid>);
    const results=renderToStaticMarkup(<ResultGrid count={3} aspect={1} label="Three results"><i/><i/><i/></ResultGrid>);
    expect(tiles).toContain('style="--cols:2"');
    expect(results).toContain('style="--cols:3;--tile-aspect:1"');
    expect(renderToStaticMarkup(<Corkboard><li/><li/></Corkboard>)).toContain('style="--cols:2"');
    expect(renderToStaticMarkup(<ThumbGrid label="Three images"><i/><i/><i/></ThumbGrid>)).toContain('style="--cols:3"');
    expect(renderToStaticMarkup(<ThumbGrid label="Visible only">{false}{null}<><i/><i/></></ThumbGrid>)).toContain('style="--cols:2"');
    expect(renderToStaticMarkup(<Corkboard>{false}<><li/><li/></></Corkboard>)).toContain('style="--cols:2"');
    expect(densityColumns(6,2)).toBe(2);
    expect(densityColumns(2,6)).toBe(2);
  });
  it("says what an unready workflow still needs",()=>{
    const manifest=shown.find(m=>m.coverage.local==="implemented")!;
    const node={id:"node:FL_ChatterboxTTS",kind:"node" as const,name:"FL_ChatterboxTTS",instructions:"Install the ComfyUI_Fill-ChatterBox node pack."};
    const status={state:"install_required",reasons:["Install the ComfyUI_Fill-ChatterBox node pack."],missing:[node]};
    expect(missingText(status)).toBe("Needs node FL_ChatterboxTTS");
    expect(missingText(undefined)).toBeUndefined();
    expect(missingText({state:"ready",missing:[]})).toBeUndefined();
    expect(missingText({...status,missing:[node,{...node,id:"node:SaveAudio",name:"SaveAudio"}]})).toBe("Needs node FL_ChatterboxTTS and 1 more");
    const html=renderToStaticMarkup(<CatalogueSections items={[manifest]} statuses={{[manifest.id]:status}} checking={false} onChoose={()=>{}} onLibrary={()=>{}}/>);
    expect(html).toContain("Needs node FL_ChatterboxTTS");
    expect(html).toContain("Installation required");
  });
  it("puts a workflow in Setup until it is ready and never while checking",()=>{
    const base=all.find(m=>m.coverage.local==="implemented")!;
    expect(catalogueView(base,{state:"ready"},false)).toBe("ready");
    expect(catalogueView(base,{state:"ready"},true)).toBe("setup");
    expect(catalogueView(base,{state:"install_required"},false)).toBe("setup");
    expect(requirementKindLabel("software")).toBe("Software");expect(requirementKindLabel("credential")).toBe("Credential");
  });
  it("owns one header and search while the installed library is selected",()=>{
    const html=renderToStaticMarkup(<CapabilityCatalogue statuses={{}} checking={false} onChoose={()=>{}} onRecheck={()=>{}} onLibrary={()=>{}} library={controls=><ComfyLibraryPanel workspace={{id:"qa",name:"QA",role:"creator"}} workers={[]} call={async<T,>()=>[] as T} controls={controls}/>}/>);
    expect((html.match(/<h1\b/g)??[]).length).toBe(1);
    expect((html.match(/class="ds-search"/g)??[]).length).toBe(1);
    expect(html).toContain('aria-label="Models view"');
    expect(html).toContain('aria-label="Search installed models"');
    expect(html).not.toContain('title="ComfyUI library"');
    expect(html).not.toContain('>ComfyUI library<');
    expect(html).not.toContain('Search workflows');
    expect(html).not.toContain('Independent API');
    expect(html).not.toContain('Implementation status');
  });
  it("centers compact worker cards and exposes every worker directly",()=>{
    const workers=Array.from({length:5},(_,index)=>({id:`worker-${index}`,name:`Worker ${index+1}`,origin:`http://worker-${index+1}:8188`,enabled:true,checked_at:null,inventory:index===0?{online:true,nodes:[],models:[],credentials:[]}:null}));
    const html=renderToStaticMarkup(<ComfyLibraryPanel workspace={{id:"qa",name:"QA",role:"creator"}} workers={workers} call={async<T,>()=>({} as T)}/>);
    expect(html).toContain('role="radiogroup"');
    // Each worker is one DS selectable card, not a hand-made button.
    expect((html.match(/class="ds-option"/g)??[])).toHaveLength(5);
    expect((html.match(/class="cf-library__worker"/g)??[])).toHaveLength(0);
    expect((html.match(/aria-checked="true"/g)??[])).toHaveLength(1);
    expect(html).toContain("Worker 5");
    const css=readFileSync("src/team/comfy-library.css","utf8");
    expect(css).toContain("flex-wrap: wrap");
    expect(css).toContain("flex: 1 1 400px");
    expect(css).toContain("max-width: 400px");
  });
  it("groups loopback installations under one computer while retaining their selector",()=>{
    const workers=[
      {id:"a",name:"Local ComfyUI",origin:"http://127.0.0.1:8188",enabled:true,checked_at:"2026-01-01",inventory:{online:false,nodes:[],models:[],credentials:[]}},
      {id:"b",name:"H3",origin:"http://localhost:8288",enabled:true,checked_at:"2026-01-01",inventory:{online:true,nodes:[],models:[],credentials:[]}},
      {id:"c",name:"Remote",origin:"http://worker.example:8188",enabled:true,checked_at:null,inventory:null},
    ];
    const html=renderToStaticMarkup(<ComfyLibraryPanel workspace={{id:"qa",name:"QA",role:"creator"}} workers={workers} call={async<T,>()=>({} as T)}/>);
    expect((html.match(/class="ds-option"/g)??[])).toHaveLength(2);
    expect(html).toContain("This computer");
    expect(html).toContain("Installation");
    expect(html).toContain("Remote");
    expect(html).toContain("http://localhost:8288");
  });
  it("puts the worker choice and the offline reason in one centred stage",()=>{
    const workers=[{id:"local",name:"Local ComfyUI",origin:"http://127.0.0.1:8188",enabled:true,checked_at:"2026-10-28T00:00:00Z",inventory:{online:false,nodes:[],models:[],credentials:[]},can_start:true}];
    const html=renderToStaticMarkup(<ComfyLibraryPanel workspace={{id:"qa",name:"QA",role:"creator"}} workers={workers} call={async<T,>()=>({} as T)}/>);
    expect(html).toContain('class="cf-library__stage"');
    expect(html).toContain("Reading the ComfyUI library");
    const css=readFileSync("src/team/comfy-library.css","utf8");
    expect(css).toContain(".cf-library__stage");
  });
  it("preserves specific offline reasons and falls back only for legacy status",()=>{
    expect(statusReasons({state:"offline",reasons:["No local ComfyUI worker is registered."],missing:[]})).toEqual(["No local ComfyUI worker is registered."]);
    expect(statusReasons({state:"offline",reasons:["The team server cannot confirm worker readiness."],missing:[]})).toEqual(["The team server cannot confirm worker readiness."]);
    expect(statusReasons({state:"offline",missingNodes:[],missingFiles:[],invalidValues:[]})).toEqual(["Start or connect the selected ComfyUI worker, then recheck requirements."]);
  });
});
