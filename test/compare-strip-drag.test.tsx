import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {CompareStrip} from "../src/ds/CompareStrip";
import {ASSET_DRAG,ASSET_TYPE_DRAG,ASSET_URL_DRAG,setAssetDrag} from "../src/ds/components";

describe("comparison media drag",()=>{
  it("makes project items draggable while keeping external examples non-draggable",()=>{
    const html=renderToStaticMarkup(<CompareStrip items={[{src:"/api/v1/example",label:"Scene",asset:{id:"asset-1",contentType:"image/png"}},{src:"/examples/other.png",label:"Reference"}]}/>);
    expect(html).toContain('draggable="true"');
    expect(html).toContain('aria-label="Open Scene full view"');
    expect(html.match(/draggable="true"/g)).toHaveLength(1);
  });
  it("carries the existing asset id, URL and media type to input fields",()=>{
    const values:Record<string,string>={},transfer={setData:(key:string,value:string)=>{values[key]=value;},effectAllowed:"none"} as unknown as DataTransfer;
    setAssetDrag({dataTransfer:transfer},"asset-1","/api/v1/example","image/png");
    expect(values).toMatchObject({[ASSET_DRAG]:"asset-1",[ASSET_URL_DRAG]:"/api/v1/example",[ASSET_TYPE_DRAG]:"image/png"});
    expect(transfer.effectAllowed).toBe("copy");
  });
});
