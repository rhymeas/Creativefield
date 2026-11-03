import {describe,it,expect} from "vitest";
import {maskEdges} from "../src/image/editor/mask-outline";
describe("selection boundary rendering",()=>{
  it("coalesces a full canvas into four outer edges",()=>{
    const d=new Uint8ClampedArray(4*3*4);for(let i=3;i<d.length;i+=4)d[i]=255;
    expect(maskEdges(d,4,3)).toEqual([[0,0,4,0],[0,3,4,3],[0,0,0,3],[4,0,4,3]]);
  });
  it("keeps hole outlines and never changes alpha or colour",()=>{
    const d=new Uint8ClampedArray(3*3*4);for(let i=3;i<d.length;i+=4)d[i]=255;d[(1*3+1)*4+3]=0;
    const before=d.slice(),edges=maskEdges(d,3,3);expect(edges).toHaveLength(8);expect(edges).toContainEqual([1,1,2,1]);expect(edges).toContainEqual([1,2,2,2]);expect(d).toEqual(before);
  });
  it("does not outline transparent RGB or faint unselected pixels",()=>{
    const d=new Uint8ClampedArray([255,255,255,0,255,255,255,8]);expect(maskEdges(d,2,1)).toEqual([]);expect(()=>maskEdges(d,2,2)).toThrow(/dimensions/);
  });
});
