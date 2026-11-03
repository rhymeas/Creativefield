import {describe,it,expect} from "vitest";
import {maskRectangle,validMaskPatch} from "../src/team/video-mask/correction";
import {correctionFilters,maskCorrectionBody} from "../server/mask-correction";
describe("bounded manual mask corrections",()=>{
  const g={width:160,height:96,frames:17},p={start:1,end:2,x:32,y:16,width:8,height:8,mode:"subtract" as const};
  it("keeps reversed and outside drags within integer image pixels",()=>{
    expect(maskRectangle({x:180,y:98},{x:-9,y:-4},g)).toEqual({x:0,y:0,width:160,height:96});
    expect(maskRectangle({x:20.9,y:30.1},{x:15.3,y:24.6},g)).toEqual({x:15,y:24,width:6,height:7});
    expect(validMaskPatch(p,g)).toBe(true);for(const invalid of [{end:17},{start:3},{x:159},{width:0},{x:NaN},{mode:"erase"}])expect(validMaskPatch({...p,...invalid} as any,g)).toBe(false);
  });
  it("accepts only finite bounded rectangles and never embeds arbitrary filter text",()=>{
    const input={requestId:"00000000-0000-4000-8000-000000000001",expectedSha256:"a".repeat(64),patches:[p]};expect(maskCorrectionBody.safeParse(input).success).toBe(true);
    for(const patches of [[],Array(65).fill(p),[{...p,mode:"white;movie=file"}],[{...p,x:Infinity}],[{...p,unknown:1}]])expect(maskCorrectionBody.safeParse({...input,patches}).success).toBe(false);
    expect(correctionFilters([p])).toBe("drawbox=x=32:y=16:w=8:h=8:color=black:t=fill:enable='between(n,1,2)'");
  });
});
