import {describe,expect,it} from "vitest";
import {friendlyMediaName} from "../src/team/media-names";

describe("plain media names",()=>{
  it("turns generated file names into what they are",()=>{
    expect(friendlyMediaName("scail2-character-replace_00008_.mp4")).toBe("Swapped person 8");
    expect(friendlyMediaName("vace-reference-restyle_00003_.mp4")).toBe("New look from a picture 3");
    expect(friendlyMediaName("masked-edit_00011_.mp4")).toBe("Edited area 11");
    expect(friendlyMediaName("ComfyUI_00058_.mp4")).toBe("ComfyUI result 58");
    expect(friendlyMediaName("storyboard-0641a365-1a5a-4d43-be28-6209c5072b09.mp4")).toBe("Storyboard film");
  });
  it("keeps people's own names readable",()=>{
    expect(friendlyMediaName("swap-track-source.mp4")).toBe("Swap track source");
    expect(friendlyMediaName("clip-two-talking.mp4")).toBe("Clip two talking");
    expect(friendlyMediaName("comfyfield-62d8ba28-7275-4e12-94f2-884c4bf1b55f-1445f1cb.mp4")).toBe("Uploaded file");
  });
});
