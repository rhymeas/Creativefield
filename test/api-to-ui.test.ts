import {describe,expect,it} from "vitest";
import {apiToUi} from "../src/workflow/api-to-ui";
import {uiToApi} from "../src/workflow/ui-to-api";
import {restoreFeatureIds} from "../server/feature-edit";

// Enough of a worker's object_info to cover widgets, seed control, upload, links, forceInput and flattened ids.
const info={
  LoadImage:{input:{required:{image:[["a.png","b.png"],{image_upload:true}]}},input_order:{required:["image"]},output:["IMAGE","MASK"]},
  KSampler:{input:{required:{model:["MODEL"],seed:["INT",{default:0,control_after_generate:true}],steps:["INT",{default:20}],positive:["CONDITIONING"]}},input_order:{required:["model","seed","steps","positive"]},output:["LATENT"]},
  UNETLoader:{input:{required:{unet_name:[["m.safetensors"]]}},input_order:{required:["unet_name"]},output:["MODEL"]},
  CLIPTextEncode:{input:{required:{text:["STRING",{multiline:true}],clip:["CLIP"]}},input_order:{required:["text","clip"]},output:["CONDITIONING"]},
  CLIPLoader:{input:{required:{clip_name:[["c.safetensors"]]}},input_order:{required:["clip_name"]},output:["CLIP"]},
  Detect:{input:{required:{image:["IMAGE"]},optional:{coords:["STRING",{forceInput:true}]}},input_order:{required:["image"],optional:["coords"]},output:["MASK"]},
  PrimitiveStringMultiline:{input:{required:{value:["STRING",{multiline:true}]}},input_order:{required:["value"]},output:["STRING"]},
  SaveImage:{input:{required:{images:["IMAGE"],filename_prefix:["STRING",{default:"ComfyUI"}]}},input_order:{required:["images","filename_prefix"]},output:[],output_node:true},
} as never;

const graph={
  "9":{class_type:"SaveImage",inputs:{images:["76",0],filename_prefix:"ComfyField/test"}},
  "76":{class_type:"LoadImage",inputs:{image:"a.png"}},
  "75:70":{class_type:"UNETLoader",inputs:{unet_name:"m.safetensors"}},
  "75:71":{class_type:"CLIPLoader",inputs:{clip_name:"c.safetensors"}},
  "75:74":{class_type:"CLIPTextEncode",inputs:{text:"a cup",clip:["75:71",0]}},
  "75:63":{class_type:"KSampler",inputs:{model:["75:70",0],seed:7,steps:4,positive:["75:74",0]}},
  "80":{class_type:"Detect",inputs:{image:["76",0],coords:"[]"}},
} as never;

const canon=(v:any):any=>Array.isArray(v)?v.map(canon):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const strip=(g:any)=>canon(Object.fromEntries(Object.entries(g).map(([k,n]:any)=>[k,{class_type:n.class_type,inputs:n.inputs}])));

describe("opening a feature graph in the editor",()=>{
  it("builds an editor workflow with numeric ids and real links",()=>{
    const ui=apiToUi(graph,info);
    expect(ui.nodes.every(node=>Number.isInteger(node.id))).toBe(true);
    expect(ui.links.length).toBeGreaterThanOrEqual(6);
    const save=ui.nodes.find(node=>node.type==="SaveImage")!;
    expect(save.inputs.find(input=>input.name==="images")!.link).not.toBeNull();
    const sampler=ui.nodes.find(node=>node.type==="KSampler")!;
    expect(sampler.widgets_values).toEqual([7,"fixed",4]);
    expect(ui.nodes.find(node=>node.type==="LoadImage")!.widgets_values).toEqual(["a.png","image"]);
    // A fixed forceInput value travels on its own primitive node.
    expect(ui.nodes.some(node=>node.type==="PrimitiveStringMultiline")).toBe(true);
  });
  it("comes back as the same graph, flattened ids included",()=>{
    const ui=apiToUi(graph,info);
    const back=restoreFeatureIds(uiToApi(ui as never,info) as never,ui.extra.comfyfield.ids);
    expect(strip(back)).toEqual(strip(graph));
  });
  it("refuses a graph whose nodes this worker does not have",()=>{
    expect(()=>apiToUi({"1":{class_type:"Missing",inputs:{}}} as never,info)).toThrow("not installed");
  });
});
