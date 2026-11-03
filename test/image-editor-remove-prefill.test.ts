import {describe,expect,it} from "vitest";
import {prefillRemoval} from "../src/image/editor/remove-prefill";

describe("removal conditioning",()=>{
  it("hides selected pixels using surrounding color without changing the rest",()=>{
    const data=new Uint8ClampedArray(4*4*4),mask=new Uint8ClampedArray(data.length);
    for(let i=0;i<data.length;i+=4){data.set([30,60,90,255],i);mask[i+3]=255;}
    const i=(1*4+1)*4;data.set([240,20,20,255],i);mask[i]=255;
    prefillRemoval({width:4,height:4,data} as ImageData,{width:4,height:4,data:mask} as ImageData);
    expect([...data.slice(i,i+4)]).toEqual([30,60,90,255]);
    expect([...data.slice(0,4)]).toEqual([30,60,90,255]);
  });
  it("refuses masks without any visible context",()=>{
    const data=new Uint8ClampedArray(16).fill(255);
    expect(()=>prefillRemoval({width:2,height:2,data:data.slice()} as ImageData,{width:2,height:2,data:data.slice()} as ImageData)).toThrow(/background/);
  });
});
