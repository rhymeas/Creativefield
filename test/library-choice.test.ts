import {readdirSync,readFileSync,statSync} from "node:fs";
import path from "node:path";
import {describe,expect,it} from "vitest";

const files=(dir:string):string[]=>readdirSync(dir).flatMap(name=>{const full=path.join(dir,name);return statSync(full).isDirectory()?files(full):/\.tsx?$/.test(name)?[full]:[];});

describe("one Choose from library button for the whole app",()=>{
  it("is built in LibraryChoice only; no screen assembles its own",()=>{
    const offenders=files("src/team").filter(file=>!file.endsWith("LibraryChoice.tsx")).filter(file=>/label="Library"/.test(readFileSync(file,"utf8")));
    expect(offenders).toEqual([]);
  });
  it("is the tall quiet pill with only its words",()=>{
    const source=readFileSync("src/team/LibraryChoice.tsx","utf8");
    expect(source).toContain('size="lg"');
    expect(source).toContain("prefix={false}");
    expect(source).toContain("Choose from library");
    expect(readFileSync("src/ds/components.css","utf8")).toMatch(/\.ds-pill--quiet\.ds-pill--lg\s*\{[^}]*background:\s*none/);
  });
});
