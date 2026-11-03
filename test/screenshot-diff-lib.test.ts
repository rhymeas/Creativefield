import {describe,expect,it} from "vitest";
import {compareManifests,formatTable,normaliseAllow,shotKey} from "../scripts/screenshot-diff-lib.mjs";

/* The harness's judgement, tested without a browser: two fake manifests in, the rows and the
   failures out. A change only passes a run when the task lists it as intended. */
const shot=(route:string,width=1440,extra:Record<string,unknown>={})=>({route,width,height:900,file:`${route}@${width}.png`,sha256:`${route}-${width}-v1`,ready:true,...extra});
const manifest=(...entries:ReturnType<typeof shot>[])=>({version:1,entries});

describe("screenshot diff",()=>{
  it("names one screen by route and width",()=>{
    expect(shotKey({route:"models",width:2400})).toBe("models@2400");
  });

  it("reports two identical runs as unchanged",()=>{
    const {rows,failures}=compareManifests(manifest(shot("make"),shot("models")),manifest(shot("make"),shot("models")));
    expect(rows.map(row=>row.status)).toEqual(["same","same"]);
    expect(failures).toEqual([]);
  });

  it("fails on a changed screen that no task listed",()=>{
    const before=manifest(shot("models")),after=manifest(shot("models",1440,{sha256:"different"}));
    const {rows,failures}=compareManifests(before,after);
    expect(rows[0].status).toBe("changed");
    expect(failures.map(row=>row.key)).toEqual(["models@1440"]);
  });

  it("accepts a difference the task lists, by route or by route and width",()=>{
    const before=manifest(shot("models",1440),shot("models",2400),shot("nodes",1440),shot("nodes",2400));
    const after=manifest(shot("models",1440,{sha256:"x"}),shot("models",2400,{sha256:"x"}),shot("nodes",1440,{sha256:"y"}),shot("nodes",2400,{sha256:"y"}));
    const byRoute=compareManifests(before,after,["models","nodes"]);
    expect(byRoute.failures).toEqual([]);
    expect(byRoute.rows.map(row=>row.status)).toEqual(["changed-allowed","changed-allowed","changed-allowed","changed-allowed"]);
    const byWidth=compareManifests(before,after,{allow:[{route:"models",width:1440},{route:"nodes",width:1440}]});
    expect(byWidth.failures.map(row=>row.key)).toEqual(["models@2400","nodes@2400"]);
    expect(compareManifests(before,after,{allow:[{route:"models"}]}).failures.map(row=>row.key)).toEqual(["nodes@1440","nodes@2400"]);
  });

  it("fails a screen the baseline does not have, and one the run forgot",()=>{
    const added=compareManifests(manifest(shot("make")),manifest(shot("make"),shot("ds")));
    expect(added.failures.map(row=>row.status)).toEqual(["new"]);
    const dropped=compareManifests(manifest(shot("make"),shot("ds")),manifest(shot("make")));
    expect(dropped.failures.map(row=>row.status)).toEqual(["missing"]);
  });

  it("fails a screen that did not render, even when the task listed it",()=>{
    const {rows,failures}=compareManifests(manifest(shot("video")),manifest(shot("video",1440,{sha256:"x",ready:false,bodyChars:3})),["video"]);
    expect(rows[0].status).toBe("not-ready");
    expect(rows[0].note).toContain("3 characters");
    expect(failures.map(row=>row.key)).toEqual(["video@1440"]);
  });

  it("fails a viewport size change",()=>{
    const {rows,failures}=compareManifests(manifest(shot("make")),manifest(shot("make",1440,{height:1080})));
    expect(rows[0].status).toBe("size-changed");
    expect(rows[0].note).toContain("1440x900 -> 1440x1080");
    expect(failures).toHaveLength(1);
  });

  it("drops a malformed allow file instead of allowing everything",()=>{
    const {entries,problems}=normaliseAllow({allow:["models",{route:""},{width:2400},{route:"nodes",width:"wide"},42]});
    expect(entries).toEqual([{route:"models"}]);
    expect(problems).toHaveLength(4);
    expect(normaliseAllow("models").problems).toEqual(["allow list is not an array or {allow:[...]} object"]);
  });

  it("warns about an allow entry that matches no screen, so a typo cannot hide a change",()=>{
    const {warnings}=compareManifests(manifest(shot("make")),manifest(shot("make")),["modles"]);
    expect(warnings).toEqual(["allow entry matches no screen: modles"]);
  });

  it("prints a readable table",()=>{
    const {rows}=compareManifests(manifest(shot("make")),manifest(shot("make")));
    const table=formatTable(rows);
    expect(table.split("\n")[0]).toMatch(/route\s+width\s+status\s+pixels/);
    expect(table).toContain("make");
    expect(table.split("\n")).toHaveLength(2);
  });
});
