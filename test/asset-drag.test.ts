import {describe,expect,it,vi} from "vitest";
import {ASSET_DRAG,ASSET_TYPE_DRAG} from "../src/ds";
import {addKnownAssetDragType} from "../src/team/asset-drag";
import type {Asset} from "../src/team/api";

describe("asset drag metadata",()=>{
  it("adds the known asset's exact MIME type without changing unknown drags",()=>{
    const asset={id:"video",content_type:"video/mp4"} as Asset;
    const getData=vi.fn((type:string)=>type===ASSET_DRAG?"video":"");
    const setData=vi.fn();
    addKnownAssetDragType({getData,setData},[asset]);
    expect(setData).toHaveBeenCalledWith(ASSET_TYPE_DRAG,"video/mp4");
    setData.mockClear();
    addKnownAssetDragType({getData,setData},[]);
    expect(setData).not.toHaveBeenCalled();
  });
});
