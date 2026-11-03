import {afterEach,describe,expect,it,vi} from "vitest";
import {clearLookCache,cachedLook,describePicture,visionGraph,VISION_CLIP} from "../server/reference-describe";
import {describeReplacePrompt,lookInstruction,lookWords} from "../src/workflow/reference-prompt";

const worker={origin:"http://127.0.0.1:8188",api_prefix:""};
const picture={bytes:new Uint8Array([1,2,3]),mediaType:"image/png",sha256:"a".repeat(64)};

/** ComfyUI as far as this module can tell: it accepts the upload, queues the graph and answers. */
function answeringWorker(answer:string|null){
  const calls:string[]=[];
  const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
    const url=String(input);
    calls.push(url);
    if(url.endsWith("/upload/image"))return Response.json({name:"comfyfield-look-aaaaaaaaaaaaaaaa.png"});
    if(url.endsWith("/prompt"))return Response.json({prompt_id:"p1"});
    if(url.includes("/history/p1"))return answer===null?Response.json({}):Response.json({p1:{status:{completed:true},outputs:{"4":{text:[answer]}}}});
    return new Response("not found",{status:404});
  });
  vi.stubGlobal("fetch",fetchMock);
  return calls;
}

afterEach(()=>{
  vi.unstubAllGlobals();
  clearLookCache();
});

describe("the look words for a character picture",()=>{
  it("asks for one short sentence about hair, beard, glasses and clothes",()=>{
    const instruction=lookInstruction();
    expect(instruction).toMatch(/one short sentence/i);
    expect(instruction).toMatch(/hair/i);
    expect(instruction).toMatch(/glasses/i);
    expect(instruction).toMatch(/clothes/i);
  });

  it("keeps one plain sentence and drops a lead-in",()=>{
    expect(lookWords("The picture shows a man with short dark hair, a beard and glasses. He wears a grey shirt."))
      .toBe("short dark hair, a beard and glasses");
    expect(lookWords('"Long blonde hair, no beard, and a white t-shirt"')).toBe("long blonde hair, no beard, and a white t-shirt");
    expect(lookWords("Bearded man with short brown hair, wearing a grey long-sleeve shirt and a green cap, arms crossed."))
      .toBe("short brown hair, wearing a grey long-sleeve shirt and a green cap, arms crossed");
    expect(lookWords("   \n  ")).toBeUndefined();
    expect(lookWords("a man")).toBeUndefined();
    expect(lookWords(`${"very long words ".repeat(40)}.`)).toHaveLength(200);
  });

  it("describes every replaced person, and says nothing when one picture was not read",()=>{
    expect(describeReplacePrompt({people:[{where:"person on the left",look:"a moustache and a white t-shirt"},{where:"person on the right",look:"a beard and a grey shirt"}],keep:"the movement"}))
      .toBe("Two people. The person on the left has a moustache and a white t-shirt. The person on the right has a beard and a grey shirt. Keep the source video's full frame, camera, background and motion. Keep the movement.");
    expect(describeReplacePrompt({people:[{where:"person on the left",look:"a moustache"},{where:"person on the right"}]})).toBeUndefined();
    expect(describeReplacePrompt({people:[]})).toBeUndefined();
  });
});

describe("reading a picture on the local worker",()=>{
  it("loads the picture into the vision model, not into a text-only graph",()=>{
    const graph=visionGraph("comfyfield-look-x.png","describe");
    expect(graph["1"].inputs).toMatchObject({clip_name:VISION_CLIP,type:"qwen_image"});
    expect(graph["2"]).toMatchObject({class_type:"LoadImage",inputs:{image:"comfyfield-look-x.png"}});
    expect(graph["3"].inputs.image).toEqual(["2",0]);
    expect(graph["3"].inputs.prompt).toBe("describe");
  });

  it("reads a picture once and keeps the sentence for the same picture",async()=>{
    const calls=answeringWorker("Short dark hair, a moustache and a navy shirt.");
    const first=await describePicture(worker,calls.length?picture:picture);
    expect(first).toBe("short dark hair, a moustache and a navy shirt");
    expect(cachedLook(worker,picture)).toBe("short dark hair, a moustache and a navy shirt");
    const asked=calls.length;
    expect(await describePicture(worker,{...picture,sha256:picture.sha256})).toBe("short dark hair, a moustache and a navy shirt");
    expect(calls.length).toBe(asked);
  });

  it("leaves the words out when the worker cannot read the picture",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response("no",{status:500})));
    expect(await describePicture(worker,picture)).toBeUndefined();
    expect(cachedLook(worker,picture)).toBeUndefined();
  });
});
