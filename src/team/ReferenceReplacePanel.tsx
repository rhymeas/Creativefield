import {insertReferenceMention} from "./prompt-reference";
import {WorkflowDescription} from "./workflow-info";
import {useEffect,useRef,useState,type ReactNode} from "react";
import {Button,FrameStrip,GenerateButton,Meta,ModelCard,Notice,PromptField,Thumb,ToggleRow,Toolbar,UploadPair,UploadSlot} from "../ds";
import {assetUrl,composerAssets,mergeAssets,workspacePath,type Asset,type AssetPage,type Call,type CharacterRecord,type Project,type Workspace} from "./api";
import {characterPath} from "./characters/state";
import {beginChain,chainKey,clearChain,readChain,runReplaceChain,saveChain,type ChainRecord,type SavedInput} from "./replace-chain";
import {LibraryChoice} from "./LibraryChoice";
import {TeamChoice} from "./TeamChoice";
import {activeRun} from "./state";
import {plainProblem} from "./problems";
import type {Run} from "./api";
import {NO_REEL,reelForManifest} from "./reels";
import {mentionLabel,type ReferencePlan} from "../workflow/reference-prompt";
import {buildReplaceSteps,referenceLooksOrFallback,REFERENCE_LOOK_FALLBACK,withIndexes,freePerson,personLabel,placeFace,removeFace,MAX_PEOPLE,REPLACE_CAPABILITY,type PlannedPerson} from "./reference-replace";
import {SCAIL_MAX_FRAMES} from "../capabilities/replace";
import {capabilityHasControl} from "../capabilities/lookup";
import {ReplaceVideoFrames} from "./ReplaceVideoFrames";
import {sceneAnchorOrder} from "./scene-anchor-order";
import {resolveImageReference} from "../image/image-reference";
import {videoProbeDraft} from "./scene-anchor-state";
/** The longest clip Replace character renders, in passes of 81 frames (about 25 s at 24 fps); only a longer clip is cut. */
const PROVEN_FRAMES=SCAIL_MAX_FRAMES;
/** Clips are made ready at 24 fps, so a 60 fps phone clip keeps its seconds. */
const CLIP_FPS=24;
import {TrimToFit,trimToFirst} from "./TrimToFit";

type PlanAnswer={references:string[];plan:ReferencePlan|null;source:string;problems:string[]};
/** One face: the image and which person (counted from the left) it replaces.
 *  `clothes` is an optional picture of what that person becomes: a garment or a product. */
type Character={asset:string;index:number;name?:string;faceEdit?:string;outfit?:string;clothes?:string};
const MAX_CHARACTERS=MAX_PEOPLE,VIDEO=mentionLabel("video",1);
/** What the video drop zone says: the proven length at the 16 fps the trim makes. */
const CLIP_HINT=`Drop a video, up to ${Math.floor(PROVEN_FRAMES/CLIP_FPS)} s`;

/** A saved character's portrait: its first reference. Replace needs one image, so the rest of the pack is not used. */
export function characterPortrait(record:CharacterRecord,projectId:string):string|undefined{
  const first=[...record.referencePack.references].sort((a,b)=>a.ordinal-b.ordinal)[0];
  if(!first||record.referencePack.version!==1||!record.elementId||first.ordinal!==0)return undefined;
  if(first.assetMediaType!=="image"||(first.assetProjectId!==null&&first.assetProjectId!==projectId))return undefined;
  return first.assetId;
}

export {insertReferenceMention} from "./prompt-reference";

/** Replace character: the video, the characters, an optional prompt, Generate. Nothing else on screen.
 * References are always handed to the model. Prompt mentions only add an explicit mapping when the person wants one.
 * A clothes or product picture per character is optional, behind its own switch.
 * When a sentence cannot be read, the pictures still run in their visible left-to-right order. */
/** A Replace character model on Comfy Cloud: one pass, one clip and one character picture. */
export type CloudReplaceModel={id:string;version:string;title:string;note:string};

export function singleCharacterModelProblem(oneRun:boolean,count:number):string|undefined {
  return oneRun&&count>1?"This model accepts one character image. Choose a model that supports multiple characters or remove the extra references.":undefined;
}

