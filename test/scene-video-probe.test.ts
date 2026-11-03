import {existsSync,readFileSync} from "node:fs";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {describe,expect,it} from "vitest";
import sharp from "sharp";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import path from "node:path";
import {compileLocal} from "../src/capabilities/compile";
import {validateCapability} from "../src/capabilities/validate";
import {buildSceneVideoProbeGraph,SCENE_VIDEO_PROBE_ID} from "../src/capabilities/replace-video-probe";
import {cleanSourceRule} from "../src/capabilities/clean";
import {admitSceneReference,verifySceneReference} from "../server/scene-probe-admission";
import type {CapabilityBundle,Invocation} from "../src/capabilities/types";
const root=`native-workflows/${SCENE_VIDEO_PROBE_ID}`,bundle={manifest:JSON.parse(readFileSync(root+"/manifest.json","utf8")),template:JSON.parse(readFileSync(root+"/template.api.json","utf8"))} as CapabilityBundle;
const old=JSON.parse(readFileSync("native-workflows/replace-video-frame-probe-single/template.api.json","utf8"));

describe("intact scene image into the bounded SCAIL video model",()=>{
  it("changes only the shared mode value and keeps all mask/conditioning consumers consistent",()=>{
    const invocation={capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:"comfyfield-five-frames.mp4",scene_image:"comfyfield-pinned-scene.png"},controls:{seed:2},audioPolicy:"mute" as const};
    const prior=compileLocal(bundle,invocation),replacement=compileLocal(bundle,{...invocation,controls:{seed:2,replacement_mode:true}}),animation=compileLocal(bundle,{...invocation,controls:{seed:2,replacement_mode:false}});
    expect(prior).toEqual(animation);
    expect(buildSceneVideoProbeGraph(old)["213:203"].inputs.value).toBe(false);
    expect(Object.keys(replacement).filter(id=>JSON.stringify(replacement[id])!==JSON.stringify(animation[id]))).toEqual(["213:203"]);
    const expected=structuredClone(replacement);expected["213:203"].inputs.value=false;expect(animation).toEqual(expected);
    for(const id of ["213:114","213:197","213:199"])expect(animation[id].inputs.replacement_mode).toEqual(["213:203",0]);
  });
  it.each([[1,"0,1"],[2,"0,1"],[1,"1"]])("keeps exact reference/vision/mask correspondence with seed %s and people %s",(seed,people)=>{
    expect(validateCapability(bundle)).toEqual([]);
    const input="comfyfield-pinned-scene.png",g=compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:"comfyfield-five-frames.mp4",scene_image:input},controls:{prompt:"Keep the scene.",seed,people},audioPolicy:"mute"});
    expect(g["30"].inputs.image).toBe(input);
    expect(g["scene:fit"].inputs).toEqual({image:["30",0],upscale_method:"bicubic",width:["213:163",0],height:["213:163",1],crop:"disabled"});
    expect(g["213:114"].inputs.reference_image).toEqual(["scene:fit",0]);expect(g["213:76"].inputs.image).toEqual(["scene:fit",0]);
    expect(g["213:198"].inputs.images).toEqual(["scene:fit",0]);
    for(const id of ["213:197","213:199"]){expect(g[id].inputs.ref_track_data).toEqual(["213:198",0]);expect(g[id].inputs.object_indices).toEqual(["scene:people",0]);}
    expect(g["scene:people"].inputs.value).toBe(people);expect(g["213:114"].inputs.reference_image_mask).toEqual(["213:199",1]);
    expect(g["213:114"].inputs.length).toBe(5);expect(g["213:19"].inputs.noise_seed).toBe(seed);
    for(const [id,n]of Object.entries(old) as Array<[string,any]>)if(/UNETLoader|LoraLoader|VAELoader|ModelSampling|CFGGuider|BasicScheduler/.test(n.class_type))expect(g[id]).toEqual(n);
    expect(Object.values(g).some(n=>/ImageCropToMask|SaveVideo|CreateVideo/.test(n.class_type))).toBe(false);
    expect(Object.values(g).filter(n=>n.class_type==="SaveImage")).toHaveLength(2);
    expect(cleanSourceRule(bundle.manifest)).toEqual({sourceInput:"source_video",fps:24});
  });
  it("requires a chosen scene image; never falls back to the old character reference",()=>{
    expect(()=>compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:"comfyfield-short.mp4"},controls:{},audioPolicy:"mute"})).toThrow("Missing asset: scene_image");
    const drift=structuredClone(old);drift["213:198"].class_type="UnexpectedTracker";expect(()=>buildSceneVideoProbeGraph(drift)).toThrow("class drift");
  });
  it("freezes an existing image and refuses a different asset or changed bytes before submission",async()=>{
    const tempRoot=process.env.COMFYFIELD_TEST_TEMP_ROOT??(existsSync((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/ComfyField")?(process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/ComfyField":tmpdir());
    const folder=await mkdtemp(path.join(tempRoot,"scene-reference-test-")),file=path.join(folder,"scene.png");
    try{
      const png=await sharp({create:{width:64,height:48,channels:3,background:"orange"}}).png().toBuffer();await writeFile(file,png);
      const asset={id:"scene-id",storage_key:"scene-key",media_type:"image",sha256:createHash("sha256").update(png).digest("hex"),bytes:png.length};
      const sceneReference=await admitSceneReference(asset,file),invocation={inputs:{scene_image:asset.id},sceneReference} as unknown as Invocation;
      expect(sceneReference).toMatchObject({assetId:asset.id,sha256:asset.sha256,width:64,height:48});
      await expect(verifySceneReference(bundle.manifest.id,invocation,[asset],async()=>file)).resolves.toBeUndefined();
      await expect(verifySceneReference(bundle.manifest.id,{...invocation,inputs:{scene_image:"different"}},[asset],async()=>file)).rejects.toThrow("changed");
      await expect(verifySceneReference(bundle.manifest.id,{...invocation,sceneReference:undefined},[asset],async()=>file)).rejects.toThrow("changed");
      await writeFile(file,Buffer.from("changed"));
      await expect(verifySceneReference(bundle.manifest.id,invocation,[asset],async()=>file)).rejects.toThrow("bytes changed");
      await expect(admitSceneReference(asset,file)).rejects.toThrow("changed");
    }finally{await rm(folder,{recursive:true,force:true});}
  });
});
