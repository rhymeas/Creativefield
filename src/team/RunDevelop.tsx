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
/** The same Darkroom state contract for the existing Video/Motion run list. */
export function RunDevelop({ workspaceId, run,caption,actions,onCancel,cancelling }: { workspaceId: string; run: Run;caption?:string;actions?:ReactNode;/** Stops this run; the card then offers Cancel. */onCancel?:()=>void;cancelling?:boolean }) {
  const frame = useDevelopPreview(workspaceId, run);
  const active=DEVELOP_LIVE_STATES.has(run.state),[now,setNow]=useState(()=>Date.now());
  useEffect(()=>{if(!active)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[active,run.id]);
  const elapsed=active?elapsedRunTime(run.created_at,now):null;
  const url = `/api/v1${workspacePath(workspaceId, `runs/${encodeURIComponent(run.id)}/preview`)}?v=${frame?.seq ?? 0}`;
  return <div className="cf-run-develop"><ResultTile caption={caption} actions={actions}
    develop={(()=>{const d=developPresentation(run.state, frame, url);
      // While it works, the run's own graph can be watched live in Nodes, as a copy that never touches the job.
      return d&&{...d,onCancel,cancelling,detail:d.active?<>{elapsed&&<span className="ds-running-result__elapsed" aria-label={`Elapsed ${elapsed}`}>{elapsed}</span>}<LinkButton variant="ghost" href={`#nodes/run/${encodeURIComponent(run.id)}`}>Go to nodes workflow</LinkButton></>:d.detail};})()}
    status={<StatusText tone="idle">No artifact available</StatusText>}
  /></div>;
}