export function ReferenceReplacePanel({workspace,project,workerId,call,canEdit,onChanged,onCloudDraft,top,cloud}:{workspace:Workspace;project:Project;workerId:string;call:Call;canEdit:boolean;onChanged:()=>void;onCloudDraft?:(d:{workspaceId:string;projectId:string;inputs:Record<string,string>;prompt:string})=>void;top?:ReactNode;/** The Replace models this run target offers, with the worker and route they run on; more than one shows a Model row.
   *  SCAIL-2 on this computer keeps its own multi-step chain; every other model is one run per clip. */cloud?:{workerId:string;routeId:string;models:CloudReplaceModel[]}}){
  // A chain this tab saved before a reload: the same video, faces and words, at the step it stopped at.
  const storage=typeof sessionStorage==="undefined"?null:sessionStorage,key=chainKey("replace",workspace.id,project.id);
  const [chain,setChain]=useState<ChainRecord|null>(()=>readChain(storage,key));
  const [sceneDraft]=useState(()=>!cloud||cloud.routeId==="local"?videoProbeDraft(storage,workspace.id,project.id,workerId):null);
  const [fiveFrameTest,setFiveFrameTest]=useState(false);
  const [assets,setAssets]=useState<Asset[]>([]),[video,setVideo]=useState(()=>sceneDraft?.video??chain?.input.video??""),[characters,setCharacters]=useState<Character[]>(()=>sceneDraft?.faces??chain?.input.faces?.map(face=>({...face}))??[]);
  const [records,setRecords]=useState<CharacterRecord[]>([]);
  const [prompt,setPrompt]=useState(()=>sceneDraft?.prompt??chain?.input.prompt??""),[extras,setExtras]=useState(()=>!sceneDraft&&!!chain?.input.addPrompt),[edited,setEdited]=useState(()=>sceneDraft?!!sceneDraft.prompt:!!chain?.input.prompt),[busy,setBusy]=useState(""),[error,setError]=useState("");
  useEffect(()=>{onCloudDraft?.({workspaceId:workspace.id,projectId:project.id,inputs:{source_video:video,reference_image:characters[0]?.asset??'',reference_image_2:characters[1]?.asset??''},prompt});},[workspace.id,project.id,video,characters,prompt,onCloudDraft]);
  const [promptNote,setPromptNote]=useState(""),[referenceNote,setReferenceNote]=useState(""),[,setDoing]=useState(""),[clipProblem,setClipProblem]=useState(""),[trimming,setTrimming]=useState(false),[original,setOriginal]=useState(""),[usedSeconds,setUsedSeconds]=useState(0);
  const promptArea=useRef<HTMLTextAreaElement>(null);
  const alive=useRef(true),assetEpoch=useRef(0),loadingAssetsRef=useRef(false);
  const [assetCursor,setAssetCursor]=useState<string|null>(null),[loadingAssets,setLoadingAssets]=useState(false),[assetPageError,setAssetPageError]=useState("");
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{const epoch=++assetEpoch.current;setAssetCursor(null);setAssetPageError("");void composerAssets(call,workspace.id,project.id,[video,...characters.map(c=>c.asset)].filter(Boolean)).then(page=>{if(epoch===assetEpoch.current){setAssets(page.items);setAssetCursor(page.nextCursor);}}).catch(e=>{if(epoch===assetEpoch.current)setError((e as Error).message);});return()=>{assetEpoch.current++;};},[call,workspace.id,project.id]);
  async function moreAssets(){if(!assetCursor||loadingAssetsRef.current)return;const epoch=assetEpoch.current;loadingAssetsRef.current=true;setLoadingAssets(true);setAssetPageError("");try{const page=await call<AssetPage>(workspacePath(workspace.id,`assets?projectId=${encodeURIComponent(project.id)}&cursor=${encodeURIComponent(assetCursor)}`));if(epoch===assetEpoch.current){setAssets(old=>mergeAssets(old,page.items));setAssetCursor(page.nextCursor);}}catch{if(epoch===assetEpoch.current)setAssetPageError("Could not load more files. Try again.");}finally{loadingAssetsRef.current=false;if(alive.current)setLoadingAssets(false);}}
  useEffect(()=>{void call<CharacterRecord[]>(characterPath(workspace.id,project.id)).then(list=>{if(alive.current)setRecords(list.filter(record=>record.projectId===project.id));}).catch(()=>{});},[call,workspace.id,project.id]);

  // The clip is measured as soon as it is chosen, so a clip that is too long is said so here and not after Generate.
  useEffect(()=>{setClipProblem("");if(!video||!ready.current.has(video))return;let live=true;
    void call<{frames:number;seconds:number}>(workspacePath(workspace.id,`replace-clip-check?assetId=${encodeURIComponent(video)}`)).then(check=>{if(live&&alive.current&&check.frames>PROVEN_FRAMES)setClipProblem(`This clip is ${Math.round(check.seconds)} s. Replace character takes ${PROVEN_FRAMES} frames, about ${Math.floor(PROVEN_FRAMES/24)} s.`);}).catch(e=>{if(live&&alive.current&&(e as {status?:number}).status===422)setClipProblem((e as Error).message);});
    return()=>{live=false;};
  },[call,workspace.id,video,busy]);
  /* Selection only normalizes timing; it never starts an inpainting model.
     Run admission owns overlay removal, once the user presses Generate. */
  const ready=useRef(new Set<string>());
  useEffect(()=>{if(!video||ready.current.has(video)||busy)return;const chosen=video;
    void guard("clean",async()=>{const clean=await call<Asset>(workspacePath(workspace.id,"video-sources/prepare"),"POST",{projectId:project.id,assetId:chosen,clean:false,fps:CLIP_FPS});
      ready.current.add(clean.id);if(!alive.current)return;if(clean.id!==chosen){setVideo(clean.id);void composerAssets(call,workspace.id,project.id,[]).then(page=>{if(alive.current)setAssets(old=>mergeAssets(page.items,old));}).catch(()=>{});}});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[video]);
  // A clip that is too long is used, not refused: its first part is cut at once, and "Choose another part" opens the trim.
  useEffect(()=>{if(!clipProblem||!video||busy)return;let live=true;
    void guard("trim",async()=>{const cut=await trimToFirst(call,workspace.id,project.id,video,PROVEN_FRAMES);if(!live||!alive.current)return;setOriginal(video);setUsedSeconds(cut.seconds);setVideo(cut.id);void composerAssets(call,workspace.id,project.id,[]).then(page=>{if(alive.current)setAssets(old=>mergeAssets(page.items,old));}).catch(()=>{});});
    return()=>{live=false;};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[clipProblem]);
  async function upload(file:File,kind:"image"|"video"){
    const form=new FormData();form.append("file",file);
    const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${encodeURIComponent(project.id)}&kind=${kind}`),"POST",form);
    setAssets(old=>[asset,...old.filter(a=>a.id!==asset.id)]);onChanged();return asset.id;
  }
  async function guard(task:string,work:()=>Promise<void>){setBusy(task);setError("");try{await work();}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy("");}}
  async function chooseDropped(id:string,kind:"image"|"video",apply:(asset:Asset)=>void){
    await guard("select",async()=>{
      const asset=kind==="image"?await resolveImageReference(id,assets,workspace.id,project.id,call):assets.find(a=>a.id===id)??await call<Asset>(workspacePath(workspace.id,`assets/${encodeURIComponent(id)}`));
      if(!asset||asset.id!==id||asset.project_id!==project.id||asset.media_type!==kind||(kind==="video"&&!['video/mp4','video/webm','video/quicktime'].includes(asset.content_type)))throw new Error("Choose compatible media from this project.");
      if(!alive.current)return;
      setAssets(old=>[asset,...old.filter(item=>item.id!==asset.id)]);apply(asset);
    });
  }
  // A new clip, face or sentence is a new request: the saved chain no longer applies, and its keys must not answer.
  const changed=()=>{setChain(null);clearChain(storage,key);};
  const setClothes=(i:number,clothes:string|undefined)=>{setCharacters(old=>old.map((x,j)=>j===i?{...x,clothes}:x));changed();};
  const addCharacter=(asset:string,name?:string)=>{setCharacters(old=>old.length>=MAX_CHARACTERS||old.some(character=>character.asset===asset)?old:[...old,{asset,index:freePerson(old),...(name?{name}:{})}]);changed();};
  const mentionCharacter=(i:number)=>{const area=promptArea.current,label=mentionLabel("image",i+1),inserted=insertReferenceMention(prompt,area?.selectionStart??prompt.length,area?.selectionEnd??prompt.length,label);setPrompt(inserted.value);setEdited(true);setPromptNote("");changed();requestAnimationFrame(()=>{promptArea.current?.focus();promptArea.current?.setSelectionRange(inserted.caret,inserted.caret);});};

  /** Reads the sentence, then runs each face's steps in order. A chain saved before a
   *  reload keeps its request id and its finished steps, so Generate carries on at the step it stopped at. */
  const [cloudModel,setCloudModel]=useState("");
  const model=cloud?.models.find(m=>m.id===cloudModel)??cloud?.models[0];
  /** A one-run model makes the whole clip in one run, with the first character. */
  const oneRun=!!model&&!(cloud?.routeId==="local"&&model.id===REPLACE_CAPABILITY.id);
  const generateCloud=()=>guard("run",async()=>{
    if(!cloud||!model)return;
    const limitProblem=singleCharacterModelProblem(true,characters.length);if(limitProblem)throw new Error(limitProblem);
    // The local jutsu route makes one 81-frame window: a longer clip runs on its first part.
    const source=model.id==="local-jutsu-replace"?(await trimToFirst(call,workspace.id,project.id,video,81)).id:video;
    let run=await call<Run>(workspacePath(workspace.id,"runs"),"POST",{projectId:project.id,workerId:cloud.workerId,idempotencyKey:`cloud-replace-${crypto.randomUUID()}`,capabilityId:model.id,version:model.version,routeId:cloud.routeId,inputs:{source_video:source,character_image:characters[0].asset},elementInputs:{},controls:{prompt:prompt.trim()},audioPolicy:"mute"});
    onChanged();
    while(activeRun(run.state)&&alive.current){await new Promise(r=>setTimeout(r,3000));run=await call<Run>(workspacePath(workspace.id,`runs/${encodeURIComponent(run.id)}`));}
    onChanged();
    if(run.state==="failed")throw new Error(run.error??"The cloud run failed.");
  });
  /** Reads the sentence and the pictures into the steps of one request. */
  async function plan(){
    let chars=characters;
    const said=prompt.trim();
    // A saved chain already carries the sentence it was built from; reading it again could change the chain.
    if(said&&!chain){
      const answer=await call<PlanAnswer>(workspacePath(workspace.id,"reference-plan"),"POST",{prompt:said,faces:chars.length});
      // A sentence the planner cannot read is never dropped in silence: it stays in the field and says why.
      if(alive.current)setPromptNote(answer.problems.join(" "));
      if(answer.plan&&!answer.problems.length){
        const read=withIndexes(answer.plan),fromWords=chars.map((_,i)=>read.find(p=>p.face===mentionLabel("image",i+1)));
        const real=(v?:string)=>!!v&&/[a-z]{2}/i.test(v);
        chars=chars.map((c,i)=>{const p=fromWords[i];return p?{...c,...(real(p.faceEdit)?{faceEdit:p.faceEdit}:{}),...(real(p.outfit)?{outfit:p.outfit}:{})}:c;});
        // A sentence can name the person too; a person another face already has swaps, so two faces never share one.
        fromWords.forEach((p,i)=>{if(p)chars=placeFace(chars,i,p.index);});
      }
    }
    const input:SavedInput={video,prompt,addPrompt:extras,faces:chars.map(c=>({asset:c.asset,index:c.index,...(c.name?{name:c.name}:{}),...(extras&&c.clothes?{clothes:c.clothes}:{})}))};
    const people:PlannedPerson[]=chars.map((c,i)=>({target:personLabel(c.index),face:mentionLabel("image",i+1),index:c.index,...(c.faceEdit?{faceEdit:c.faceEdit}:{}),...(c.outfit?{outfit:c.outfit}:{}),...(extras&&c.clothes?{clothes:c.clothes}:{})}));
      const media={[VIDEO]:video,...Object.fromEntries(chars.map((c,i)=>[mentionLabel("image",i+1),c.asset]))};
      // Descriptions can strengthen the prompt, but the actual image inputs remain sufficient to start a run.
      // A failed local vision helper therefore falls back visibly to the references instead of blocking them.
      let looks:Record<string,string>={};
      try{looks=await call<{looks:Record<string,string>}>(workspacePath(workspace.id,"reference-describe"),"POST",{projectId:project.id,people:chars.map((c,i)=>({label:mentionLabel("image",i+1),assetId:c.asset,where:personLabel(c.index)}))}).then(answer=>answer.looks??{});const fallback=referenceLooksOrFallback(chars.map((_,i)=>mentionLabel("image",i+1)),looks);looks=fallback.looks;if(alive.current)setReferenceNote(fallback.note);}
      catch{looks={};if(alive.current)setReferenceNote(REFERENCE_LOOK_FALLBACK);}
    const {steps}=buildReplaceSteps({video:VIDEO,people,keep:"the movement"},people,media,said||undefined,looks);
    return {input,steps};
  }
  /* The preview action is offered only after its control is declared by the pack.
     An unsupported preview flag must never turn into an accidental full run. */
  const [seen,setSeen]=useState<Array<{src:string;label:string}>>([]);
  const SEEN_LABELS:Record<string,string>={reference_frame:"Reference frame",reference_mask:"Reference mask",source_mask:"Clip mask",first_frame:"First frame"};
  const preview=()=>guard("preview",async()=>{
    setSeen([]);
    const planned=await plan();
    const steps=planned.steps.map(step=>({...step,controls:{...step.controls,preview:true}}));
    const record=beginChain({requestId:crypto.randomUUID(),attempt:1,input:planned.input,steps});
    const done=await runReplaceChain({call,workspaceId:workspace.id,projectId:project.id,workerId,record,storage:null,onChanged,alive:()=>alive.current});
    const last=done.runIds[steps[steps.length-1].id];
    if(!last)return;
    const run=await call<Run&{extras?:Array<{role:string;assetId:string}>}>(workspacePath(workspace.id,`runs/${encodeURIComponent(last)}`));
    const pictures=characters.map((c,i)=>({src:assetUrl(workspace.id,c.asset),label:`Picture ${i+1}`}));
    if(alive.current)setSeen([...pictures,...(run.extras??[]).filter(e=>SEEN_LABELS[e.role]).map(e=>({src:assetUrl(workspace.id,e.assetId),label:SEEN_LABELS[e.role]}))]);
  });
  const generate=()=>oneRun?generateCloud():guard("run",async()=>{
    let record=chain;
    if(!record){const planned=await plan();record=beginChain({requestId:crypto.randomUUID(),attempt:1,input:planned.input,steps:planned.steps});saveChain(storage,key,record);}
    if(alive.current)setChain(record);
    const done=await runReplaceChain({call,workspaceId:workspace.id,projectId:project.id,workerId,record,storage,key,onChanged,onStep:label=>{if(alive.current)setDoing(label);},
      onSaved:saved=>{if(alive.current)setChain(saved);},alive:()=>alive.current});
    if(done.stepIndex>=done.steps.length){clearChain(storage,key);if(alive.current)setChain(null);}
  });

  const reason=!canEdit?"Sign in to make videos.":!video?"Add your video.":busy==="clean"?"Getting your clip ready…":busy==="trim"?"Cutting your clip to fit…":clipProblem?"Cutting your clip to fit…":!characters.length?"Add a character.":singleCharacterModelProblem(oneRun,characters.length);
  const locked=!!busy||!canEdit;
  const localFrameProbe=characters.length>=1&&characters.length<=2&&(!cloud||cloud.routeId==="local");
  const scene=sceneAnchorOrder(characters,prompt,edited),sceneReferences=scene.references;
  const probeProblem=fiveFrameTest&&localFrameProbe?(characters.length===2?scene.problem:![0,1].includes(scene.targets[0])?"The short test supports the first or second source person.":""):"";
  const videos=assets.filter(a=>a.media_type==="video");
  const libraryImages=assets.filter(a=>a.media_type==="image"&&!characters.some(c=>c.asset===a.id));
  // Saved characters with a portrait this project can use and that is not on a face already.
  const cast=records.flatMap(record=>{const asset=characterPortrait(record,project.id);return asset&&!characters.some(c=>c.asset===asset)?[{record,asset}]:[];});

  /* One list for "Choose from library": saved characters first, then the project's pictures. */
  const libraryOptions=[...cast.map(({record,asset})=>({value:`character:${asset}`,label:record.name,note:"Saved character",preview:{src:assetUrl(workspace.id,asset)}})),...libraryImages.map(a=>({value:a.id,label:a.name,preview:{src:assetUrl(workspace.id,a.id)}}))];
  const addFromLibrary=(value:string)=>{if(value.startsWith("character:")){const asset=value.slice("character:".length);addCharacter(asset,cast.find(c=>c.asset===asset)?.record.name);}else addCharacter(value);};
  const frameTestToggle=localFrameProbe?<ToggleRow label="5-frame test render" checked={fiveFrameTest} disabled={locked} onChange={setFiveFrameTest}/>:null;

  return <div className="cf-form"><WorkflowDescription title="Replace character"><Meta>Choose the source clip and character references. Reference stills and masks are intermediate inputs; identity, motion and overlay cleanup require quality review.</Meta></WorkflowDescription>
    {top}
    {/* Replace character has no loop of its own, so it shows none rather than the video section's clip. */}
    <ModelCard title="Replace characters" subtitle="Up to four · experimental" video={reelForManifest(REPLACE_CAPABILITY.id)??NO_REEL}/>
    {/* The clip is this screen's main input, so its drop zone is the big one and the library sits below it. */}
    <UploadSlot label="Your video" hint={CLIP_HINT} accept="video/mp4,video/webm,video/quicktime" kinds={["video"]} previewKind="video" preview={video?assetUrl(workspace.id,video):null} removeLabel="Remove your video" disabled={locked}
      onAsset={id=>void chooseDropped(id,"video",asset=>{setOriginal("");setUsedSeconds(0);setVideo(asset.id);changed();})} onFile={file=>{setOriginal("");setUsedSeconds(0);if(file)void guard("upload",async()=>{setVideo(await upload(file,"video"));changed();});else{setVideo("");changed();}}}/>
    {(videos.length>0||!!assetCursor)&&<LibraryChoice onLoadMore={assetCursor?()=>void moreAssets():undefined} loadingMore={loadingAssets} loadMoreError={assetPageError} chosen={!!video} value={video} disabled={locked} options={videos.map(a=>({value:a.id,label:a.name,preview:{src:assetUrl(workspace.id,a.id),video:true}}))} onChange={id=>{setOriginal("");setUsedSeconds(0);setVideo(id);changed();}}/>}
    {/* No character yet: one big box like the video. Once there is one, the characters sit side by side and the next box invites another. */}
    {characters.length===0
      ?<UploadSlot label="Add a character" hint="Drop a file or choose from this device" accept="image/png,image/jpeg,image/webp" kinds={["image"]} disabled={locked} onAsset={id=>void chooseDropped(id,"image",asset=>addCharacter(asset.id))} onFile={file=>{if(file)void guard("upload",async()=>addCharacter(await upload(file,"image")));}}/>
      :<UploadPair>
        {characters.map((c,i)=>{const name=c.name??`Character ${i+1}`,mention=mentionLabel("image",i+1);
          return <Thumb key={c.asset} src={assetUrl(workspace.id,c.asset)} label={`${name} · add ${mention} to prompt`} badge={mention} disabled={locked} onActivate={()=>mentionCharacter(i)} onRemove={()=>{setCharacters(old=>removeFace(old,i));changed();}}/>;})}
        {characters.length<MAX_CHARACTERS&&<UploadSlot tile label="Add another character" hint="" accept="image/png,image/jpeg,image/webp" kinds={["image"]} disabled={locked} onAsset={id=>void chooseDropped(id,"image",asset=>addCharacter(asset.id))} onFile={file=>{if(file)void guard("upload",async()=>addCharacter(await upload(file,"image")));}}/>}
      </UploadPair>}
    {characters.length<MAX_CHARACTERS&&(libraryOptions.length>0||!!assetCursor)&&<LibraryChoice onLoadMore={assetCursor?()=>void moreAssets():undefined} loadingMore={loadingAssets} loadMoreError={assetPageError} value="" disabled={locked} options={libraryOptions} onChange={addFromLibrary}/>}
    <PromptField label="Prompt (optional)" value={prompt} disabled={locked} textareaRef={promptArea} tokens={characters.map((_,i)=>mentionLabel("image",i+1))} onChange={v=>{setPrompt(v);setEdited(true);setPromptNote("");changed();}} placeholder="Say what should change, or click a reference to link it."/>
    {!localFrameProbe&&cloud&&model&&cloud.models.length>1&&<TeamChoice label="Model" display={model.title} value={model.id} disabled={locked} options={cloud.models.map(m=>({value:m.id,label:m.title,note:m.note}))} onChange={setCloudModel}/>}
    {!localFrameProbe&&characters.length>0&&<ToggleRow label="Add clothes or a product" checked={extras} disabled={locked} onChange={v=>{setExtras(v);changed();}}/>}
    {!localFrameProbe&&extras&&characters.length>0&&<UploadPair>{characters.map((c,i)=>{const name=c.name??`Character ${i+1}`;
      return <UploadSlot key={c.asset} tile label="Clothes or product" hint={name} accept="image/png,image/jpeg,image/webp" kinds={["image"]} preview={c.clothes?assetUrl(workspace.id,c.clothes):undefined} previewKind="image" removeLabel={`Remove the clothes or product for ${name}`} disabled={locked} onAsset={id=>void chooseDropped(id,"image",asset=>setClothes(i,asset.id))} onFile={file=>{if(!file)setClothes(i,undefined);else void guard("upload",async()=>setClothes(i,await upload(file,"image")));}}/>;})}</UploadPair>}
    {original&&usedSeconds>0&&<Toolbar><Meta>{`Uses the first ${usedSeconds.toFixed(1)} s of your clip.`}</Meta><Button variant="ghost" disabled={locked} onClick={()=>setTrimming(true)}>Choose another part</Button></Toolbar>}
    <TrimToFit workspace={workspace} project={project} call={call} assetId={original||video} maxFrames={PROVEN_FRAMES} open={trimming&&!!(original||video)} onClose={()=>setTrimming(false)} onTrimmed={id=>{void composerAssets(call,workspace.id,project.id,[]).then(page=>{if(alive.current)setAssets(old=>mergeAssets(page.items,old));}).catch(()=>{});setVideo(id);changed();onChanged();}}/>
    {/* Three different causes, each said once in its own place (rule 36): the run that did not
        start carries the retry, an unread sentence belongs to its own field, and a missing scene
        frame is a requirement of the short test. */}
    {error&&<Notice priority={60} title={plainProblem(error).title||"The replace run didn't start"} actions={<Button variant="secondary" disabled={locked||!!busy} onClick={()=>void generate()}>Try again</Button>} details={error}>{plainProblem(error).text} Nothing was sent twice: trying again reuses the same request.</Notice>}
    {promptNote&&<Notice inline title="The sentence wasn't understood">{promptNote} Rewrite it in the field above, or leave it out; the pictures alone still work.</Notice>}
    {referenceNote&&<Notice inline tone="info" title="Using the visual references directly">{referenceNote}</Notice>}
    {probeProblem&&<Notice inline tone="info" title="Before the short test can run">{probeProblem}</Notice>}
    {!localFrameProbe&&chain&&chain.stepIndex>0&&<Meta>Picks up where your last run stopped.</Meta>}
    {!localFrameProbe&&!oneRun&&seen.length>0&&<FrameStrip label="What the model saw" items={seen}/>}
    {!localFrameProbe&&!oneRun&&!reason&&capabilityHasControl(REPLACE_CAPABILITY.id,"preview")&&<Button disabled={!!busy} onClick={()=>void preview()}>{busy==="preview"?"Making the first frame…":seen.length?"Preview again":"Preview the first frame"}</Button>}
    {fiveFrameTest&&localFrameProbe?<ReplaceVideoFrames key={JSON.stringify([video,sceneReferences,scene.targets,scene.prompt,workerId])} workspace={workspace.id} project={project.id} worker={workerId} video={video} references={sceneReferences} prompt={scene.prompt} personIndex={scene.targets[0]} disabled={locked||!!reason||!!probeProblem} call={call} onChanged={onChanged} onBusy={value=>setBusy(value?"probe":"")} afterCta={frameTestToggle}/>:<><GenerateButton label={busy==="run"?"Generating…":chain?"Continue":"Generate"} busy={busy==="run"} disabled={!!busy||!!reason} disabledReason={reason} onClick={()=>void generate()}/>{frameTestToggle}</>}
  </div>;
}
