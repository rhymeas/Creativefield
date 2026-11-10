import {lazy,Suspense,useEffect,useRef,useState,type ComponentType} from "react";
import {Block,Button,Canvas,EmptyState,GenerateButton,LazyVideo,LinkButton,MediaCard,Meta,Notice,Page,Panel,PromptField,Row,SegmentedTabs,Split,StatusText} from "../ds";
import {assetUrl,workspacePath,type Call,type Project,type Run,type Workspace} from "./api";
import {nativeWorkflowHash} from "./workflow-navigation";
import type {BlockScreen} from "./navigation";
import {WorkflowDescription} from "./workflow-info";
import type {CapabilityManifestV2} from "../capabilities/types";

type FilmProps={workspace:Workspace;project:Project;canCreate:boolean;onOpenShotGenerator:()=>void};
const filmModule=Object.values(import.meta.glob<{FilmStudio:ComponentType<FilmProps>}>("../film-studio/FilmStudio.tsx"))[0];
const FilmStudio=filmModule?lazy(async()=>({default:(await filmModule()).FilmStudio})):undefined;
export const filmStudioInstalled=!!FilmStudio;

type Options={sets:Array<{id:string;name:string;text:string}>;moves:Array<{id:string;name:string}>;seconds:number[]};
type Shot={layout:{id:string};depth?:{id:string};frames:number;width:number;height:number;fps:number};
const DONE=["succeeded","failed","cancelled","submission_unknown"];
const clip=(workspaceId:string,id:string)=><LazyVideo src={assetUrl(workspaceId,id)}/>;

type BlockShotProps={workspace:Workspace;project:Project;call:Call;depth?:{manifest:CapabilityManifestV2;workerId:string;routeId:string};canCreate:boolean;onQueued:()=>void;makeReal?:(layoutId:string)=>void;router?:(layoutId:string,look:string)=>void};

/** Block a shot: pick a set and a camera move. A grey layout is drawn from the set. With Grey-block to video ready
 *  (`makeReal`), the layout is drawn at 24 fps and handed to that screen, where HyperFlow turns it into the real shot
 *  from your character, prop and location pictures. Without it, the depth restyle (Wan VACE) paints the shot here.
 *  The drawing is ported from OpenField's Stage; the idea is shared with Open Cinema Studio. */
