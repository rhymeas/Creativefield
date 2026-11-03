import {describe,expect,it} from "vitest";
import {cubeGlb,fixtureMode,fixtureOutputs,graphSize,graphTiming,loadedImage,parseMultipart} from "../server/fixture-worker-lib";
import {parseGlbHeader} from "../server/glb";
import {firstOutputFile} from "../src/comfy/client";

const graph={
  "1":{class_type:"LoadImage",inputs:{image:"cup.png"}},
  "2":{class_type:"EmptyLatentImage",inputs:{width:832,height:481,batch_size:1}},
  "3":{class_type:"SaveImage",inputs:{images:["9",0]}},
  "4":{class_type:"SaveGLB",inputs:{mesh:["8",0]}},
  "5":{class_type:"SaveAudio",inputs:{audio:["7",0]}},
  "6":{class_type:"PreviewImage",inputs:{images:["9",0]}},
};

describe("fixture worker",()=>{
  it("finds the output nodes ComfyField ingests, with ComfyUI's history keys",()=>{
    expect(fixtureOutputs(graph)).toEqual([{node:"3",media:"image",key:"images"},{node:"4",media:"model3d",key:"3d"},{node:"5",media:"audio",key:"audio"}]);
  });
  it("reads the loaded image and an even output size",()=>{
    expect(loadedImage(graph)).toBe("cup.png");
    expect(graphSize(graph)).toEqual({width:832,height:480});
    expect(graphSize({})).toEqual({width:1024,height:1024});
  });
  it("matches the clip length the graph asks for",()=>{
    expect(graphTiming({"1":{class_type:"WanImageToVideo",inputs:{length:81}},"2":{class_type:"CreateVideo",inputs:{fps:16}}})).toEqual({frames:81,fps:16,seconds:81/16});
    expect(graphTiming({})).toEqual({frames:48,fps:24,seconds:2});
    // Wan 2.2 14B: seconds and fps are primitives, frames come from a math node.
    const wan={
      "161":{class_type:"PrimitiveFloat",inputs:{value:4}},"162":{class_type:"PrimitiveFloat",inputs:{value:16}},
      "163":{class_type:"ComfyMathExpression",inputs:{"values.a":["161",0],"values.b":["162",0],expression:"floor (a * b + 1)"}},
      "98":{class_type:"WanImageToVideo",inputs:{length:["163",1]}},"94":{class_type:"CreateVideo",inputs:{fps:["162",0]}},
    };
    expect(graphTiming(wan)).toEqual({frames:65,fps:16,seconds:65/16});
    expect(graphTiming({"1":{class_type:"ComfyMathExpression",inputs:{expression:"process.exit()"}},"2":{class_type:"X",inputs:{length:["1",0]}}}).frames).toBe(48);
  });
  it("takes steering markers from anywhere in the graph",()=>{
    expect(fixtureMode({"1":{class_type:"CLIPTextEncode",inputs:{text:"a cup fixture:fail"}}})).toBe("fail");
    expect(fixtureMode({"1":{class_type:"CLIPTextEncode",inputs:{text:"fixture:slow"}}})).toBe("slow");
    expect(fixtureMode(graph)).toBe("normal");
  });
  it("writes a GLB the app accepts",()=>{
    const glb=cubeGlb();
    expect(parseGlbHeader(new Uint8Array(glb.subarray(0,12)),glb.length).version).toBe(2);
    expect(glb.length%4).toBe(0);
    const json=JSON.parse(glb.subarray(20,20+glb.readUInt32LE(12)).toString("utf8"));
    expect(json.accessors[0].count).toBe(24);
  });
  it("history entries resolve to a file the ingest reads",()=>{
    expect(firstOutputFile({"3d":[{filename:"a.glb",subfolder:"",type:"output"}]})).toEqual({filename:"a.glb",subfolder:"",type:"output"});
  });
  it("parses an upload body the way FormData sends it",async()=>{
    const form=new FormData();form.append("image",new File([new Uint8Array([1,2,3,13,10])],"cup.png",{type:"image/png"}));form.append("overwrite","true");
    const request=new Request("http://x",{method:"POST",body:form});
    const parts=parseMultipart(Buffer.from(await request.arrayBuffer()),request.headers.get("content-type")!);
    expect(parts.map(p=>[p.name,p.filename])).toEqual([["image","cup.png"],["overwrite",undefined]]);
    expect([...parts[0].data]).toEqual([1,2,3,13,10]);
  });
});
