import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {execFile,spawnSync} from "node:child_process";
import {promisify} from "node:util";
import {existsSync} from "node:fs";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {colourName,combineMasks,detectOverlayMask,detectOverlayResidue,hintFilters,overlayEnvelope,overlayInpaintGraph,overlayPrompt,overlayWindows,removeOverlays,writeOverlayMaskFile,OVERLAY_SEED,OVERLAY_MAX_COVERAGE,OVERLAY_MIN_COVERAGE} from "../server/video-overlay-mask";

const execute=promisify(execFile);
const binariesAvailable=spawnSync(process.env.FFMPEG_PATH??"ffmpeg",["-version"],{windowsHide:true}).status===0
  &&spawnSync(process.env.FFPROBE_PATH??"ffprobe",["-version"],{windowsHide:true}).status===0;
const font=[(process.env.SystemRoot ?? process.env.WINDIR ?? "") + "/Fonts/arial.ttf",(process.env.SystemRoot ?? process.env.WINDIR ?? "") + "/Fonts/segoeui.ttf","/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find(existsSync);
const label=(text:string,x:number,y:number)=>`drawtext=${font?`fontfile='${font.replace(/:/g,"\\:")}'`:"font=Sans"}:text='${text}':x=${x}:y=${y}:fontsize=16:fontcolor=white`;
/** The picture pans sideways, so every pixel of it moves while the drawn UI stands still. */
const pan="crop=640:480:x='mod(t*60,640)':y=0";
const ffmpeg=process.env.FFMPEG_PATH??"ffmpeg";
type Graph=Record<string,{class_type:string;inputs:Record<string,unknown>}>;
const nodesOf=(graph:Graph,kind:string)=>Object.values(graph).filter(entry=>entry.class_type===kind);

describe("the bounded runs an inpaint takes",()=>{
  it("splits a clip into 81-frame windows and keeps the short one last",()=>{
    expect(overlayWindows(263).map(window=>[window.start,window.count])).toEqual([[0,81],[81,81],[162,81],[243,20]]);
    expect(overlayWindows(48)).toEqual([{start:0,count:48}]);
  });

  it("fits the picture to a Wan envelope: sides by 16, about a quarter of a megapixel",()=>{
    const envelope=overlayEnvelope({width:1206,height:904});
    expect(envelope.width%16).toBe(0);
    expect(envelope.height%16).toBe(0);
    expect(envelope.width*envelope.height).toBeLessThanOrEqual(260000);
    expect(Math.abs(envelope.width/envelope.height-1206/904)).toBeLessThan(0.05);
    // A small clip is never blown up.
    expect(overlayEnvelope({width:320,height:240})).toEqual({width:320,height:240});
  });

  it("names the clip and the mask in the pack's graph and leaves the negative prompt alone",async()=>{
    const graph=await overlayInpaintGraph("comfyfield-source.mp4","comfyfield-mask.mp4");
    const nodes=Object.values(graph);
    expect(nodes.filter(node=>node.class_type==="LoadVideo").map(node=>node.inputs.file).sort()).toEqual(["comfyfield-mask.mp4","comfyfield-source.mp4"]);
    expect(nodes.filter(node=>node.class_type==="CLIPTextEncode").map(node=>node.inputs.text).sort()).toEqual(["Empty background that matches the scene.","blurry, distorted, unstable, text, watermark, logo"]);
    const custom=await overlayInpaintGraph("a.mp4","m.mp4","A plain wall.");
    expect(Object.values(custom).filter(node=>node.class_type==="CLIPTextEncode").map(node=>node.inputs.text)).toContain("A plain wall.");
  });

  it("asks for more than twenty steps and gives a second pass its own seed",async()=>{
    const graph=await overlayInpaintGraph("a.mp4","m.mp4");
    expect(nodesOf(graph,"KSampler")[0].inputs.steps).toBeGreaterThanOrEqual(28);
    expect(nodesOf(graph,"KSampler")[0].inputs.denoise).toBe(1);
    expect(nodesOf(graph,"KSampler")[0].inputs.seed).toBe(OVERLAY_SEED);
    const second=await overlayInpaintGraph("a.mp4","m.mp4","A plain wall.",OVERLAY_SEED+2);
    expect(nodesOf(second,"KSampler")[0].inputs.seed).toBe(OVERLAY_SEED+2);
  });
});

describe("the colour a removal paints with",()=>{
  it("names the picture around the overlay, and asks for that colour",()=>{
    expect(colourName(175,82,46)).toBe("orange");
    expect(colourName(232,232,236)).toBe("white");
    expect(colourName(140,140,144)).toBe("grey");
    expect(colourName(96,96,100)).toBe("dark grey");
    expect(colourName(24,26,30)).toBe("black");
    expect(colourName(28,110,214)).toBe("blue");
    expect(colourName(198,38,56)).toBe("red");
    expect(overlayPrompt({colour:"orange",red:175,green:82,blue:46})).toBe("A plain orange studio wall.");
  });

  it("fills every overlay box with the measured colour and cuts the boxes at the frame",()=>{
    const scene={colour:"orange",red:175,green:82,blue:46};
    const filters=hintFilters([{x:10,y:20,width:30,height:40},{x:600,y:20,width:80,height:10},{x:0,y:0,width:1,height:1}],scene,{width:640,height:480});
    expect(filters.split(",")).toHaveLength(2);
    expect(filters).toContain("drawbox=x=10:y=20:w=30:h=40:color=0xaf522e:t=fill");
    // A box that runs past the right edge stops there, and a box too thin to fill is left out.
    expect(filters).toContain("drawbox=x=600:y=20:w=40:h=10:color=0xaf522e:t=fill");
  });

  it("keeps every pixel either mask marked when a second pass adds its own",()=>{
    const scene={colour:"orange",red:175,green:82,blue:46};
    const one={width:2,height:2,pixels:new Uint8Array([1,0,0,0]),coverage:0.25,regions:[{x:0,y:0,width:1,height:1}],scene};
    const two={width:2,height:2,pixels:new Uint8Array([0,0,1,0]),coverage:0.25,regions:[{x:1,y:1,width:1,height:1}],scene:{colour:"grey",red:128,green:128,blue:128}};
    const both=combineMasks(one,two);
    expect([...both.pixels]).toEqual([1,0,1,0]);
    expect(both.coverage).toBe(0.5);
    expect(both.regions).toHaveLength(2);
    expect(both.scene.colour).toBe("orange");
  });
});

describe.skipIf(!binariesAvailable)("overlays that sit on the picture",()=>{
  let scratch:string,withOverlay:string,plain:string,still:string,badgeAgainstGlyph:string;

  beforeAll(async()=>{
    scratch=await mkdtemp(path.join(tmpdir(),"comfyfield-overlay-mask-"));
    // A picture that moves everywhere, with a still icon, its count, a coloured badge under them and a
    // still caption: the shape of the right-hand column on a phone screen.
    withOverlay=path.join(scratch,"overlay.mp4");
    await execute(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","testsrc2=s=1280x480:r=24:d=2",
      "-vf",`${pan},drawbox=x=584:y=80:w=44:h=44:color=white@1:t=fill,${label("12.4K",582,126)},drawbox=x=584:y=168:w=44:h=44:color=0xff2f6d:t=fill,${label("this is the caption line",40,436)}`,
      "-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p",withOverlay],{windowsHide:true,timeout:60000});
    // The same picture with nothing drawn on it: every pixel changes, so nothing stays still.
    plain=path.join(scratch,"plain.mp4");
    await execute(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","nullsrc=s=320x240:r=24,geq=random(1)*255:128:128",
      "-frames:v","48","-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p",plain],{windowsHide:true,timeout:60000});
    still=path.join(scratch,"still.mp4");
    await execute(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","color=c=#101820:s=320x240:r=24:d=1",
      "-vf",label("caption on a still photo",16,204),"-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p",still],{windowsHide:true,timeout:60000});
    // A still, soft-edged coloured field against a white glyph, on a picture that changes everywhere.
    badgeAgainstGlyph=path.join(scratch,"badge.mp4");
    await execute(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","nullsrc=s=640x480:r=24",
      "-vf","geq=random(1)*255:128:128,drawbox=x=280:y=180:w=48:h=48:color=white@1:t=fill,drawbox=x=328:y=228:w=100:h=100:color=0x1f8a8a:t=fill,boxblur=5:2",
      "-frames:v","48","-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p",badgeAgainstGlyph],{windowsHide:true,timeout:60000});
  },120000);

  afterAll(async()=>{if(scratch)await rm(scratch,{recursive:true,force:true});});

  it("finds the still column and the caption line on a moving picture",async()=>{
    const mask=await detectOverlayMask(withOverlay);
    expect(mask).not.toBeNull();
    expect(mask!.width).toBe(640);
    expect(mask!.height).toBe(480);
    expect(mask!.coverage).toBeGreaterThanOrEqual(OVERLAY_MIN_COVERAGE);
    expect(mask!.coverage).toBeLessThanOrEqual(OVERLAY_MAX_COVERAGE);
    const covered=(x:number,y:number)=>mask!.pixels[y*mask!.width+x]===1;
    const overlaps=(x:number,y:number)=>mask!.regions.some(box=>x>=box.x&&x<box.x+box.width&&y>=box.y&&y<box.y+box.height);
    // The like column (top right) is inside the mask.
    expect(covered(600,100)).toBe(true);
    expect(overlaps(600,100)).toBe(true);
    // So is the caption, whose words change as they are spoken.
    let caption=0,total=0;
    for(let y=436;y<=458;y++)for(let x=40;x<=320;x++){total++;if(covered(x,y))caption++;}
    expect(caption/total).toBeGreaterThan(0.05);
    expect(overlaps(60,445)).toBe(true);
    // The moving picture between them is not.
    expect(covered(300,240)).toBe(false);
  },120000);

  it("takes a coloured badge with the icon column it sits under, as one rectangle",async()=>{
    const mask=await detectOverlayMask(withOverlay);
    const covered=(x:number,y:number)=>mask!.pixels[y*mask!.width+x]===1;
    // The badge has no bright glyph in it: its own colour is what makes it app chrome.
    expect(covered(600,190)).toBe(true);
    const column=mask!.regions.filter(box=>600>=box.x&&600<box.x+box.width&&100>=box.y&&100<box.y+box.height);
    // One rectangle covers the icon, its count and the badge, with no gap between them.
    expect(column).toHaveLength(1);
    expect(column[0].y).toBeLessThanOrEqual(80);
    expect(column[0].y+column[0].height).toBeGreaterThanOrEqual(212);
  },120000);

  it("takes a still coloured field only where a glyph stands against it",async()=>{
    const mask=await detectOverlayMask(badgeAgainstGlyph);
    expect(mask).not.toBeNull();
    const covered=(x:number,y:number)=>mask!.pixels[y*mask!.width+x]===1;
    // The glyph is app chrome, and so are the few pixels of the field that touch it.
    expect(covered(304,204)).toBe(true);
    expect(covered(336,236)).toBe(true);
    // The field's own middle is not: it could be the picture, so it stays.
    expect(covered(378,278)).toBe(false);
    // With no glyph against it, the same field is left alone.
    const alone=path.join(scratch,"field.mp4");
    await execute(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-y","-f","lavfi","-i","nullsrc=s=640x480:r=24",
      "-vf","geq=random(1)*255:128:128,drawbox=x=328:y=228:w=100:h=100:color=0x1f8a8a:t=fill,boxblur=5:2",
      "-frames:v","48","-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p",alone],{windowsHide:true,timeout:60000});
    expect(await detectOverlayMask(alone)).toBeNull();
  },120000);

  it("does not take the wall a first pass painted as an overlay again",async()=>{
    const mask=await detectOverlayMask(badgeAgainstGlyph);
    const residue=await detectOverlayResidue(badgeAgainstGlyph);
    expect(residue).not.toBeNull();
    // The field's edge against the glyph is judged by the glyph, not by the colour it happens to be.
    expect(residue!.coverage).toBeLessThan(mask!.coverage);
  },120000);

  it("finds nothing on a picture that only moves, and nothing on a still photo",async()=>{
    expect(await detectOverlayMask(plain)).toBeNull();
    // A still scene cannot tell an overlay from the picture, so it is left alone.
    expect(await detectOverlayMask(still)).toBeNull();
  },120000);

  it("writes the mask as a grey map the inpaint can read",async()=>{
    const mask=await detectOverlayMask(withOverlay);
    const file=await writeOverlayMaskFile(mask!,path.join(scratch,"mask.pgm"));
    const bytes=await readFile(file);
    const header=`P5\n${mask!.width} ${mask!.height}\n255\n`;
    expect(bytes.subarray(0,header.length).toString("latin1")).toBe(header);
    const body=bytes.subarray(header.length);
    expect(body.length).toBe(mask!.width*mask!.height);
    expect(body[100*mask!.width+600]).toBe(255);
    expect(body[240*mask!.width+300]).toBe(0);
  },120000);

  it("keeps the clip it had when there is no worker, and says why",async()=>{
    const cache=path.join(scratch,"cache-unavailable");
    const removal=await removeOverlays({clip:withOverlay,frames:48,fps:24,cache,worker:undefined,signal:AbortSignal.timeout(120000)});
    expect(removal).toMatchObject({state:"unavailable",total:1});
    expect(removal.mask?.coverage).toBeGreaterThan(0);
    const plainCache=path.join(scratch,"cache-plain");
    const none=await removeOverlays({clip:plain,frames:48,fps:24,cache:plainCache,worker:undefined,signal:AbortSignal.timeout(120000)});
    expect(none.state).toBe("none");
  },120000);
});
