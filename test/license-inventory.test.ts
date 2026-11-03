import {existsSync,readFileSync,readdirSync} from "node:fs";
import {describe,expect,it} from "vitest";

type Manifest={id:string;licenses:{software:string;weights:Array<{name:string;license:string;source:string}>}};

const bundleDirs=readdirSync("native-workflows",{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name).filter(dir=>existsSync(`native-workflows/${dir}/manifest.json`)).sort();
const manifests=bundleDirs.map(dir=>({dir,manifest:JSON.parse(readFileSync(`native-workflows/${dir}/manifest.json`,"utf8")) as Manifest}));
const inventory=readFileSync("docs/LICENSE-INVENTORY.md","utf8");

describe("REL-04 license inventory",()=>{
  it("covers every bundled native workflow",()=>{
    expect(manifests.length).toBeGreaterThan(0);
    for(const {dir} of manifests)expect(inventory).toContain(dir);
  });

  it("requires declared software and weight licenses with sources",()=>{
    for(const {manifest} of manifests){
      expect(manifest.licenses.software.length).toBeGreaterThan(0);
      expect(manifest.licenses.weights.length).toBeGreaterThan(0);
      for(const weight of manifest.licenses.weights){
        expect(weight.license.length).toBeGreaterThan(0);
        expect(weight.source).toMatch(/^https:\/\//);
        expect(inventory).toContain(weight.name);
      }
    }
  });

  it("keeps the non-commercial Qwen boundary explicit",()=>{
    expect(inventory).toContain("Qwen Image 2.1");
    expect(inventory).toMatch(/non-commercial research\/evaluation only/i);
  });
});
