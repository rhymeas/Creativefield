import {describe,expect,it} from "vitest";
import {swapCheckProvenance,swapCheckProvenanceName} from "../src/image/editor/swap-check-provenance";

const record={source:"source-asset",reference:"reference-asset",result:"result-asset",label:"Mara",run:"run-123"};

describe("swap-check provenance",()=>{
  it("records the exact source, reference, result and run for human review",()=>{
    const receipt=swapCheckProvenance(record,{workspaceId:"workspace",projectId:"project",createdAt:"2026-10-24T00:00:00.000Z"});
    expect(receipt).toMatchObject({schemaVersion:1,kind:"comfyfield-swap-check",createdAt:"2026-10-24T00:00:00.000Z",workspaceId:"workspace",projectId:"project",label:"Mara",runId:"run-123"});
    expect(receipt.assets).toEqual({source:"source-asset",reference:"reference-asset",result:"result-asset"});
    expect(receipt.review).toContain("not an identity score");
  });

  it("names the download after the run",()=>{
    expect(swapCheckProvenanceName(record.run)).toBe("swap-check-run-123.json");
  });
});
