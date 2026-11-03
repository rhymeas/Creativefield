import {describe,it,expect} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {poseFramePlan,poseFrameAt,readPoseFrames} from "../src/capabilities/pose-preview";
import {PoseStrip} from "../src/ds/PoseStrip";
import fixture from "../src/ds/fixtures/pose-preview.json";

describe("measured driving pose preview",()=>{
  const frame=fixture.frames[0].pose,identity={count:1,width:704,height:1280};
  it("samples the real normalized clock without repeats, including both ends",()=>{
    expect(poseFramePlan(241)).toEqual([0,48,96,144,192,240].map(frameIndex=>({frameIndex,seconds:frameIndex/24})));
    for(let count=1;count<=641;count++){const plan=poseFramePlan(count);expect(plan).toHaveLength(Math.min(6,count));expect(new Set(plan.map(f=>f.frameIndex)).size).toBe(plan.length);expect(plan[0].frameIndex).toBe(0);expect(plan.at(-1)!.frameIndex).toBe(count-1);}
    for(const invalid of [0,-1,642,NaN,Infinity,2.5])expect(()=>poseFramePlan(invalid)).toThrow();
  });
  it("preserves the real extractor's coordinates and heatmap scores above one",()=>{
    const parsed=readPoseFrames([frame],identity);expect(parsed?.[0]).toEqual(frame);expect(frame.people[0].pose_keypoints_2d).toHaveLength(54);expect(Math.max(...frame.people[0].pose_keypoints_2d.filter((_,i)=>i%3===2))).toBeGreaterThan(1);
    expect(readPoseFrames([{...frame,storage_key:"private",people:frame.people.map(person=>({...person,internal:"private"}))}],identity)?.[0]).toEqual(frame);
    expect(readPoseFrames([{...frame,people:[]}],identity)?.[0].people).toEqual([]);
  });
  it("rejects mismatched source geometry, unbounded or malformed points",()=>{
    const person=frame.people[0];for(const value of [[{...frame,canvas_width:512}],[{...frame,people:Array(9).fill(person)}],[{...frame,people:[{...person,pose_keypoints_2d:[NaN,...person.pose_keypoints_2d.slice(1)]}]}],[{...frame,people:[{...person,pose_keypoints_2d:[1000000,...person.pose_keypoints_2d.slice(1)]}]}],[{...frame,people:[{...person,hand_left_keypoints_2d:[1,2,3]}]}]])expect(readPoseFrames(value,identity)).toBeNull();
    expect(readPoseFrames([frame],{...identity,count:2})).toBeNull();expect(readPoseFrames([frame],{...identity,width:Infinity})).toBeNull();
  });
  it("selects only measured samples and renders actual limbs without placeholder poses",()=>{
    const samples=poseFramePlan(241).map(p=>({...p,pose:frame}));expect(poseFrameAt(samples,.5)).toBe(0);expect(poseFrameAt(samples,2)).toBe(1);expect(poseFrameAt(samples,NaN)).toBe(-1);
    const html=renderToStaticMarkup(<PoseStrip frames={fixture.frames} selected={0} onSelect={()=>{}}/>);expect(html).toContain('aria-label="Detected pose samples"');expect(html).toContain(`x1="${frame.people[0].pose_keypoints_2d[3]}"`);expect(html).toContain('aria-current="true"');expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<PoseStrip frames={[]} selected={0} onSelect={()=>{}}/>)).toBe("");
    const empty=renderToStaticMarkup(<PoseStrip frames={[{...fixture.frames[0],pose:{...frame,people:[]}}]} selected={0} onSelect={()=>{}}/>);expect(empty).toContain('No detected person');expect(empty).not.toContain('<line');
  });
});
