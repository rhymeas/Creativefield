import {describe,expect,it} from "vitest";
import {filmName,friendlyMediaName} from "../src/team/media-names";

describe("assembled film file name",()=>{
  it("uses the board name and revision",()=>{
    expect(filmName("Robot chase",3)).toBe("Robot chase-rev3.mp4");
    expect(filmName("  Robot   chase  ",1)).toBe("Robot chase-rev1.mp4");
  });
  it("stays a safe file name",()=>{
    expect(filmName('Robot/chase: "cut"|2?',2)).toBe("Robot chase cut 2-rev2.mp4");
    expect(filmName("Robot chase.",4)).toBe("Robot chase-rev4.mp4");
  });
  it("falls back when the board has no usable name",()=>{
    expect(filmName("",1)).toBe("Storyboard film-rev1.mp4");
    expect(filmName("   ",1)).toBe("Storyboard film-rev1.mp4");
    expect(filmName(null,1)).toBe("Storyboard film-rev1.mp4");
    expect(filmName(undefined,1)).toBe("Storyboard film-rev1.mp4");
    expect(filmName("///",1)).toBe("Storyboard film-rev1.mp4");
  });
  it("keeps the name short enough for a file dialog",()=>{
    const made=filmName("Long board name ".repeat(20),2);
    expect(made).toBe(`${"Long board name ".repeat(20).trim().slice(0,80).trim()}-rev2.mp4`);
    expect(made.length).toBeLessThanOrEqual(90);
    expect(made.endsWith("-rev2.mp4")).toBe(true);
  });
  it("still reads as a plain name in the library",()=>{
    expect(friendlyMediaName(filmName("Robot chase",3))).toBe("Robot chase rev3");
  });
});
