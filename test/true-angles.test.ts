import {describe,expect,it} from "vitest";
import {freezeTrueAngles,paintRunRequest,pendingPaints,retryPaint,type TrueAngles} from "../src/image/true-angles";

const scope={workspaceId:"w",projectId:"p",userId:"u",workerId:"k"};
const rendered=():TrueAngles=>({...freezeTrueAngles("src",scope,"00000000-0000-4000-8000-000000000001"),renders:{"left-45":"r1","right-45":"r2"}});

describe("true angles painting",()=>{
  it("sends each rendered view once",()=>{
    const state={...rendered(),paintRunIds:{"left-45":"run1"}};
    expect(pendingPaints(state,["left-45","right-45"])).toEqual(["right-45"]);
  });
  it("offers a failed or canceled view again, under a new request key",()=>{
    const state={...rendered(),paintRunIds:{"left-45":"run1"}};
    expect(pendingPaints(state,["left-45"],view=>view==="left-45")).toEqual(["left-45"]);
    const first=paintRunRequest(state,"left-45").idempotencyKey,retried=retryPaint(state,"left-45");
    expect(retried.paintRunIds["left-45"]).toBeUndefined();
    expect(paintRunRequest(retried,"left-45").idempotencyKey).toBe(`${first}-1`);
    expect(paintRunRequest(retryPaint({...retried,paintRunIds:{"left-45":"run2"}},"left-45"),"left-45").idempotencyKey).toBe(`${first}-2`);
  });
});
