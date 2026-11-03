import {describe,expect,it} from "vitest";
import {fetchHubWorkflow,hubReadiness,normalizeHubUrl,parseWorkflow} from "../server/hub-source";

const objectInfo={
  UNETLoader:{input:{required:{unet_name:[["wan2.2_fun_camera_high_noise_14B_fp8_scaled.safetensors","sub/other.safetensors"]]}}},
  KSampler:{input:{required:{seed:["INT",{}]}}},
} as never;

describe("ComfyHub source",()=>{
  it("accepts only comfy.org and Comfy-Org GitHub https addresses",()=>{
    expect(normalizeHubUrl("https://comfy.org/workflows/download/abc.json").hostname).toBe("comfy.org");
    expect(normalizeHubUrl("https://github.com/Comfy-Org/workflow_templates/blob/main/templates/x.json").toString()).toBe("https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/x.json");
    for(const bad of ["http://comfy.org/x.json","https://evil.example/x.json","https://raw.githubusercontent.com/someone/repo/main/x.json","https://user:pw@comfy.org/x","https://comfy.org:8443/x","https://127.0.0.1/x","not a url"])expect(()=>normalizeHubUrl(bad)).toThrow();
  });
  it("follows redirects only inside the allowed hosts",async()=>{
    const hop=(location:string)=>new Response(null,{status:302,headers:{location}});
    const ok=new Response(JSON.stringify({nodes:[]}),{status:200});
    const calls:string[]=[];
    const allowed=(async(url:URL)=>{calls.push(url.toString());return calls.length===1?hop("https://raw.githubusercontent.com/Comfy-Org/r/main/x.json"):ok;}) as unknown as typeof fetch;
    await expect(fetchHubWorkflow("https://comfy.org/workflows/download/x.json",allowed)).resolves.toMatchObject({url:"https://raw.githubusercontent.com/Comfy-Org/r/main/x.json"});
    const escaping=(async()=>hop("https://evil.example/x.json")) as unknown as typeof fetch;
    await expect(fetchHubWorkflow("https://comfy.org/workflows/download/x.json",escaping)).rejects.toThrow();
  });
  it("rejects files that are not ComfyUI workflows",()=>{
    expect(()=>parseWorkflow("{")).toThrow();expect(()=>parseWorkflow('{"prompt":{}}')).toThrow();
    expect(parseWorkflow('{"nodes":[]}')).toEqual({nodes:[]});
  });
  it("reports missing node classes and model files without downloading",()=>{
    const ui={nodes:[
      {type:"UNETLoader",widgets_values:["wan2.2_fun_camera_high_noise_14B_fp8_scaled.safetensors","default"]},
      {type:"UNETLoader",widgets_values:["missing_model.safetensors"],properties:{models:[{name:"missing_model.safetensors",url:"https://example/m"}]}},
      {type:"CameraAngle"},{type:"CameraAngle"},{type:"Note"},{type:"KSampler"},
    ]} as never;
    const report=hubReadiness(ui,objectInfo);
    expect(report.missingNodes).toEqual([{class:"CameraAngle",count:2}]);
    expect(report.models).toEqual(expect.arrayContaining([{name:"wan2.2_fun_camera_high_noise_14B_fp8_scaled.safetensors",present:true},expect.objectContaining({name:"missing_model.safetensors",present:false})]));
    expect(report.state).toBe("missing");
    expect(hubReadiness({nodes:[{type:"UNETLoader",widgets_values:["other.safetensors"]}]} as never,objectInfo).state).toBe("ready");
    expect(hubReadiness({nodes:[{type:"UNETLoader",widgets_values:["nope.safetensors"]}]} as never,objectInfo).state).toBe("partial");
  });
});
