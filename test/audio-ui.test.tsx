import {readFileSync} from "node:fs";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {AudioStudio} from "../src/team/audio";

describe("audio workspace UI",()=>{
  it("renders only the controls used by the default preserve operation",()=>{
    const html=renderToStaticMarkup(<AudioStudio userId="fixture-user" workspace={{id:"workspace",name:"Shared",role:"creator"}} project={{id:"project",name:"Film"}} call={async()=>({items:[],nextCursor:null}) as never} requirements={{state:"ready",missing:[],versions:{ffmpeg:"ffmpeg version 7.1",ffprobe:"ffprobe version 7.1"},instructions:""}} onChanged={()=>{}}/>);
    expect(html).toContain("cf-production__content");
    expect(html).toContain("Type</span><span class=\"ds-hero__word\"");
    expect(html).toContain("Preserve source audio");
    expect(html).toContain("Advanced settings");
    expect(html).toContain("I have permission to use this voice.");
    expect(html).toContain("Record microphone");
    expect(html).toContain("Video or portrait reference");
    expect(html).toContain("Voice or audio");
    expect(html).toContain("Choose from library");
    expect(html).toContain("Examples");
    expect(html).not.toContain("Record up to 60 seconds locally");
    expect(html).toContain("Source audio stream");
    expect(html).toContain("Timeline fit");
    expect(html).not.toContain("Project video");
    expect(html).not.toContain("External audio</span>");
    expect(html).not.toContain("Trim start");
  });

  it("keeps audio in primary navigation and workspace guidance in the top info system",()=>{
    expect(readFileSync("src/team/TeamApp.tsx","utf8")).toContain('{label:"Audio",href:"#audio"}');
    const studio=readFileSync("src/team/audio/AudioStudio.tsx","utf8");
    expect(studio).toContain('<WorkflowDescription title="Audio">');
    expect(studio).toContain('<Collapsible title="Advanced settings">');
    expect(studio).toContain('<ExampleTiles kind="video"/>');
    expect(studio).toContain('"Create lip-sync"');
    expect(studio).toContain('busy={working}');
    expect(studio).toContain('working?"Generating"');
    expect(studio).toContain('!!operation&&audioOperationActive(operation.state)');
    expect(studio).toContain("<SystemVoicePanel");
    expect(readFileSync("src/team/audio/MicrophonePanel.tsx","utf8")).toContain("secondaryAction");
    const app=readFileSync("src/team/TeamApp.tsx","utf8");
    expect(app).toContain("useAudioInLipSync(assetId:string,imageAssetId?:string)");
    expect(app).toContain('input.type==="image"&&input.required');
    expect(readFileSync("src/team/audio/SystemVoicePanel.tsx","utf8")).not.toContain("<InfoButton");
  });
});
