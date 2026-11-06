import {useEffect,useRef,useState} from "react";
import {Block,Button,Canvas,EmptyState,GenerateButton,LinkButton,MediaCard,Meta,Notice,Page,Panel,PromptField,Row,SegmentedTabs,Split,StatusText} from "../ds";
import {assetUrl,workspacePath,type Call,type Project,type Run,type Worker,type Workspace} from "./api";
import {WorkflowDescription} from "./workflow-info";
import type {CapabilityManifestV2} from "../capabilities/types";

type Options={sets:Array<{id:string;name:string;text:string}>;moves:Array<{id:string;name:string}>;seconds:number[]};
type Shot={layout:{id:string};depth:{id:string};frames:number;width:number;height:number;fps:number};
const DONE=["succeeded","failed","cancelled","submission_unknown"];
const clip=(workspaceId:string,id:string)=><video src={assetUrl(workspaceId,id)} muted loop autoPlay playsInline/>;

/** Block a shot: pick a set and a camera move. A grey layout is drawn from the set. With Grey-block to video ready
 *  (`makeReal`), the layout is drawn at 24 fps and handed to that screen, where MiniMax H3 turns it into the real shot
 *  from your character, prop and location pictures. Without it, the depth restyle (Wan VACE) paints the shot here.
 *  The drawing is ported from OpenField's Stage; the idea is shared with Open Cinema Studio. */
/** `router`: on Comfy Router the layout is drawn in HD and handed to Kling's restyle with the look as its prompt. */
export function BlockShot({workspace,project,call,workers,catalogue,canCreate,onQueued,makeReal,router}:{workspace:Workspace;project:Project;call:Call;workers:Worker[];catalogue:CapabilityManifestV2[];canCreate:boolean;onQueued:()=>void;makeReal?:(layoutId:string)=>void;router?:(layoutId:string,look:string)=>void}){
  const [options,setOptions]=useState<Options>(),[set,setSet]=useState("street"),[move,setMove]=useState("push-in"),[seconds,setSeconds]=useState("2"),[prompt,setPrompt]=useState("");
  const [phase,setPhase]=useState<"idle"|"drawing"|"rendering">("idle"),[shot,setShot]=useState<Shot>(),[result,setResult]=useState<string>(),[error,setError]=useState("");
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{void call<Options>(workspacePath(workspace.id,"block-shot/options")).then(setOptions).catch(e=>setError((e as Error).message));},[call,workspace.id]);
  const capability=catalogue.find(m=>m.id==="vace-depth-restyle"),worker=workers.find(w=>w.enabled&&(w as Worker&{kind?:string}).kind==="local");
  const reason=!canCreate?"You can look, but not make things in this workspace.":router?(!prompt.trim()?"Describe how the shot should look.":""):makeReal?"":!capability?"The depth restyle is not set up on this computer. Models shows what is missing.":!worker?"Add and start a local ComfyUI first.":!prompt.trim()?"Describe how the shot should look.":"";
  const busy=phase!=="idle";

  async function make(){
    if(busy||reason)return;
    if(router){
      setError("");setShot(undefined);setPhase("drawing");
      try{const drawn=await call<Shot>(workspacePath(workspace.id,"block-shot"),"POST",{projectId:project.id,set,move,seconds:Math.max(3,Number(seconds)),aspect:"16:9",fps:24,hd:true});if(!alive.current)return;setShot(drawn);onQueued();router(drawn.layout.id,prompt.trim());}
      catch(e){if(alive.current)setError((e as Error).message);}
      finally{if(alive.current)setPhase("idle");}
      return;
    }
    if(makeReal&&shot){makeReal(shot.layout.id);return;}
    if(!makeReal&&(!capability||!worker))return;
    setError("");setResult(undefined);setShot(undefined);setPhase("drawing");
    try{
      const drawn=await call<Shot>(workspacePath(workspace.id,"block-shot"),"POST",{projectId:project.id,set,move,seconds:Number(seconds),aspect:"16:9",fps:makeReal?24:16});
      if(!alive.current)return;setShot(drawn);onQueued();
      if(makeReal||!capability||!worker)return;
      setPhase("rendering");
      let run=await call<Run>(workspacePath(workspace.id,"runs"),"POST",{projectId:project.id,workerId:worker.id,idempotencyKey:crypto.randomUUID(),capabilityId:capability.id,version:capability.version,routeId:"local",inputs:{source_video:drawn.layout.id,depth_video:drawn.depth.id},controls:{prompt:prompt.trim(),seed:Math.floor(Math.random()*2147483647)},audioPolicy:"mute"});
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
      <Meta>Pick a set and a camera move, then say how the shot should look. A grey layout of the set is drawn with your camera move, and a depth pass of it guides the video, so people and the camera stay where you put them. Wan 2.1 VACE paints it on this computer.</Meta>
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
            <SegmentedTabs label="Length" quiet items={(options?.seconds??[2,3,4,5]).filter(s=>!router||s>=3).map(s=>({id:String(s),label:`${s} s`}))} value={seconds} onChange={value=>{setSeconds(value);setShot(undefined);}}/>
            {makeReal&&shot&&<Meta>Next you add your character, and a vehicle or place if you like. MiniMax H3 keeps this camera move and turns every grey shape into the real thing.</Meta>}
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
