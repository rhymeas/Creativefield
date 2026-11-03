import {describe,it,expect} from "vitest";
import {softenEraseAlpha,contractEraseAlpha,defringeOnePixel} from "../src/image/editor/matting";
describe("automatic eraser matting",()=>{
  it("softens only the retained edge without restoring removed pixels or blurring the interior",()=>{
    const alpha=new Uint8ClampedArray(25).fill(255);for(let y=0;y<5;y++)alpha[y*5]=0;
    const soft=softenEraseAlpha(alpha,5,5);
    expect(soft[10]).toBe(0);expect(soft[11]).toBeGreaterThan(220);expect(soft[11]).toBeLessThan(255);expect(soft[12]).toBe(255);expect(alpha[11]).toBe(255);
  });
  it("replaces a pale one-pixel fringe with interior colour while preserving alpha",()=>{
    const rgba=new Uint8ClampedArray(7*7*4);
    for(let y=1;y<6;y++)for(let x=1;x<6;x++){const i=(y*7+x)*4;rgba.set([220,30,20,255],i);if(x===1||x===5||y===1||y===5)rgba.set([245,230,230,230],i);}
    const clean=defringeOnePixel(rgba,7,7);
    expect(Array.from(clean.slice((3*7+1)*4,(3*7+1)*4+4))).toEqual([220,30,20,230]);
    for(let i=3;i<rgba.length;i+=4)expect(clean[i]).toBe(rgba[i]);
    expect(Array.from(clean.slice((3*7+3)*4,(3*7+3)*4+4))).toEqual([220,30,20,255]);
    expect(rgba[(3*7+1)*4]).toBe(245);
  });
  it("contracts a retained matte by one full pixel and only softens the next inner row",()=>{
    const alpha=new Uint8ClampedArray(49).fill(255);for(let y=0;y<7;y++)alpha[y*7]=0;
    const clean=contractEraseAlpha(alpha,7,7,1);
    expect(clean[3*7]).toBe(0);
    expect(clean[3*7+1]).toBe(0);
    expect(clean[3*7+2]).toBeGreaterThan(220);
    expect(clean[3*7+2]).toBeLessThan(255);
    expect(clean[3*7+3]).toBe(255);
    expect(alpha[3*7+1]).toBe(255);
  });
});
