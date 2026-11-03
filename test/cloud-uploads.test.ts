import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from "vitest";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import type {Pool} from "pg";
import type {DiskStore} from "../server/storage";
import {ExecutionService,acceptedUploadPath,workerRequestHeaders} from "../server/execution";

/* No Cloud call: fetch is replaced, so the headers we send and the answers we accept are all this suite sees. */
const cloud="https://cloud.comfy.org",local="http://127.0.0.1:8199",key="fake-cloud-key-for-tests";

describe("authenticated uploads and Cloud's flat storage",()=>{
  let root:string,file:string,service:ExecutionService;
  const sent:Array<{url:string;headers:Headers;filename:string}>=[];
  const run={id:"run-1",workspace_id:"workspace-1"};
  const asset={id:"asset-1",role:"image",content_type:"image/png",storage_key:"stored/asset-1.png"};
  type Uploads=(run:unknown,worker:unknown,assets:unknown[])=>Promise<Record<string,string>>;
  const uploadInputs=(worker:unknown)=>((service as unknown as {uploadInputs:Uploads}).uploadInputs)(run,worker,[asset]);
  function answer(body:((filename:string)=>{name?:string;subfolder?:string})|string,status=200){
    vi.stubGlobal("fetch",async(input:RequestInfo|URL,init?:RequestInit)=>{
      const form=init?.body as FormData,image=form.get("image") as File;
      sent.push({url:String(input),headers:new Headers(init?.headers),filename:image.name});
      return new Response(typeof body==="string"?body:JSON.stringify(body(image.name)),{status});
    });
  }
  beforeAll(async()=>{
    root=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-cloud-uploads-");
    file=`${root}/asset-1.png`;
    await writeFile(file,Buffer.from([0x89,0x50,0x4e,0x47]));
    const store={file:async()=>file} as unknown as DiskStore;
    service=new ExecutionService({} as unknown as Pool,store,[]);
  });
  afterAll(async()=>{await rm(root,{recursive:true,force:true});});
  afterEach(()=>{sent.length=0;vi.unstubAllEnvs();vi.unstubAllGlobals();});
  const cloudWorker={origin:cloud,api_prefix:"/api",kind:"cloud"};
  const localWorker={origin:local,api_prefix:"",kind:"local"};

  it("sends the Cloud key and keeps the name the graph loads",async()=>{
    vi.stubEnv("COMFY_CLOUD_API_KEY",key);
    answer(name=>({name,subfolder:""}));
    expect(await uploadInputs(cloudWorker)).toEqual({image:"comfyfield-run-1-asset-1.png"});
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${cloud}/api/upload/image`);
    expect(sent[0].filename).toBe("comfyfield-run-1-asset-1.png");
    expect(sent[0].headers.get("x-api-key")).toBe(key);
  });

  it("sends no key to a local worker, even when a Cloud key is set",async()=>{
    vi.stubEnv("COMFY_CLOUD_API_KEY",key);
    answer(name=>({name,subfolder:""}));
    expect(await uploadInputs(localWorker)).toEqual({image:"comfyfield-run-1-asset-1.png"});
    expect(sent[0].url).toBe(`${local}/upload/image`);
    expect(sent[0].headers.get("x-api-key")).toBeNull();
    expect(sent[0].headers.get("authorization")).toBeNull();
  });

  it("accepts Cloud's flat storage when the answer names a folder",async()=>{
    vi.stubEnv("COMFY_CLOUD_API_KEY",key);
    answer(name=>({name,subfolder:"field-uploads"}));
    expect(await uploadInputs(cloudWorker)).toEqual({image:"comfyfield-run-1-asset-1.png"});
  });

  it("still rejects a folder a local worker would really use",async()=>{
    answer(name=>({name,subfolder:"field-uploads"}));
    await expect(uploadInputs(localWorker)).rejects.toThrow("Worker returned an unexpected upload path");
    answer(name=>({name,subfolder:""}));
    expect(await uploadInputs(localWorker)).toEqual({image:"comfyfield-run-1-asset-1.png"});
  });

  it("rejects a renamed file on every worker",async()=>{
    vi.stubEnv("COMFY_CLOUD_API_KEY",key);
    answer(()=>({name:"renamed.png",subfolder:""}));
    await expect(uploadInputs(cloudWorker)).rejects.toThrow("Worker returned an unexpected upload path");
    expect(acceptedUploadPath({kind:"cloud"},"sent.png",{name:"sent.png",subfolder:"any"})).toBe(true);
    expect(acceptedUploadPath({kind:"local"},"sent.png",{name:"sent.png",subfolder:"any"})).toBe(false);
  });

  it("keeps the worker's reason when an upload is refused",async()=>{
    vi.stubEnv("COMFY_CLOUD_API_KEY",key);
    answer("insufficient credits",402);
    await expect(uploadInputs(cloudWorker)).rejects.toThrow("Worker upload failed for image (402): insufficient credits");
  });

  it("sends nothing when the Cloud key is unset, so the worker refuses it",async()=>{
    answer(name=>({name,subfolder:""}));
    expect(await uploadInputs(cloudWorker)).toEqual({image:"comfyfield-run-1-asset-1.png"});
    expect(sent[0].headers.get("x-api-key")).toBeNull();
  });

  it("keeps the headers a call already had",()=>{
    vi.stubEnv("COMFY_CLOUD_API_KEY",key);
    const headers=workerRequestHeaders({kind:"cloud"},{"Content-Type":"application/json"}) as Headers;
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-api-key")).toBe(key);
    const plain={"Content-Type":"application/json"};
    expect(workerRequestHeaders({kind:"local"},plain)).toBe(plain);
  });
});
