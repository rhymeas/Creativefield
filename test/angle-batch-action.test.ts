import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import type {CapabilityManifestV2} from "../src/capabilities/types";
import {defaultImageDraft} from "../src/image/image-state";
import {freezeAngleBatch} from "../src/image/angle-batch";
import {angleBatchActionState} from "../src/image/angle-batch-action";

const manifest:CapabilityManifestV2=JSON.parse(readFileSync("native-workflows/flux2-klein-angles/manifest.json","utf8"));
const scope={userId:"u",workspaceId:"w",projectId:"p",workerId:"worker"};
const draft={...defaultImageDraft(manifest),inputs:{source_image:"source"}};
const base={batch:null,selected:[] as string[],manifest,draft,scope,disabled:false,busy:false,pending:false,uncertain:false};
const batch=()=>freezeAngleBatch(manifest,draft,["high-left","low-right"],scope,"00000000-0000-4000-8000-000000000001");
describe("one primary angle action",()=>{
  it("validates the same selected presets and source as actual admission",()=>{
    expect(angleBatchActionState(base)).toMatchObject({kind:"generate",label:"Generate angles",enabled:false});
    expect(angleBatchActionState({...base,selected:["high-left"]})).toMatchObject({label:"Generate 1 angle",enabled:true});
    expect(angleBatchActionState({...base,selected:["high-left","low-right"]})).toMatchObject({label:"Generate 2 angles",enabled:true});
    expect(angleBatchActionState({...base,selected:["high-left"],draft:{...draft,inputs:{}}}).enabled).toBe(false);
    expect(angleBatchActionState({...base,selected:["unsupported"]}).enabled).toBe(false);
  });
  it("resumes a frozen request independently of later single-image draft edits",()=>{
    const saved=batch();saved.runIds["high-left"]="accepted";saved.pendingPreset="low-right";
    expect(angleBatchActionState({...base,batch:saved,draft:{controls:{},inputs:{}}})).toMatchObject({kind:"resume",label:"Resume saved batch",enabled:true});
    expect(angleBatchActionState({...base,batch:saved,disabled:true}).enabled).toBe(false);
  });
  it("keeps active and unresolved requests before offering a new batch",()=>{
    const saved=batch();saved.runIds={"high-left":"accepted-a","low-right":"accepted-b"};
    expect(angleBatchActionState({...base,batch:saved,pending:true})).toMatchObject({kind:"new",enabled:false,busy:true});
    expect(angleBatchActionState({...base,batch:saved,uncertain:true}).enabled).toBe(false);
    expect(angleBatchActionState({...base,batch:saved})).toMatchObject({label:"New angle batch",enabled:true});
    saved.pendingPreset="low-right";expect(angleBatchActionState({...base,batch:saved}).enabled).toBe(false);
  });
  it("lets a completed batch add only newly selected angles",()=>{
    const saved=batch();saved.runIds={"high-left":"accepted-a","low-right":"accepted-b"};
    expect(angleBatchActionState({...base,batch:saved,selected:["low-right"]})).toMatchObject({kind:"new",label:"New angle batch",enabled:true});
    expect(angleBatchActionState({...base,batch:saved,selected:["low-right","high"]})).toMatchObject({kind:"extend",label:"Generate 1 new angle",enabled:true});
    expect(angleBatchActionState({...base,batch:saved,selected:["high","right-45"]})).toMatchObject({kind:"extend",label:"Generate 2 new angles",enabled:true});
    expect(angleBatchActionState({...base,batch:saved,selected:["high"],pending:true})).toMatchObject({kind:"extend",enabled:false,busy:true});
  });
  it("blocks repeated admission while queuing",()=>{
    expect(angleBatchActionState({...base,selected:["high-left"],busy:true})).toMatchObject({label:"Queuing angles",enabled:false,busy:true});
  });
  it("retains old results and reconciles unknown requests before offering a fresh recipe",()=>{
    const saved={...batch(),capabilityVersion:"0.1.0"};
    saved.runIds={"high-left":"accepted"};saved.pendingPreset="low-right";
    expect(angleBatchActionState({...base,batch:saved})).toMatchObject({kind:"resume",label:"Recover saved request",enabled:true});
    expect(angleBatchActionState({...base,batch:saved,disabled:true}).enabled).toBe(false);
    delete saved.pendingPreset;
    expect(angleBatchActionState({...base,batch:saved,pending:true})).toMatchObject({kind:"new",enabled:false});
    expect(angleBatchActionState({...base,batch:saved,uncertain:true}).enabled).toBe(false);
    expect(angleBatchActionState({...base,batch:saved})).toMatchObject({kind:"new",enabled:true});
  });
});
