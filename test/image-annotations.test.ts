import {describe,it,expect} from "vitest";
import {imageAnnotationsSchema,annotationInstruction,annotationStorageKey} from "../src/image/annotations";

const box={x:.1,y:.2,w:.3,h:.4,instruction:" summer garden "};
describe("numbered image annotations",()=>{
  it("validates finite bounded regions and meaningful instructions",()=>{
    expect(imageAnnotationsSchema.parse([box])[0].instruction).toBe("summer garden");
    for(const bad of [{...box,x:NaN},{...box,w:0},{...box,x:.9},{...box,instruction:" "},{...box,untrusted:true}])expect(imageAnnotationsSchema.safeParse([bad]).success).toBe(false);
    expect(imageAnnotationsSchema.safeParse([]).success).toBe(false);
    expect(imageAnnotationsSchema.safeParse(Array(9).fill(box)).success).toBe(false);
  });
  it("keeps each ordered region paired with its own instruction",()=>{
    const instructions=annotationInstruction([box,{...box,x:.5,instruction:"red hat"}],"Keep the architecture");
    const rows=JSON.parse(instructions.split("\n").at(-1)!);
    expect(rows.map((r:{region:number;instruction:string})=>[r.region,r.instruction])).toEqual([[1,"summer garden"],[2,"red hat"]]);
    expect(instructions).toContain("Do not include guide boxes");
    expect(instructions).toContain("Image 1 is the clean original");
    expect(instructions).toContain("Image 2 is a guide");
    expect(instructions).toContain("Region 1: summer garden");
    expect(instructions).toContain("Region 2: red hat");
  });
  it("scopes preview handoffs by workspace and asset",()=>{
    expect(annotationStorageKey("w1","a")).not.toBe(annotationStorageKey("w2","a"));
    expect(annotationStorageKey("w1","a")).not.toBe(annotationStorageKey("w1","b"));
  });
});
