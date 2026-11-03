import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {HistoryItem,MediaCard,ResultTile,referenceTrayDrop} from "../src/ds/components";
import {beginReferenceDrop,invalidateReferenceDrop} from "../src/team/TeamComposer";

describe("media drag and drop",()=>{
  it("makes library cards, generated results, and history outputs draggable",()=>{
    const drag={id:"asset-1",url:"/api/v1/workspaces/w/assets/asset-1/content",contentType:"image/png"};
    expect(renderToStaticMarkup(<MediaCard dragAsset={drag} media={<img src={drag.url} alt=""/>}/>)).toContain('draggable="true"');
    expect(renderToStaticMarkup(<ResultTile dragAsset={drag}><img src={drag.url} alt=""/></ResultTile>)).toContain('draggable="true"');
    expect(renderToStaticMarkup(<HistoryItem media={<img src={drag.url} alt=""/>} model="Image" prompt="" meta="Complete" date=""/>)).toContain('draggable="true"');
  });

  it("binds existing assets directly while retaining file and folder drops",()=>{
    const components=readFileSync("src/ds/components.tsx","utf8");
    const imageStudio=readFileSync("src/image/ImageStudio.tsx","utf8");
    const composer=readFileSync("src/team/TeamComposer.tsx","utf8");
    expect(components).toContain("onAsset?: (assetId: string) => void");
    expect(components).toContain("Array.from(e.dataTransfer.files ?? [])");
    expect(components).toContain("assetId && onAsset && acceptsAsset");
    expect(imageStudio).toContain("onAsset={(assetId) => chooseImage(port.id, assetId)}");
    expect(imageStudio).toContain("dragAsset={{id:asset.id");
    expect(composer).toContain('<TeamMediaInput projectId={project.id}');
    expect(composer).toContain('onSelect={id=>{if(id)startWithAsset(imageTarget,"start_image",id);}}');
  });

  it("routes project assets and bundled examples into the shared reference tray",()=>{
    const transfer=(values:Record<string,string>,files:File[]=[])=>( {getData:(type:string)=>values[type]??"",files:files as unknown as FileList} );
    expect(referenceTrayDrop(transfer({"application/x-comfyfield-asset":"asset-7"}))).toEqual({kind:"asset",value:"asset-7"});
    expect(referenceTrayDrop(transfer({"application/x-comfyfield-example":"/examples/pool/img-04.webp"}))).toEqual({kind:"example",value:"/examples/pool/img-04.webp"});
    const local=[{name:"first.png",type:"image/png"},{name:"second.webp",type:"image/webp"}] as File[];
    expect(referenceTrayDrop(transfer({},local))).toEqual({kind:"files",files:local});
    expect(referenceTrayDrop(transfer({}))).toBeNull();
    const composer=readFileSync("src/team/TeamComposer.tsx","utf8");
    expect(composer).toContain("onAssetDrop={emptyReference?");
    expect(composer).toContain("onExampleDrop={emptyReference?");
    expect(composer).toContain("onFilesDrop={openReferencePorts.length?");
    expect(composer).toContain("Choose a compatible image from this project.");
  });

  it("keeps a newer manual reference choice ahead of a slower drop",()=>{
    const epoch={current:0},slowDrop=beginReferenceDrop(epoch);
    expect(slowDrop.isCurrent()).toBe(true);
    invalidateReferenceDrop(epoch);
    expect(slowDrop.isCurrent()).toBe(false);
    const newerDrop=beginReferenceDrop(epoch);
    expect(newerDrop.isCurrent()).toBe(true);
    expect(slowDrop.isCurrent()).toBe(false);
    const composer=readFileSync("src/team/TeamComposer.tsx","utf8");
    expect(composer).toContain("supersedeReferenceDrop();setAddingReference(false)");
    expect(composer).toContain("supersedeReferenceDrop();setElementInput");
  });
});
