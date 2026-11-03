import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
import {pointAtFrame,validTrackingPoints} from "../src/team/video-mask/point-selection";
import {pendingTrackingIntent} from "../src/team/video-mask/tracking-state";
import {validateCapability} from "../src/capabilities/validate";
import {compileLocal} from "../src/capabilities/compile";
import {canonicalTrackingControls} from "../server/mask-tracking";
const manifest=JSON.parse(readFileSync("native-workflows/sam31-video-point-mask/manifest.json","utf8")),template=JSON.parse(readFileSync("native-workflows/sam31-video-point-mask/template.api.json","utf8"));
describe("first-frame point tracking",()=>{
  it("maps scaled pointer positions into native pixels, including the canvas border",()=>{
    const bounds={left:10,top:20,width:416,height:240};
    expect(pointAtFrame(218,120,bounds,832,480,"include")).toEqual({x:416,y:200,kind:"include"});
    expect(pointAtFrame(426,260,bounds,832,480,"exclude")).toEqual({x:831,y:479,kind:"exclude"});
    expect(pointAtFrame(9,20,bounds,832,480,"include")).toBe(null);
    expect(pointAtFrame(10,20,{...bounds,width:0},832,480,"include")).toBe(null);
    expect(pointAtFrame(NaN,20,bounds,832,480,"include")).toBe(null);
  });
  it("requires at least one finite include point and bounds the point count",()=>{
    const p={x:20,y:30,kind:"include"};
    expect(validTrackingPoints(Array.from({length:32},()=>p))).toBe(true);
    for(const points of [[],[null],{},"points",[{...p,kind:"exclude"}],[{...p,x:832}],[{...p,y:-1}],[{...p,x:Infinity}],Array.from({length:33},()=>p)])expect(validTrackingPoints(points)).toBe(false);
  });
  it("recovers the exact point intent while rejecting malformed or cross-source recovery",()=>{
    const intent={projectId:"p",workerId:"w",idempotencyKey:"points-request",capabilityId:manifest.id,version:manifest.version,routeId:"local",inputs:{source_video:"source"},controls:{},audioPolicy:"mute",tracking:{frameIndex:0,objectIndex:1,points:[{x:20,y:30,kind:"include"}]}};
    expect(pendingTrackingIntent(intent,"p","source",manifest.id)).toBe(intent);
    expect(pendingTrackingIntent(intent,"p","other",manifest.id)).toBe(null);
    for(const tracking of [null,"invalid",[],{...intent.tracking,frameIndex:1},{...intent.tracking,objectIndex:2},{...intent.tracking,points:[]}])expect(pendingTrackingIntent({...intent,tracking},"p","source",manifest.id)).toBe(null);
    for(const controls of [null,[],"controls",{threshold:.3}])expect(pendingTrackingIntent({...intent,controls},"p","source",manifest.id)).toBe(null);
  });
  it("binds canonical points to first-frame detection and that mask to source-timed tracking",()=>{
    expect(validateCapability({manifest,template})).toEqual([]);
    const graph=compileLocal({manifest,template},{capabilityId:manifest.id,version:manifest.version,routeId:"local",inputs:{source_video:"comfyfield-source.mp4"},controls:canonicalTrackingControls([{x:416,y:200,kind:"include"},{x:30,y:30,kind:"exclude"}]),audioPolicy:"mute"});
    expect(graph["4"]).toMatchObject({class_type:"ImageFromBatch",inputs:{image:["2",0],batch_index:0,length:1}});
    expect(graph["10"].inputs).toMatchObject({image:["4",0],positive_coords:'[{"x":416,"y":200}]',negative_coords:'[{"x":30,"y":30}]'});
    expect(graph["5"].inputs).toMatchObject({images:["2",0],initial_mask:["10",0],max_objects:1});
    expect(graph["5"].inputs.conditioning).toBeUndefined();
    expect(graph["8"].inputs.fps).toEqual(["2",2]);
  });
});
