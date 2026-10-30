import {useEffect,useState} from "react";
import {Clapperboard,MoreHorizontal} from "lucide-react";
import {Block,Button,EmptyState,LinkButton,MenuButton,Notice,ResultGrid,ResultTile,ShimmerText,StatusText} from "../ds";
import {assetUrl,exportAssetMp4,workspacePath,type Call,type Run,type User,type Workspace} from "./api";
import {RunDevelop} from "./RunDevelop";
import {TeamChoice} from "./TeamChoice";
import {downloadJson} from "./TeamLibrary";
import {runLabel} from "./state";
import {boardRenderLabels,renderActive,type BoardRender} from "./storyboard-state";

export function StoryboardResults({boardId,workspace,user,call,authorized,canEdit,version,boardRevision,onShotOutputs,onContactSheet,onRenderAgain}:{boardId:string;workspace:Workspace;user:User;call:Call;authorized:boolean;canEdit:boolean;version:number;boardRevision:number;/** Rendered clips keyed by stable shot identity; legacy ordinal-only renders stay in history. */onShotOutputs?:(ids:Record<string,string>)=>void;onContactSheet?:()=>void;/** The render panel's own action, so a failed film can be asked for again from here. */onRenderAgain?:()=>void}){
  const [runs,setRuns]=useState<BoardRender[]>([]),[selected,setSelected]=useState(""),[detail,setDetail]=useState<BoardRender|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0),[exporting,setExporting]=useState(false),[exportError,setExportError]=useState("");
  useEffect(()=>{if(!authorized)return;let current=true,timer:ReturnType<typeof setTimeout>;
    async function poll(){try{const list=await call<BoardRender[]>(workspacePath(workspace.id,`storyboards/${boardId}/renders`));if(!current)return;setRuns(list);const id=list.some(r=>r.id===selected)?selected:list[0]?.id??"";if(id!==selected)setSelected(id);const result=id?await call<BoardRender>(workspacePath(workspace.id,`storyboard-renders/${id}`)):null;if(current){setDetail(result);setError("");}}catch(e){if(current)setError((e as Error).message);}finally{if(current)timer=setTimeout(poll,4000);}}
    void poll();return()=>{current=false;clearTimeout(timer);};
  },[boardId,workspace.id,call,authorized,version,selected,refresh]);
  async function action(operation:"cancel"|"retry-assembly"){
    if(!detail||busy||!canEdit)return;setBusy(true);try{await call(workspacePath(workspace.id,`storyboard-renders/${detail.id}/${operation}`),"POST");setError("");}catch(e){setError((e as Error).message);}finally{setBusy(false);setRefresh(v=>v+1);}
  }
  useEffect(()=>{onShotOutputs?.(Object.fromEntries((detail?.revision===boardRevision?detail.shots??[]:[]).flatMap(s=>s.snapshot.planKey&&s.output_asset_id?[[s.snapshot.planKey,s.output_asset_id]]:[])));},[detail,boardRevision,onShotOutputs]);
  async function exportProvenance(){if(!detail||busy)return;setBusy(true);setError("");try{
    const ids=[...new Set((detail.shots??[]).flatMap(s=>[s.child_run_id,s.snapshot.approvedStill?.producerRunId]).filter((id):id is string=>!!id))];
    const runs=[];for(const id of ids)runs.push({runId:id,...await call<Record<string,unknown>>(workspacePath(workspace.id,`runs/${id}/provenance`))});
    downloadJson({storyboard:detail,runs},`comfyfield-storyboard-${detail.id}-provenance.json`);
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function downloadMp4(){
    if(!detail?.output_asset_id||exporting)return;setExporting(true);setExportError("");try{
      const file=await exportAssetMp4(call,workspace.id,detail.output_asset_id,"mp4-h264-1080p24");
      const link=document.createElement("a");link.href=assetUrl(workspace.id,file.id,true);link.click();
    }catch(e){setExportError((e as Error).message);}finally{setExporting(false);}
  }
  const owns=!!detail&&(workspace.role==="admin"||detail.created_by===user.id),active=detail&&renderActive(detail.state);
  const tone=(state:string)=>/fail|cancel/.test(state)?"warn":/succe|complete|done/.test(state)?"ok":"idle" as const;
  const shotState=(s:{state?:string|null})=>s.state?runLabel[s.state]??s.state:"Waiting";
  return <Block label="Recent result">
    {exportError
      ?<Notice priority={70} title="MP4 download failed" actions={<Button variant="secondary" disabled={exporting} onClick={()=>void downloadMp4()}>{exporting?"Making MP4…":"Try the download again"}</Button>} details={exportError}>The 1080p copy did not finish, so nothing was downloaded. Trying again uses the same film.</Notice>
      :error&&<Notice priority={60} title="Render update unavailable" actions={<Button variant="secondary" onClick={()=>setRefresh(v=>v+1)}>Check again</Button>} details={error}>The latest render status could not be read. Nothing was cancelled, and checking again re-reads it.</Notice>}
    {!runs.length?<EmptyState stage icon={<Clapperboard size={18}/>} title="No renders yet" text="Save your shots, choose a ready worker, then render the saved revision."/>:<div className="cf-sb-head">
      <TeamChoice label="Previous results" variant="pill" display={detail?"Latest result":"Choose a result"} value={selected} onChange={id=>{setDetail(null);setSelected(id);setExportError("");}} disabled={!authorized} options={runs.map(r=>({value:r.id,label:boardRenderLabels[r.state]??r.state,note:new Date(r.created_at).toLocaleString()}))}/>
      <span className="cf-sb-head__end">
        {detail&&<span role="status">{active?<ShimmerText>{boardRenderLabels[detail.state]}</ShimmerText>:<StatusText tone={tone(detail.state)}>{boardRenderLabels[detail.state]??detail.state}</StatusText>}</span>}
        {detail?.output_asset_id&&<LinkButton variant="secondary" href={assetUrl(workspace.id,detail.output_asset_id,true)}>Export film</LinkButton>}
        {detail?.output_asset_id&&canEdit&&<Button variant="secondary" disabled={exporting} onClick={()=>void downloadMp4()}>{exporting?"Making MP4…":"Download 1080p MP4"}</Button>}
        {detail&&<MenuButton label="Render actions" icon={<MoreHorizontal size={16}/>} items={[
          ...(canEdit&&owns&&active&&detail.state!=="cancel_requested"?[{id:"cancel",label:"Cancel render",onSelect:()=>void action("cancel")}]:[]),
          ...(canEdit&&owns&&detail.state==="assembly_failed"?[{id:"retry",label:"Retry assembly",onSelect:()=>void action("retry-assembly")}]:[]),
          {id:"export",label:"Provenance JSON",disabled:busy,onSelect:()=>void exportProvenance()},
          ...(onContactSheet?[{id:"contact-sheet",label:"Contact sheet PNG",onSelect:onContactSheet}]:[]),
        ]}/>}
      </span>
    </div>}
    {detail&&<>
      {detail.error&&<Notice priority={60} title={detail.state==="assembly_failed"?"The film could not be assembled":"This render did not finish"} details={detail.error} actions={<>{detail.state==="assembly_failed"
        ?<Button variant="secondary" disabled={!canEdit||busy} onClick={()=>void action("retry-assembly")}>Retry assembly</Button>
        :onRenderAgain&&<Button variant="secondary" disabled={!canEdit} onClick={onRenderAgain}>Render the saved revision again</Button>}</>}>{detail.state==="assembly_failed"?"Every shot rendered, but joining them into one film failed. Retrying assembles the same rendered shots; nothing is generated twice.":"The saved shots, worker and settings are unchanged, so rendering again produces this result afresh."}</Notice>}
      <ResultGrid count={(detail.shots?.length??0)+(detail.output_asset_id?1:0)} aspect={16/9} label="Final video and rendered shots">
        {detail.output_asset_id&&<ResultTile caption="Final video"><video aria-label="Final storyboard video" controls preload="metadata" src={assetUrl(workspace.id,detail.output_asset_id)}/></ResultTile>}
        {detail.shots?.map(s=>s.output_asset_id
          ?<ResultTile key={s.ordinal} caption={`Shot ${s.ordinal+1} · ${s.snapshot.effectiveDurationSeconds.toFixed(1)}s`}><video aria-label={`Rendered shot ${s.ordinal+1}`} controls preload="metadata" src={assetUrl(workspace.id,s.output_asset_id)}/></ResultTile>
          :s.child_run_id&&s.state?<RunDevelop key={s.ordinal} workspaceId={workspace.id} caption={`Shot ${s.ordinal+1}`} run={{id:s.child_run_id,project_id:detail.project_id,created_by:detail.created_by,capability_id:"",capability_version:"",state:s.state,error:s.error,output_ids:[],scene:s.scene,shot:s.shot,take:s.take,created_at:detail.created_at,updated_at:detail.created_at} as Run}/>:<ResultTile key={s.ordinal} caption={`Shot ${s.ordinal+1}`} status={s.error??<StatusText tone={tone(s.state??"")}>{shotState(s)}</StatusText>}/>)}
      </ResultGrid>
    </>}
  </Block>;
}


