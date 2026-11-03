import { describe,expect,it } from "vitest";
import sharp from "sharp";
import { briefInput, briefPatch } from "../server/marketing/contracts";
import { checkMarketingRenderer, contrastRatio, readableColor, renderStaticAd } from "../server/marketing/renderer";

async function product(){
  return sharp({create:{width:320,height:420,channels:4,background:"#E8EEF4"}})
    .composite([{input:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="420"><rect x="55" y="40" width="210" height="340" rx="36" fill="#2FA8FF"/></svg>')}])
    .png().toBuffer();
}
const base={format:"square_1080" as const,variantIndex:0,headline:"Built for focus",body:"A clean product story, composed locally.",cta:"Shop now",primaryColor:"#2FA8FF",backgroundColor:"#F6F8FA",textColor:"#101418"};

describe("marketing static-ad renderer",()=>{
  it("produces a verified deterministic PNG at the exact format dimensions",async()=>{
    const input={...base,productImage:await product()};
    const first=await renderStaticAd(input),second=await renderStaticAd(input);
    expect(first.png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    expect(first.png).toEqual(second.png);
    expect(await sharp(first.png).metadata()).toMatchObject({format:"png",width:1080,height:1080});
    expect(first.usedContrastFallback).toBe(false);
  },20000);
  it("renders readable punctuation and all fixed formats",async()=>{
    const raster=await product(),expected={portrait_1080x1350:[1080,1350],landscape_1920x1080:[1920,1080],story_1080x1920:[1080,1920]} as const;
    for(const format of ["portrait_1080x1350","landscape_1920x1080","story_1080x1920"] as const){
      const rendered=await renderStaticAd({...base,format,headline:"Clear, useful — today!",body:"Product-first composition. No hosted fallback.",cta:"Review (PNG)",productImage:raster});
      const metadata=await sharp(rendered.png).metadata();
      expect([metadata.width,metadata.height]).toEqual(expected[format]);
    }
  },20000);
  it("stacks the product above the copy in the 9:16 story format",async()=>{
    const rendered=await renderStaticAd({...base,format:"story_1080x1920",productImage:await product()});
    const {data,info}=await sharp(rendered.png).raw().toBuffer({resolveWithObject:true});
    const painted=(from:number,to:number)=>{
      let count=0;
      for(let y=Math.round(info.height*from);y<Math.round(info.height*to);y++)for(let x=0;x<info.width;x++){
        const at=(y*info.width+x)*info.channels;
        if(data[at]!==246||data[at+1]!==248||data[at+2]!==250)count++;
      }
      return count;
    };
    expect(painted(0,.52)).toBeGreaterThan(10000);
    expect(painted(.53,.57)).toBe(0);
    expect(painted(.58,1)).toBeGreaterThan(1000);
  },20000);
  it("keeps the readiness probe working on an existing square render",async()=>{
    expect(await checkMarketingRenderer()).toEqual({ready:true});
  },20000);
  it("rejects invalid rasters, unsupported glyphs, and text that cannot fit",async()=>{
    await expect(renderStaticAd({...base,productImage:Buffer.from("not an image")})).rejects.toThrow("valid supported raster");
    const raster=await product();
    await expect(renderStaticAd({...base,headline:"Focus 🫠",productImage:raster})).rejects.toThrow("unsupported glyph");
    await expect(renderStaticAd({...base,headline:"W".repeat(200),productImage:raster})).rejects.toThrow(/cannot fit|minimum readable/);
  });
  it("uses a documented black or white fallback at WCAG 4.5:1",()=>{
    const chosen=readableColor("#888888","#999999");
    expect(chosen.fallback).toBe(true);
    expect(contrastRatio(chosen.color,"#999999")).toBeGreaterThanOrEqual(4.5);
  });
  it("enforces format-specific copy limits before admission",()=>{
    const common={projectId:"00000000-0000-4000-8000-000000000001",brandKitId:"00000000-0000-4000-8000-000000000002",productId:"00000000-0000-4000-8000-000000000003",objective:"Sell",format:"square_1080" as const,body:"Body",cta:"Act",variantCount:1};
    expect(briefInput.safeParse({...common,headline:"x".repeat(40)}).success).toBe(true);
    expect(briefInput.safeParse({...common,headline:"x".repeat(41)}).success).toBe(false);
    const story={...common,format:"story_1080x1920" as const};
    expect(briefInput.safeParse({...story,headline:"x".repeat(44)}).success).toBe(true);
    expect(briefInput.safeParse({...story,headline:"x".repeat(45)}).success).toBe(false);
  });
  it("parses complete strict create and update brief payloads",()=>{
    const fields={brandKitId:"00000000-0000-4000-8000-000000000002",productId:"00000000-0000-4000-8000-000000000003",objective:"Launch",format:"portrait_1080x1350" as const,headline:"A useful launch",body:"Composed locally from approved product imagery.",cta:"Learn more",variantCount:3};
    expect(briefInput.safeParse({projectId:"00000000-0000-4000-8000-000000000001",...fields}).success).toBe(true);
    expect(briefPatch.safeParse({revision:2,...fields}).success).toBe(true);
    expect(briefInput.safeParse({projectId:"00000000-0000-4000-8000-000000000001",...fields,unexpected:true}).success).toBe(false);
  });
});
