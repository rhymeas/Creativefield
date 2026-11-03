import {describe,it,expect,vi,afterEach} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {byteRange} from "../server/range";
import {request,ApiError,composerAssets,mergeAssets,type Worker,type Asset,type Call} from "../src/team/api";
import {bestWorkerReadiness,defaultDraft,draftErrors,draftKey,promptOptional,refreshWorkerInventory,soleReadyWorker,submissionIntent,workerReadiness} from "../src/team/state";
import {buildCatalogue} from "../src/capabilities/catalogue";
import {providers,enhancers} from "../src/pipelines/registry";
import {AuthPanel} from "../src/team/AuthPanel";
import {GenerateButton,PromptField} from "../src/ds";
import {TeamChoice} from "../src/team/TeamChoice";
import {TeamMediaInput} from "../src/team/TeamMediaInput";
import {advancedControls,audioChoice,createVideoCandidate,resolutionLabel,TeamComposer} from "../src/team/TeamComposer";
import {capabilitySurface} from "../src/capabilities/surfaces";
import {loadServerCatalogue} from "../server/catalogue";
vi.mock("../src/team/TeamLibrary",()=>({TeamRuns:()=>null}));
const manifest=buildCatalogue([...providers,...enhancers]).find(b=>b.manifest.category==="t2v")!.manifest;
const renderComposer=(m:typeof manifest)=>renderToStaticMarkup(<TeamComposer manifest={m} catalogue={[m]} onCapability={()=>{}} user={{id:"u",email:"u@example.test"}} workspace={{id:"w",name:"Studio",role:"admin"}} project={{id:"p",name:"Film"}} workers={[]} call={async()=>{throw new Error("SSR must not call the API");}} canQueue authorized onQueued={()=>{}}/>);
describe("team UI contracts",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("requires exactly one fresh qualified worker for automatic selection",()=>{
    const req=manifest.routes[0].requirements;
    const worker:Worker={id:"worker-a",name:"Local",origin:"http://localhost:8188",enabled:true,checked_at:new Date().toISOString(),inventory:{online:true,nodes:req.filter(r=>r.kind==="node").map(r=>r.name),models:req.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),credentials:[]}};
    expect(soleReadyWorker(manifest,[worker])).toBe(worker.id);expect(soleReadyWorker(manifest,[worker,{...worker,id:"b"}])).toBe("");
    expect(workerReadiness(manifest,{...worker,checked_at:new Date(Date.now()-6*60*1000).toISOString()}).state).toBe("offline");
    expect(workerReadiness(manifest,{...worker,inventory:{...worker.inventory!,models:[]}}).state).toBe("download_required");
  });
  it("selects the best worker readiness deterministically without losing reasons",()=>{
    const req=manifest.routes[0].requirements,nodes=req.filter(r=>r.kind==="node").map(r=>r.name),models=req.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),now=Date.now();
    const base:Worker={id:"b",name:"B",origin:"http://localhost:8188",enabled:true,checked_at:new Date(now).toISOString(),inventory:{online:true,nodes,models,credentials:[],objectInfoChecked:true,checkedModelFolders:[...new Set(req.filter(r=>r.kind==="model").map(r=>r.location!))],inventoryIssues:[]}};
    const missing:Worker={...base,id:"a",inventory:{...base.inventory!,models:[]}};
    expect(bestWorkerReadiness(manifest,[missing,base],now).state).toBe("ready");
    const unverified:Worker={...missing,id:"c",inventory:{...missing.inventory!,checkedModelFolders:[],inventoryIssues:[{scope:"models",folder:"diffusion_models",code:"request_failed"}]}};
    const result=bestWorkerReadiness(manifest,[unverified],now);expect(result.state).toBe("incompatible");expect(result.reasons.join(" ")).toContain("could not be inventoried");
    expect(bestWorkerReadiness(manifest,[],now)).toMatchObject({state:"offline",reasons:["No local ComfyUI worker is registered."]});
  });
  it("keeps a recheck pending until the fresh worker list has replaced stale readiness",async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const stale={id:"stale"} as Worker,fresh={id:"fresh"} as Worker,probe=vi.fn().mockResolvedValue({}),list=vi.fn(async()=>{await gate;return [fresh];});
    let settled=false;const pending=refreshWorkerInventory([stale],true,probe,list).then(value=>{settled=true;return value;});
    await vi.waitFor(()=>expect(list).toHaveBeenCalledOnce());expect(settled).toBe(false);release();
    expect((await pending).workers).toEqual([fresh]);expect(probe).toHaveBeenCalledWith(stale);
  });
  it("scopes drafts and preserves retry idempotency",()=>{
    expect(draftKey("u","w","p","c")).not.toBe(draftKey("other","w","p","c"));
    expect(draftKey("u","w","p","c")).not.toBe(draftKey("u","other","p","c"));
    const draft=defaultDraft(manifest);expect(draft.audioPolicy).toBe("mute");
    const first=submissionIntent({draft},"intent-123");expect(submissionIntent({draft},first.idempotencyKey)).toEqual(first);
  });
  it("disables queueing for invalid typed controls and resolution pairs",()=>{
    // Motion transfer asks for this character and this take: its example prompt is
    // deliberately not a default, so a written description is part of a valid draft.
    for(const bundle of buildCatalogue([...providers,...enhancers]).filter(b=>b.template)){
      const draft=defaultDraft(bundle.manifest);
      if(bundle.manifest.category==="motion")draft.controls.prompt="A fictional character standing in a plain studio";
      expect(draftErrors(bundle.manifest,draft)).toEqual([]);
    }
    const draft=defaultDraft(manifest);expect(draftErrors(manifest,draft)).toEqual([]);
    for(const value of ["",NaN,-1,1.5,Number.MAX_SAFE_INTEGER+1])expect(draftErrors(manifest,{...draft,controls:{...draft.controls,seed:value}}).length).toBeGreaterThan(0);
    expect(draftErrors(manifest,{...draft,controls:{...draft.controls,prompt:" "}}).length).toBeGreaterThan(0);
    expect(draftErrors(manifest,{...draft,controls:{...draft.controls,width:704,height:704}})).toContain("Choose a supported frame size.");
  });
  it("switches off the prompt only where a picture or clip already carries the subject",()=>{
    const all=buildCatalogue([...providers,...enhancers]).filter(b=>b.template);
    const hides=all.filter(b=>promptOptional(b.manifest));
    expect(hides.some(b=>b.manifest.id==="wan22-i2v-14b")).toBe(true);
    expect(hides.some(b=>b.manifest.category==="motion")).toBe(false);
    for(const bundle of hides){
      expect(bundle.manifest.inputs.some(port=>port.required)).toBe(true);
      expect(bundle.manifest.controls.some(control=>control.id==="prompt")).toBe(true);
      expect(bundle.manifest.mediaContract).toBeUndefined();
    }
    // Text to video has no picture of its own, so the words stay a required field.
    expect(promptOptional(all.find(b=>b.manifest.id==="wan22-ti2v-5b-t2v")!.manifest)).toBe(false);
    expect(promptOptional(all.find(b=>b.manifest.category==="enhance")!.manifest)).toBe(false);
    // A workflow with its own subject may run with the prompt switched off and nothing typed.
    const imageToVideo=all.find(b=>b.manifest.id==="wan22-i2v-14b")!.manifest,draft=defaultDraft(imageToVideo);
    expect(promptOptional({...imageToVideo,category:"finishing"})).toBe(false); // an effect's words are the instruction
    expect(draftErrors(imageToVideo,{...draft,controls:{...draft.controls,prompt:""}})).toEqual([]);
  });
  it("uses same-origin cookies and never follows a provided host",async()=>{
    const mock=vi.fn().mockResolvedValue({ok:true,json:async()=>({id:"x"})});vi.stubGlobal("fetch",mock);
    expect(await request("/auth/me")).toEqual({id:"x"});expect(mock.mock.calls[0][0]).toBe("/api/v1/auth/me");expect(mock.mock.calls[0][1].credentials).toBe("same-origin");
    await request("/auth/logout","POST");expect(mock.mock.calls[1][1].headers).toBeUndefined();expect(mock.mock.calls[1][1].body).toBeUndefined();
    await expect(request("https://other.test")).rejects.toThrow();await expect(request("//other.test")).rejects.toThrow();
    mock.mockResolvedValue({ok:false,status:401,json:async()=>({error:"Sign in"})});await expect(request("/auth/me")).rejects.toBeInstanceOf(ApiError);
  });
  it("pins a restored selected asset beyond page one and excludes foreign project references",async()=>{
    const recent={id:"recent",project_id:"p",name:"Recent"} as Asset,older={id:"older",project_id:"p",name:"Older selected image"} as Asset;
    const call=vi.fn().mockResolvedValueOnce({items:[recent],nextCursor:"page-two"}).mockResolvedValueOnce(older).mockResolvedValueOnce({...older,id:"foreign",project_id:"other"}).mockRejectedValueOnce(new ApiError(404,"Missing"));
    const page=await composerAssets(call as Call,"w","p",["older","older","foreign","missing"]);
    expect(page.items).toEqual([recent,older]);expect(page.nextCursor).toBe("page-two");expect(call).toHaveBeenCalledTimes(4);expect(call.mock.calls[1][0]).toBe("/workspaces/w/assets/older");
    expect(mergeAssets(page.items,[older])).toEqual(page.items);
  });
  it("shows invite-only sign-in and uses a truthful queue label",()=>{
    const html=renderToStaticMarkup(<AuthPanel onSignedIn={async()=>{}}/>);expect(html).toContain("Accounts are created by a workspace admin");expect(html).not.toContain("Register");expect(html).toContain('type="password"');
    expect(renderToStaticMarkup(<GenerateButton label="Generate"/>)).toContain("Generate");
  });
  it("names the frame size the quality row really makes, width × height",()=>{
    // Motion transfer is 480 × 848; the row says that size, and the menu note keeps seconds and fps.
    expect(resolutionLabel(480,848)).toBe("480 × 848");
    expect(resolutionLabel(848,480)).toBe("848 × 480");
    expect(resolutionLabel(640,640)).toBe("640 × 640");
    expect(resolutionLabel(1000,700)).toBe("1000 × 700");
  });
  it("labels every composer's primary action Generate",async()=>{
    const motion=(await loadServerCatalogue()).find(bundle=>bundle.manifest.id==="wan-animate2-distilled")!.manifest;
    const html=renderComposer(motion);
    expect(html).toContain("ds-generate");
    expect(html).toContain("Generate");
    expect(html).not.toContain("Queue video");
    // The quality row on that same screen says the size, and the clip limit lives in the drop zone.
    expect(html).toContain("480 × 848");
    expect(html).not.toContain("30:53");
    expect(html).toContain("Drop a video, up to 26 s");
    expect(html).not.toContain("as long as your clip");
  });
  it("disables prompt editing when the composer is locked",()=>{
    const html=renderToStaticMarkup(<PromptField disabled label="Prompt" value="frozen" placeholder="Prompt" onChange={()=>{throw new Error("locked prompt changed");}}/>);
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).not.toContain("Open Prompt in a larger editor");
  });
  it("reuses studio picker surfaces without native selects",()=>{
    const props={label:"Workflow",display:"Wan",value:"wan",options:[{value:"wan",label:"Wan"}],onChange:()=>{}};
    expect(renderToStaticMarkup(<TeamChoice {...props}/>)).toContain("ds-row");
    expect(renderToStaticMarkup(<TeamChoice {...props} variant="model"/>)).toContain("ds-modelcard");
    expect(renderToStaticMarkup(<TeamChoice {...props} variant="pill"/>)).toContain("ds-pill");
    expect(renderToStaticMarkup(<TeamChoice {...props}/>)).not.toContain("<select");
    expect(renderToStaticMarkup(<TeamChoice {...props} disabled/>)).toContain("disabled");
    // The tall pill (size="lg") is one centered action label; no quiet prefix in front of it.
    const tall=renderToStaticMarkup(<TeamChoice {...props} variant="pill" size="lg" prefix={false}/>);
    expect(tall).toContain("ds-pill--lg");expect(tall).not.toContain("ds-pill__prefix");
    expect(renderToStaticMarkup(<TeamChoice {...props} variant="pill"/>)).toContain("ds-pill__prefix");
  });
  it("labels the library pill as the action it performs",()=>{
    const media=(selected?:Asset)=>renderToStaticMarkup(<TeamMediaInput label="Image" type="image" file={null} selected={selected} options={[]} disabled={false} canUpload workspace="w" onFile={()=>{}} onSelect={()=>{}} onUpload={()=>{}}/>);
    const empty=media();expect(empty).toContain("ds-pill--lg");expect(empty).toContain("Choose from library");expect(empty).not.toContain("ds-pill__prefix");
    expect(media({id:"a"} as Asset)).toContain("Change");
  });
  it("keeps a one-option audio row and the motion negative prompt honest",async()=>{
    const manifests=(await loadServerCatalogue()).map(bundle=>bundle.manifest),find=(id:string)=>manifests.find(m=>m.id===id)!;
    // Mute is the only policy for motion and camera, so no Audio button; lip sync really chooses a take or Mute.
    expect(audioChoice(find("wan-animate2-distilled"))).toBe(false);
    expect(audioChoice(find("camera"))).toBe(false);
    expect(audioChoice(find("lip-sync"))).toBe(true);
    // Motion's Advanced list holds its pose text and the negative prompt the panel leaves out, and nothing else new.
    const motion=find("wan-animate2-distilled"),advanced=advancedControls(motion,true,false).map(control=>control.id);
    expect(advanced).toContain("motion_prompt");expect(advanced).toContain("negative");
    expect(advanced).not.toContain("prompt");expect(advanced).not.toContain("seed");
    expect(motion.controls.find(control=>control.id==="negative")?.disabledReason).toBeUndefined();
    // Everywhere else the negative prompt was already in Advanced; the camera settings stay out of it.
    const camera=advancedControls(find("camera"),false,true).map(control=>control.id);
    expect(camera).toContain("negative");expect(camera).not.toContain("camera_pose");expect(camera).not.toContain("speed");
  });
  it("leaves lip sync out of the create video picker",async()=>{
    const manifests=(await loadServerCatalogue()).map(bundle=>bundle.manifest).filter(m=>m.coverage.local==="implemented"),find=(id:string)=>manifests.find(m=>m.id===id)!;
    const lipSync=find("lip-sync");
    expect(capabilitySurface(lipSync)).toBe("video-create");
    expect(createVideoCandidate(lipSync)).toBe(false);
    expect(createVideoCandidate(lipSync,lipSync.id)).toBe(false);
    const picker=manifests.filter(m=>createVideoCandidate(m,"wan22-ti2v-5b-t2v")).map(m=>m.id);
    expect(picker).not.toContain("lip-sync");
    expect(picker).toEqual(expect.arrayContaining(["h3-t2v","h3-i2v","h3-flf2v","minimax-h3-video"]));
    expect(picker).not.toContain("wan22-ti2v-5b");
    // Motion keeps its own screen.
    expect(picker).not.toContain("wan-animate2-distilled");
  });
  it("keeps video editing out of Create Video and offers a start image from the library",async()=>{
    const catalogue=(await loadServerCatalogue()).map(bundle=>bundle.manifest);
    const manifest=catalogue.find(item=>item.id==="h3-t2v")!;
    const html=renderToStaticMarkup(<TeamComposer manifest={manifest} catalogue={catalogue} onCapability={()=>{}} user={{id:"u",email:"u@example.test"}} workspace={{id:"w",name:"Studio",role:"admin"}} project={{id:"p",name:"Film"}} workers={[]} call={async()=>{throw new Error("SSR must not call the API");}} canQueue authorized onQueued={()=>{}}/>);
    expect(html).not.toContain("Add a video to edit");
    expect(html).toContain("Add a picture to start from");
    expect(html.match(/Choose from library/g)?.length).toBeGreaterThanOrEqual(1);
  });
  it("parses bounded, open-ended and suffix byte ranges",()=>{
    expect(byteRange(undefined,10)).toBe(null);expect(byteRange("bytes=2-4",10)).toEqual({start:2,end:4});expect(byteRange("bytes=7-",10)).toEqual({start:7,end:9});expect(byteRange("bytes=-3",10)).toEqual({start:7,end:9});
    for(const header of ["bytes=10-20","bytes=5-4","bytes=0-1,4-5","bytes=-0","other=1-2","bytes=-","bytes=9999999999999999999-"])expect(byteRange(header,10)).toBe("invalid");
  });
  /* the screen names the one cause that stops the run and carries the one action that
     clears it; the Generate button does not say the same thing a second time (rule 42). */
  const renderBlocked=(over:{singleUser?:boolean;workers?:Worker[];onHandler?:boolean})=>renderToStaticMarkup(<TeamComposer manifest={manifest} catalogue={[manifest]} onCapability={()=>{}} user={{id:"u",email:"u@example.test",localSingleUser:over.singleUser}} workspace={{id:"w",name:"Studio",role:"admin"}} project={{id:"p",name:"Film"}} workers={over.workers??[]} call={async()=>{throw new Error("SSR must not call the API");}} canQueue authorized onQueued={()=>{}} {...(over.onHandler===false?{}:{onWorkerSettings:()=>{},onModels:()=>{},onRunLocal:()=>{}})}/>);
  it("asks one thing at a time, in this mode's words, with the action that fixes it",()=>{
    const alone=renderBlocked({singleUser:true});
    expect(alone).toContain("CreativeField isn&#x27;t connected to ComfyUI yet. Add its address in Settings and check it.");
    expect(alone).toContain("Connect ComfyUI");
    expect(alone).not.toMatch(/administrator|Choose a ready worker/);
    expect(alone).not.toContain("The selected worker is not ready yet.");
    const shared=renderBlocked({});
    expect(shared).toContain("Add its address in Team settings and check it.");
  });
  it("offers to start a stopped ComfyUI, and says nothing when the worker is ready",()=>{
    const req=manifest.routes[0].requirements;
    const offline:Worker={id:"w1",name:"This computer",origin:"http://127.0.0.1:8188",enabled:true,checked_at:new Date().toISOString(),can_start:true,inventory:{online:false,nodes:[],models:[],credentials:[]}};
    const stopped=renderBlocked({workers:[offline]});
    expect(stopped).toContain("ComfyUI is offline");
    expect(stopped).toContain("Start ComfyUI");
    expect(stopped).not.toContain("Worker requirements");
    const ready:Worker={...offline,can_start:false,inventory:{online:true,nodes:req.filter(item=>item.kind==="node").map(item=>item.name),models:req.filter(item=>item.kind==="model").map(item=>`${item.location}/${item.name}`),credentials:[],objectInfoChecked:true,checkedModelFolders:[...new Set(req.filter(item=>item.kind==="model").map(item=>item.location!))]}};
    const running=renderBlocked({workers:[ready]});
    expect(running).not.toContain("ComfyUI is offline");
    expect(running).not.toContain("Connect ComfyUI");
    expect(running).not.toContain("Not connected to ComfyUI");
  });
});
