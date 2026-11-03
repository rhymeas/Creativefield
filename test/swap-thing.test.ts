import {beforeAll,describe,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import type {PoolClient} from "pg";
import type {CapabilityBundle} from "../src/capabilities/types";
import {HttpError} from "../server/auth";
import {loadServerCatalogue} from "../server/catalogue";
import {prepareInvocation,requestSchema,type RunRequest} from "../server/run-submission";
import {buildSwapSteps,swapClipProblem,swapThingProblem,CLIP_ENVELOPE,CLIP_PROBLEM,type SwapStep} from "../src/team/swap-thing";

type Result={error:HttpError|null;statements:string[]};
const readyInventory={online:true,nodes:[],models:[],credentials:[],objectInfoChecked:true,checkedModelFolders:[]};
/** The only place the mask step's body can be refused before any run row exists. */
function fakeClient(){
  const statements:string[]=[];
  const client={query:async(sql:string)=>{
    statements.push(sql);
    if(sql.includes("FROM projects"))return{rowCount:1,rows:[{id:randomUUID()}]};
    if(sql.includes("FROM workers"))return{rowCount:1,rows:[{kind:"local",checked_at:new Date().toISOString(),inventory:readyInventory}]};
    return{rowCount:0,rows:[]};
  }};
  return{client:client as unknown as PoolClient,statements};
}
/** The request body SwapThingPanel posts for one step. */
function bodyFor(step:SwapStep):RunRequest{
  return{projectId:randomUUID(),workerId:randomUUID(),idempotencyKey:`swap-${randomUUID()}-${step.id}`,capabilityId:step.capabilityId,version:step.version,routeId:"local",
    inputs:Object.fromEntries(Object.entries(step.inputs).map(([role,input])=>[role,"asset" in input?input.asset:randomUUID()])),elementInputs:{},controls:step.controls as RunRequest["controls"],audioPolicy:"mute",
    ...(step.tracking?{tracking:step.tracking}:{})};
}
async function submit(body:RunRequest):Promise<Result>{
  const {client,statements}=fakeClient();
  try{await prepareInvocation(client,catalogue,randomUUID(),body);return{error:null,statements};}
  catch(error){return{error:error as HttpError,statements};}
}

let catalogue:CapabilityBundle[];
beforeAll(async()=>{catalogue=await loadServerCatalogue();});

describe("swap a thing",()=>{
  it("tracks the thing from words, then edits only that area",()=>{
    const steps=buildSwapSteps({video:"v",target:" the red car ",prompt:"a blue bike"});
    expect(steps.map(s=>[s.id,s.capabilityId])).toEqual([["mask","sam31-video-mask"],["edit","wan21-vace-masked-edit"]]);
    expect(steps[0]).toMatchObject({inputs:{source_video:{asset:"v"}},tracking:{prompt:"the red car"}});
    expect(steps[0].controls).toEqual({});
    expect(steps[1].inputs).toEqual({source_video:{asset:"v"},edit_mask:{step:"mask"}});
    expect(steps[1].controls.prompt).toBe("a blue bike. It matches the light, shadows, scale and perspective of the scene and looks like it was always there.");
  });
  it("uses the reference workflow when a picture is given, and words the prompt from it",()=>{
    const steps=buildSwapSteps({video:"v",target:"the mug",reference:"img"});
    expect(steps[1]).toMatchObject({capabilityId:"wan21-vace-masked-edit-reference",inputs:{object_reference:{asset:"img"}}});
    expect(steps[1].controls.prompt).toBe("The mug becomes the object in the picture. It matches the light, shadows, scale and perspective of the scene and looks like it was always there.");
  });
  it("says what is missing in plain words",()=>{
    expect(swapThingProblem({})).toBe("Add your video.");
    expect(swapThingProblem({video:"v"})).toBe("Say what to change.");
    expect(swapThingProblem({video:"v",target:"c"})).toBe("Say what to change.");
    expect(swapThingProblem({video:"v",target:"car"})).toBe("Add a picture or say what it becomes.");
    expect(swapThingProblem({video:"v",target:"car",prompt:"a bike"})).toBeUndefined();
  });
  it("says the clip it wants in one plain line",()=>{
    expect(CLIP_ENVELOPE).toBe("1 to 5 seconds, 16 fps, at most 832 px");
    expect(CLIP_PROBLEM).toBe("Use a clip of 1 to 5 seconds at 16 fps, at most 832 px a side.");
  });
  it("answers a refused clip with that sentence, not ffprobe wording",()=>{
    // The exact messages the tracker answers for a 30 fps, oversized or rotated upload.
    for(const message of ["Use constant 16 FPS video starting at timestamp zero",
      "Use dimensions divisible by 16, with at most 832 pixels per side and 399360 pixels per frame",
      "Use 17 to 81 frames with a frame count of 4n+1","Bake rotation into the source before uploading",
      "Masked editing accepts files up to 128 MiB","Choose a file with one video stream"])
      expect(swapClipProblem("mask",{status:422,message})).toBe(CLIP_PROBLEM);
  });
  it("keeps a problem that is not about the clip, and never rewrites the change step",()=>{
    expect(swapClipProblem("mask",{status:422,message:"Tracking source is missing or changed; upload it again"})).toBeUndefined();
    expect(swapClipProblem("mask",{status:422,message:"Tracking workflow checkpoint evidence is invalid"})).toBeUndefined();
    expect(swapClipProblem("mask",{status:500,message:"Use constant 16 FPS video starting at timestamp zero"})).toBeUndefined();
    expect(swapClipProblem("edit",{status:422,message:"Use constant 16 FPS video starting at timestamp zero"})).toBeUndefined();
    expect(swapClipProblem("mask",new Error("Failed to fetch"))).toBeUndefined();
  });
});

describe("the mask step's request reaches the server",()=>{
  const maskStep=()=>buildSwapSteps({video:randomUUID(),target:"the red car"})[0];

  it("passes the request schema and the server's tracking rules",async()=>{
    const body=bodyFor(maskStep());
    expect(body.controls).toEqual({});
    expect(body.tracking).toEqual({prompt:"the red car"});
    expect(requestSchema.safeParse(body).success).toBe(true);
    const {error,statements}=await submit(body);
    expect(error?.statusCode).not.toBe(400);
    expect(error?.message).not.toMatch(/mask prompt/i);
    expect(statements.filter(sql=>sql.includes("INSERT INTO runs"))).toEqual([]);
  });

  it("refuses the old body: a prompt control, no tracking",async()=>{
    const body=bodyFor(maskStep());
    const {error}=await submit({...body,controls:{prompt:"the red car"},tracking:undefined});
    expect(error?.statusCode).toBe(400);
    expect(error?.message).toBe("A mask prompt is required for this workflow");
  });

  it("refuses a prompt control beside tracking: the phrase is server-owned",async()=>{
    const body=bodyFor(maskStep());
    const {error}=await submit({...body,controls:{prompt:"the red car"}});
    expect(error?.statusCode).toBe(400);
    expect(error?.message).toBe("The mask prompt is server-owned");
  });
});
