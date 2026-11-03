import {describe,it,expect,vi,afterEach} from "vitest";
import Fastify from "fastify";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import type {Pool} from "pg";
import {serveTeamUi} from "../server/ui";
import {probeWorker,WorkerMonitor} from "../server/workers";
import type {CapabilityBundle} from "../src/capabilities/types";
describe("team serving boundaries",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("serves only the trusted build and injects explicit team mode",async()=>{
    const root=await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/static-test-");const app=Fastify();
    try{
      await mkdir(`${root}/assets`);await writeFile(`${root}/index.html`,'<html><head></head><body><script src="/assets/app.js"></script></body></html>');await writeFile(`${root}/assets/app.js`,"/* fixture */");await writeFile(`${root}/private.json`,"private");
      await serveTeamUi(app,root);await app.ready();
      const page=await app.inject("/");expect(page.statusCode).toBe(200);expect(page.body).toContain('name="comfyfield-mode" content="team"');expect(page.headers["content-security-policy"]).toContain("connect-src 'self'");
      expect((await app.inject("/assets/app.js")).statusCode).toBe(200);
      for(const url of ["/private.json","/comfy/object_info","/api/v1/not-a-route","/assets/../private.json"]){expect((await app.inject(url)).statusCode).toBe(404);}
    }finally{await app.close();await rm(root,{recursive:true,force:true});}
  });
  it("deduplicates concurrent worker refreshes and records offline failures",async()=>{
    const worker={id:"w",workspace_id:"ws",origin:"http://127.0.0.1:8188",api_prefix:"/api"};
    const query=vi.fn().mockResolvedValueOnce({rows:[worker]}).mockResolvedValue({rows:[]});
    vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error("offline")));
    const monitor=new WorkerMonitor({query} as unknown as Pool,[]);const first=monitor.tick();expect(monitor.tick()).toBe(first);await first;await monitor.close();await monitor.tick();
    expect(query).toHaveBeenCalledTimes(2);expect(JSON.parse(query.mock.calls[1][1][0]).online).toBe(false);expect(query.mock.calls[0][0]).toContain("enabled=true");
  });
  it("keeps a reachable worker online when one model folder cannot be inventoried",async()=>{
    const worker={id:"w",workspace_id:"ws",origin:"http://127.0.0.1:8188",api_prefix:"/api"};
    const query=vi.fn().mockResolvedValue({rows:[]});
    const bundle={manifest:{routes:[{requirements:[{kind:"model",location:"vae"},{kind:"model",location:"diffusion_models"}]}]}} as unknown as CapabilityBundle;
    const fetchMock=vi.fn(async(input:string)=>{
      if(input.endsWith("/object_info"))return Response.json({LoadImage:{}});
      if(input.endsWith("/system_stats"))return Response.json({system:{ram_total:16*2**30,ram_free:8*2**30},devices:[]});
      if(input.endsWith("/models/vae"))return Response.json(["wan_2.1_vae.safetensors"]);
      return new Response("unavailable",{status:503});
    });
    vi.stubGlobal("fetch",fetchMock);
    const inventory=await probeWorker({query} as unknown as Pool,[bundle],worker);
    expect(inventory.online).toBe(true);expect(inventory.objectInfoChecked).toBe(true);
    expect(inventory.checkedModelFolders).toEqual(["vae"]);
    expect(inventory.models).toEqual(["vae/wan_2.1_vae.safetensors"]);
    expect(inventory.hardware?.ramTotal).toBe(16*2**30);
    expect(inventory.inventoryIssues).toEqual([{scope:"models",folder:"diffusion_models",code:"request_failed"}]);
    expect(JSON.stringify(inventory)).not.toContain(worker.origin);
  });
  it("fails closed on malformed object info without storing raw response data",async()=>{
    const worker={id:"w",workspace_id:"ws",origin:"http://127.0.0.1:8188",api_prefix:"/api"},query=vi.fn().mockResolvedValue({rows:[]});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify([]),{status:200})));
    const inventory=await probeWorker({query} as unknown as Pool,[],worker);
    expect(inventory).toMatchObject({online:false,objectInfoChecked:false,nodes:[],models:[],checkedModelFolders:[],inventoryIssues:[{scope:"object_info",code:"invalid_response"}]});
  });
});