/** `router`: on Comfy Router the layout is drawn in HD and handed to Kling's restyle with the look as its prompt. */
function BlockShot({workspace,project,call,depth,canCreate,onQueued,makeReal,router}:BlockShotProps){
  const [options,setOptions]=useState<Options>(),[set,setSet]=useState("street"),[move,setMove]=useState("push-in"),[seconds,setSeconds]=useState(router?"3":"2"),[prompt,setPrompt]=useState("");
  const [phase,setPhase]=useState<"idle"|"drawing"|"rendering">("idle"),[shot,setShot]=useState<Shot>(),[result,setResult]=useState<string>(),[error,setError]=useState("");
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{void call<Options>(workspacePath(workspace.id,"block-shot/options")).then(setOptions).catch(e=>setError((e as Error).message));},[call,workspace.id]);
  const reason=!canCreate?"You can look, but not make things in this workspace.":router?(!prompt.trim()?"Describe how the shot should look.":""):makeReal?"":!depth?"The depth workflow is not ready. Check Models.":!prompt.trim()?"Describe how the shot should look.":"";
  const busy=phase!=="idle";

  async function make(){
    if(busy||reason)return;
    if(router){
      setError("");setShot(undefined);setPhase("drawing");
      try{/* 24 fps for 3-5 s takes the server up to about a minute to draw. */
      const drawn=await call<Shot>(workspacePath(workspace.id,"block-shot"),"POST",{projectId:project.id,set,move,seconds:Math.max(3,Number(seconds)),aspect:"16:9",fps:24,hd:true,layoutOnly:true},{timeoutMs:180000});if(!alive.current)return;setShot(drawn);onQueued();router(drawn.layout.id,prompt.trim());}
      catch(e){if(alive.current)setError((e as Error).message);}
      finally{if(alive.current)setPhase("idle");}
      return;
    }
    if(makeReal&&shot){
      try{makeReal(shot.layout.id);}catch(e){setError((e as Error).message);}
      return;
    }
    if(!makeReal&&!depth)return;
    setError("");setResult(undefined);setShot(undefined);setPhase("drawing");
    try{
      const drawn=await call<Shot>(workspacePath(workspace.id,"block-shot"),"POST",{projectId:project.id,set,move,seconds:Number(seconds),aspect:"16:9",fps:makeReal?24:16});
      if(!alive.current)return;setShot(drawn);onQueued();
      if(makeReal||!depth)return;
      setPhase("rendering");
      let run=await call<Run>(workspacePath(workspace.id,"runs"),"POST",{projectId:project.id,workerId:depth.workerId,idempotencyKey:crypto.randomUUID(),capabilityId:depth.manifest.id,version:depth.manifest.version,routeId:depth.routeId,inputs:{source_video:drawn.layout.id,depth_video:drawn.depth!.id},controls:{prompt:prompt.trim(),seed:Math.floor(Math.random()*2147483647)},audioPolicy:"mute"});
      onQueued();
      while(alive.current&&!DONE.includes(run.state)){await new Promise(r=>setTimeout(r,3000));run=await call<Run>(workspacePath(workspace.id,`runs/${run.id}`));}
      if(!alive.current)return;
      if(run.state!=="succeeded"||!run.output_ids?.[0])throw new Error(run.error??"The shot could not be made.");
      setResult(run.output_ids[0]);onQueued();
    }catch(e){if(alive.current)setError((e as Error).message);}
    finally{if(alive.current)setPhase("idle");}
  }

  const setItems=options?.sets??[],chosen=setItems.find(s=>s.id===set);
  return <div className="cf-form">
    <WorkflowDescription title="Block a shot">
      <Meta>Pick a set and a camera move, then say how the shot should look. A grey layout of the set is drawn with your camera move, and a depth pass of it guides the video, so people and the camera stay where you put them. {router?" Comfy Router uses the layout as a reference.":makeReal?" HyperFlow H3 Flash uses the layout and your references.":" Wan 2.1 VACE paints it on this computer."}</Meta>
      <Meta>The grey-box drawing comes from OpenField (MIT); blocking a shot in grey boxes first is the idea of Open Cinema Studio (MIT).</Meta>
      <LinkButton href="https://github.com/wexloops/openfield/blob/96cf7c13b71456bfa28beaacc9dcca74ad829b9d/server/stageRaster.ts" target="_blank" rel="noopener noreferrer">Open OpenField on GitHub</LinkButton>
      <LinkButton href="https://github.com/colinWWW/open-cinema-studio/tree/d31e1242c01ba8327b3d0472eed1d5e265fa1384" target="_blank" rel="noopener noreferrer">Open Open Cinema Studio on GitHub</LinkButton>
    </WorkflowDescription>
    <Page>
      {error&&<Notice priority={30} title="The shot was not made" details={error} actions={<Button variant="secondary" disabled={busy||!!reason} onClick={()=>void make()}>Try again</Button>}>Nothing else was changed. You can change something and try again.</Notice>}
      <Split>
        <Panel footer={<GenerateButton busy={busy} label={phase==="drawing"?"Drawing the layout":phase==="rendering"?"Painting the shot":router?"Draw and make it real":makeReal?(shot?"Make it real":"Draw the layout"):"Make the shot"} disabled={busy} aria-disabled={!busy&&!!reason} disabledReason={reason||undefined} onClick={()=>void make()}/>}>
          <Block label="Block a shot">
            <Row label="Set" display={chosen?.name??"Street"} value={set} options={setItems.map(s=>({value:s.id,label:s.name}))} onChange={value=>{setSet(value);setShot(undefined);}} disabled={busy}/>
            {chosen&&<Meta>{chosen.text}</Meta>}
            <Row label="Camera move" display={options?.moves.find(m=>m.id===move)?.name??"Push in"} value={move} options={(options?.moves??[]).map(m=>({value:m.id,label:m.name}))} onChange={value=>{setMove(value);setShot(undefined);}} disabled={busy}/>
            <SegmentedTabs label="Length" quiet items={(options?.seconds??[2,3,4,5]).filter(s=>!router||s>=3).map(s=>({id:String(s),label:`${s} s`}))} value={router&&Number(seconds)<3?"3":seconds} onChange={value=>{setSeconds(value);setShot(undefined);}}/>
            {makeReal&&shot&&<Meta>Next you add your character, and a vehicle or place if you like. HyperFlow H3 Flash keeps this camera move and turns every grey shape into the real thing.</Meta>}
            {(!makeReal||router)&&<PromptField label="Look" value={prompt} onChange={setPrompt} disabled={busy} placeholder="Where it is, the light, who is in it. For example: a rainy street at dusk, a woman in a red coat walking away."/>}
          </Block>
        </Panel>
        <Canvas>
          {!shot&&!result&&<EmptyState stage title="Your shot appears here" text="The grey layout shows up first, then the finished shot. Both keep the camera move you picked."/>}
          {(shot||result)&&<div className="cf-block-shot__pair">
            {shot&&<Block label="Your layout">
              <MediaCard media={clip(workspace.id,shot.layout.id)} title="Layout" meta={<Meta parts={[`${shot.width}×${shot.height}`,`${(shot.frames/shot.fps).toFixed(1)} s`]}/>}/>
              {phase==="rendering"&&<StatusText tone="active">Painting the shot from the depth pass. This takes about a minute on a GPU.</StatusText>}
            </Block>}
            {result&&<Block label="Your shot"><MediaCard media={clip(workspace.id,result)} title="Shot" meta={<Meta parts={["Wan 2.1 VACE depth restyle"]}/>}/></Block>}
          </div>}
        </Canvas>
      </Split>
    </Page>
  </div>;
}

type BlockWorkspaceProps=Omit<BlockShotProps,"depth"|"makeReal"|"router">&{
  screen:BlockScreen;
  depthRoute:(id:string)=>BlockShotProps["depth"];
  presetTool:(manifest:CapabilityManifestV2,inputs:Record<string,string>)=>void;
  onTarget:(target:"local"|"router")=>void;
  onRouter:NonNullable<BlockShotProps["router"]>;
};

export function BlockWorkspace({screen,depthRoute,presetTool,onTarget,onRouter,...props}:BlockWorkspaceProps){
  if(screen.kind==="film-studio"){
    return FilmStudio?<Suspense fallback={null}>
      <FilmStudio workspace={props.workspace} project={props.project} canCreate={props.canCreate}
        onOpenShotGenerator={()=>{location.hash="block";}}/>
    </Suspense>:null;
  }
  const delivery=screen.delivery;
  return <BlockShot {...props}
    depth={delivery?.kind==="depth"?depthRoute(delivery.manifest.id):undefined}
    makeReal={delivery?.kind==="previs"?layoutId=>{
      presetTool(delivery.manifest,{source_video:layoutId});
      onTarget("local");
      location.hash=nativeWorkflowHash(delivery.manifest);
    }:undefined}
    router={delivery?.kind==="router"?(layoutId,look)=>{
      onRouter(layoutId,look);
      onTarget("router");
      location.hash="video/transform/restyle";
    }:undefined}/>;
}
