import {readFileSync} from "node:fs";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {AmbientReelProvider} from "../src/ds";
import {insertReferenceMention,ReferenceReplacePanel,singleCharacterModelProblem} from "../src/team/ReferenceReplacePanel";
import {PromptField,Thumb} from "../src/ds";
import {h3PromptReferences} from "../src/team/prompt-reference";
import {referenceLooksOrFallback,REFERENCE_LOOK_FALLBACK} from "../src/team/reference-replace";
import type {Call,Project,Workspace} from "../src/team/api";

const props={workspace:{id:"workspace"} as Workspace,project:{id:"project"} as Project,workerId:"worker",call:(async()=>({})) as unknown as Call,canEdit:true,onChanged:()=>{}};
const panel=()=>renderToStaticMarkup(<ReferenceReplacePanel {...props}/>);

describe("Replace character's own fields",()=>{
  it("maps the visible first-image mention to the H3 model token without changing other references",()=>{
    expect(h3PromptReferences("Use @Image 1, not @Image 10; @image 1.")).toBe("Use <Picture 1>, not @Image 10; <Picture 1>.");
  });
  it("prevents one-image models from silently discarding extra references",()=>{
    expect(singleCharacterModelProblem(true,2)).toContain("one character image");
    expect(singleCharacterModelProblem(true,1)).toBeUndefined();
    expect(singleCharacterModelProblem(false,2)).toBeUndefined();
  });
  it("makes the clip and the first character two big, full-width drop zones",()=>{
    const html=panel();
    // Both are the large upload slot; a compact slot would shrink them to the old small box.
    expect(html).not.toContain("ds-upload--compact");
    expect(html.match(/class="ds-upload"/g)).toHaveLength(2);
    expect(html).toContain("Add a character");
    // No tile pair yet: the next box ("Add another character") only comes once a character is there.
    expect(html).not.toContain("ds-uploadpair");
    expect(html).not.toContain("Add a face");
    expect(html).not.toContain("Add another character");
  });
  it("says the longest clip inside the drop zone and no frame note under it",()=>{
    const html=panel();
    // One 81-frame pass is about 3 s at 24 fps; the words stay in the hint line.
    expect(html).toContain("Drop a video, up to 25 s");
    expect(html).not.toContain("first 81 frames");
  });
  it("shows the Replace loop, not the video section's clip",()=>{
    // Replace character has its own before → after loop; the section's loop is another tool.
    const html=renderToStaticMarkup(<AmbientReelProvider src="/reels/wan22-t2v-5b.mp4"><ReferenceReplacePanel {...props}/></AmbientReelProvider>);
    expect(html).toContain("/reels/feature-replace.mp4");
    expect(html).not.toContain("/reels/wan22-t2v-5b.mp4");
  });
  it("offers the library only through the one shared button, with saved characters inside it",()=>{
    const source=readFileSync("src/team/ReferenceReplacePanel.tsx","utf8");
    // Every "Choose from library" here is the shared LibraryChoice; nothing assembles its own.
    expect(source).not.toContain('label="Library"');
    expect(source.match(/<LibraryChoice/g)?.length).toBe(2);
    // Saved characters are a part of that list, not a second button.
    expect(source).not.toContain("Use saved character");
    expect(source).toContain("Saved character");
  });
  it("inserts an optional reference at the current caret without replacing the prompt",()=>{
    expect(insertReferenceMention("Replace the person.",12,12,"@Image 1")).toEqual({value:"Replace the @Image 1 person.",caret:21});
    expect(insertReferenceMention("Use this",4,8,"@Image 2")).toEqual({value:"Use @Image 2",caret:12});
  });
  it("shows prompt mentions as accent tokens and keeps reference tools icon-only",()=>{
    const prompt=renderToStaticMarkup(<PromptField label="Prompt (optional)" value="Use @Image 1 here" onChange={()=>{}} placeholder="Optional" tokens={["@Image 1"]}/>);
    expect(prompt).toContain("ds-prompt__editor--tokens");
    expect(prompt).toContain("<mark>@Image 1</mark>");
    const thumb=renderToStaticMarkup(<Thumb src="/reference.png" label="Reference 1" onActivate={()=>{}} onRemove={()=>{}}/>);
    expect(thumb).toContain('aria-label="Full view"');
    expect(thumb).toContain('aria-label="Remove Reference 1"');
    expect(thumb).not.toContain("&gt;Remove&lt;");
  });
  it("uses visual references when optional image descriptions are unavailable",()=>{
    expect(referenceLooksOrFallback(["@Image 1"],{})).toEqual({looks:{},note:REFERENCE_LOOK_FALLBACK});
    expect(referenceLooksOrFallback(["@Image 1"],{"@Image 1":"short dark hair"})).toEqual({looks:{"@Image 1":"short dark hair"},note:""});
    const source=readFileSync("src/team/ReferenceReplacePanel.tsx","utf8");
    expect(source).toContain('label="Prompt (optional)"');
    expect(source).not.toContain("if(!edited)setPrompt");
  });
  it("offers one optional 5-frame test below the main action",()=>{
    const source=readFileSync("src/team/ReferenceReplacePanel.tsx","utf8");
    expect(source).toContain('label="5-frame test render"');
    expect(source).not.toContain('label="Scene frame experiment"');
    expect(source).not.toContain('label="Use a scene frame"');
    expect(source).toContain('onClick={()=>void generate()}/>{frameTestToggle}</>');
    expect(source).toContain("afterCta={frameTestToggle}");
  });
});
