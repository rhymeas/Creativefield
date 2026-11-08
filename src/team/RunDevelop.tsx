import {useEffect,useState,type ReactNode} from "react";
import { LinkButton, ResultTile, StatusText } from "../ds";
import { workspacePath, type Run } from "./api";
import { developPresentation,DEVELOP_LIVE_STATES } from "./develop-state";
import "./run-develop.css";
import "../ds/running-result.css";
import { useDevelopPreview } from "./useDevelopPreview";

export function elapsedRunTime(createdAt:string,now:number):string|null {
  const start=Date.parse(createdAt);if(!Number.isFinite(start))return null;
  const seconds=Math.max(0,Math.floor((now-start)/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),rest=seconds%60;
  return hours?`${hours}:${String(minutes).padStart(2,"0")}:${String(rest).padStart(2,"0")}`:`${minutes}:${String(rest).padStart(2,"0")}`;
}
/** How long a finished run took, from submit to result ("48 s", "3 min 12 s", "1 h 4 min"); null when the times do not say. */
export function renderTime(run:Pick<Run,"state"|"created_at"|"updated_at">):string|null {
  if(run.state!=="succeeded")return null;
  const seconds=Math.round((Date.parse(run.updated_at)-Date.parse(run.created_at))/1000);
  if(!Number.isFinite(seconds)||seconds<0)return null;
  const h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;
  return h?`${h} h ${m} min`:m?`${m} min ${s} s`:`${s} s`;
}
/** A usual duration in round words: "~45 s", "~5 min", "~1 h 10 min". */
export function aboutTime(seconds:number){
  if(seconds<60)return `~${Math.max(5,Math.round(seconds/5)*5)} s`;
  const minutes=Math.round(seconds/60);
  return minutes<60?`~${minutes} min`:`~${Math.floor(minutes/60)} h${minutes%60?` ${minutes%60} min`:""}`;
}
/** The same Darkroom state contract for the existing Video/Motion run list. */
export function RunDevelop({ workspaceId, run,caption,actions,onCancel,cancelling }: { workspaceId: string; run: Run;caption?:string;actions?:ReactNode;/** Stops this run; the card then offers Cancel. */onCancel?:()=>void;cancelling?:boolean }) {
  const frame = useDevelopPreview(workspaceId, run);
  const active=DEVELOP_LIVE_STATES.has(run.state),[now,setNow]=useState(()=>Date.now());
  useEffect(()=>{if(!active)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[active,run.id]);
  const elapsed=active?elapsedRunTime(run.created_at,now):null;
  /* How long jobs like this usually take here, asked once per run: the clock reads "5:06 / ~9 min". */
  const [usual,setUsual]=useState<string>();
  useEffect(()=>{if(!active)return;let current=true;void fetch(`/api/v1${workspacePath(workspaceId,`run-estimate?runId=${encodeURIComponent(run.id)}`)}`,{credentials:"include"}).then(r=>r.ok?r.json():null).then((b:{estimate?:{seconds:number}|null}|null)=>{if(current&&b?.estimate)setUsual(aboutTime(b.estimate.seconds));}).catch(()=>{});return()=>{current=false;};},[active,run.id,workspaceId]);
  const url = `/api/v1${workspacePath(workspaceId, `runs/${encodeURIComponent(run.id)}/preview`)}?v=${frame?.seq ?? 0}`;
  return <div className="cf-run-develop"><ResultTile caption={caption} actions={actions}
    develop={(()=>{const d=developPresentation(run.state, frame, url);
      // While it works, the run's own graph can be watched live in Nodes, as a copy that never touches the job.
      return d&&{...d,onCancel,cancelling,elapsed:elapsed&&<span aria-label={`Elapsed ${elapsed}${usual?`, usually ${usual}`:""}`}>{elapsed}{usual&&` / ${usual}`}</span>,detail:d.active?<LinkButton variant="ghost" href={`#nodes/run/${encodeURIComponent(run.id)}`}>Open in Nodes</LinkButton>:d.detail};})()}
    status={<StatusText tone="idle">No artifact available</StatusText>}
  /></div>;
}
