import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultTile } from "../src/ds";
import { developPresentation } from "../src/team/develop-state";
import {elapsedRunTime} from "../src/team/RunDevelop";

const frame = { active: true, preview: true, value: 12, max: 20, node: "sampler", seq: 3, updatedAt: "2026-10-21T18:00:00Z" };

describe("Darkroom ledger transitions", () => {
  it("formats elapsed time from the recorded creation time",()=>{
    expect(elapsedRunTime("2026-01-01T00:00:00Z",Date.parse("2026-01-01T01:02:03Z"))).toBe("1:02:03");
    expect(elapsedRunTime("2026-01-01T00:00:00Z",Date.parse("2026-01-01T00:00:09Z"))).toBe("0:09");
    expect(elapsedRunTime("invalid",0)).toBeNull();
  });
  it("distinguishes a cancellation request from confirmed cancellation", () => {
    const request = developPresentation("cancel_requested", frame, "/preview");
    const done = developPresentation("canceled", { ...frame, active: false }, "/preview");
    expect(request).toMatchObject({ active: true, label: "Cancelling…", src: "/preview", progress: .6 });
    expect(done).toMatchObject({ active: false, label: "Cancelled at step 12/20", src: "/preview" });
  });

  it("stops shimmer and busy state on failure while retaining the last real preview", () => {
    const view = developPresentation("failed", frame, "/preview");
    const html = renderToStaticMarkup(<ResultTile develop={view} />);
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('data-terminal=""');
    expect(html).toContain("Failed at step 12/20");
    expect(html).toContain('src="/preview"');
    expect(html).not.toContain("ds-shimmer");
  });

  it.each(["failed", "canceled"])("renders %s without inventing missing step or preview data", state => {
    const view = developPresentation(state, null, "/preview");
    expect(view?.label).toBe(state === "failed" ? "Failed" : "Cancelled");
    expect(view?.src).toBeUndefined();
    expect(view?.progress).toBeUndefined();
    const html = renderToStaticMarkup(<ResultTile develop={view} />);
    expect(html).toContain("ds-resulttile__skeleton");
    expect(html).not.toContain('aria-busy="true"');
  });

  it("shows no made-up step counts when the denominator is missing or zero", () => {
    expect(developPresentation("running", { ...frame, max: 0 })?.label).toBe("Working on it");
    expect(developPresentation("running", null)?.progress).toBeUndefined();
    expect(developPresentation("queued", frame)?.label).toBe("Queued");
    expect(developPresentation("submission_unknown", frame)?.label).toBe("Checking submission");
  });

  it("hands success back to the final-media tile", () => {
    expect(developPresentation("succeeded", frame, "/preview")).toBeUndefined();
  });
  it("shows the actual memory wait without invented sampler progress",()=>{
    expect(developPresentation("pending",{...frame,waiting:"memory",value:null,max:null,preview:false})).toMatchObject({label:"Waiting for free memory",active:true,progress:undefined});
    expect(developPresentation("pending",{...frame,waiting:"memory",waitingNote:"5.9 of 64 GB free, needs 9.6 GB",value:null,max:null,preview:false})?.label).toBe("Waiting for free memory · 5.9 of 64 GB free, needs 9.6 GB");
  });
});
