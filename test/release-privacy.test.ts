import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {copyFile, mkdtemp, mkdir, readFile, readdir, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {gunzipSync} from "node:zlib";
import {describe, expect, test} from "vitest";
// @ts-expect-error plain-JS release guard also runs without TypeScript tooling
import {assertPublicPath, assertPublicText, readReviewedRelease} from "../scripts/release-privacy.mjs";

async function fixture(){
  const root=await mkdtemp(join(process.env.COMFYFIELD_TEST_TEMP_ROOT??tmpdir(),"release-privacy-"));
  await mkdir(join(root,".comfyfield"));
  await writeFile(join(root,"README.md"),"Public source documentation.\n");
  return root;
}
async function review(root:string){
  const content=await readFile(join(root,"README.md"));
  await writeFile(join(root,".comfyfield","public-release-review.json"),JSON.stringify({version:1,files:[{path:"README.md",sha256:createHash("sha256").update(content).digest("hex")}]}));
}

describe("public export privacy gate",()=>{
  test("fails closed without an explicit per-file review",async()=>{
    await expect(readReviewedRelease(await fixture())).rejects.toThrow(/packaging is locked/);
  });
  test("exports only reviewed bytes and excludes extra local files",async()=>{
    const root=await fixture();
    await writeFile(join(root,".pad.toml"),"private workspace metadata");
    await review(root);
    const result=await readReviewedRelease(root);
    expect(result.map((file:{path:string})=>file.path)).toEqual(["README.md"]);
    expect(result[0].content.toString()).toBe("Public source documentation.\n");
  });
  test("invalidates approval when any selected content changes",async()=>{
    const root=await fixture();await review(root);
    await writeFile(join(root,"README.md"),"Changed after review");
    await expect(readReviewedRelease(root)).rejects.toThrow(/changed since privacy review/);
  });
  test("rejects symlinked directories rather than following them",async()=>{
    const root=await fixture();await review(root);
    await symlink(root,join(root,"linked"),process.platform==="win32"?"junction":"dir");
    const manifest=join(root,".comfyfield","public-release-review.json");
    const data=JSON.parse(await readFile(manifest,"utf8"));data.files[0].path="linked/README.md";
    await writeFile(manifest,JSON.stringify(data));
    await expect(readReviewedRelease(root)).rejects.toThrow(/linked or nonregular/);
  });
  test("actual packager retains old outputs and archives only the reviewed fixture",async()=>{
    const root=await fixture();await mkdir(join(root,"scripts"));await mkdir(join(root,"docs"));await mkdir(join(root,"native-workflows"));await mkdir(join(root,"release"));
    await writeFile(join(root,"release","existing.txt"),"retain previous evidence");
    await writeFile(join(root,".pad.toml"),"DO_NOT_EXPORT_PRIVATE_WORKSPACE");
    await writeFile(join(root,"package.json"),JSON.stringify({version:"0.0.0"}));
    const paths=["README.md","package.json","package-lock.json","LICENSE","docs/LICENSE-INVENTORY.md","docs/INSTALL-BACKUP-RECOVERY.md","native-workflows/example.json"];
    const files=[];
    for(const path of paths){
      if(!["README.md","package.json"].includes(path))await writeFile(join(root,path),"Public synthetic fixture.\n");
      files.push({path,sha256:createHash("sha256").update(await readFile(join(root,path))).digest("hex")});
    }
    await writeFile(join(root,".comfyfield","public-release-review.json"),JSON.stringify({version:1,files}));
    for(const script of ["release-package.mjs","release-privacy.mjs"])await copyFile(fileURLToPath(new URL(`../scripts/${script}`,import.meta.url)),join(root,"scripts",script));
    execFileSync(process.execPath,[join(root,"scripts","release-package.mjs")],{cwd:root,stdio:"pipe"});
    const archive=(await readdir(join(root,"release"))).find(path=>path.endsWith(".tar.gz"))!;
    const tar=gunzipSync(await readFile(join(root,"release",archive))).toString("utf8");
    expect(tar).toContain("Public synthetic fixture.");expect(tar).not.toContain("DO_NOT_EXPORT_PRIVATE_WORKSPACE");expect(tar).not.toContain(".pad.toml");
    expect(await readFile(join(root,"release","existing.txt"),"utf8")).toBe("retain previous evidence");
  });
  test.each([".pad.toml",".env","server/.env.local",".comfyfield/app.env","auth.json","nested/credentials.json","keys/private.pem","AGENTS.md","docs/ContextContinuity/context.md","../outside.txt",["C:","private.txt"].join("/"),"src/../auth.json","src\\file.ts",".git/config","evidence-live/image.png"])("rejects private or escaping path %s",path=>{
    expect(()=>assertPublicPath(path)).toThrow();
  });
  test.each(["src/main.ts","server/auth.ts",".github/workflows/check.yml",".gitignore",".env.example","docs/INSTALL.md"])("permits reviewable public path %s",path=>{
    expect(()=>assertPublicPath(path)).not.toThrow();
  });
  test.each(["sk-"+"x".repeat(32),"-----BEGIN "+"PRIVATE KEY-----",["C:","Users","example","private.txt"].join("/"),["G:","Work","private.txt"].join("/"),["C:","Users","example","secret.txt"].join("\\"),["C:","Users","example","secret.txt"].join("\\\\"),"http://"+"127.0.0.1"+":7777/private/workspace"])("blocks sensitive content without echoing its value (case %#)",value=>{
    let message="";
    try{assertPublicText(Buffer.from(value));}catch(error){message=(error as Error).message;}
    expect(message).toMatch(/Release blocked/);expect(message).not.toContain(value);
  });
  test("permits generic environment configuration instructions",()=>{
    expect(()=>assertPublicText(Buffer.from("Set OPENAI_API_KEY in your environment; never commit its value."))).not.toThrow();
  });
});
