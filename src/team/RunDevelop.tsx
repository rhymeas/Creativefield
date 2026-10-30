import type {ReactNode} from "react";
import { LinkButton, ResultTile, StatusText } from "../ds";
import { workspacePath, type Run } from "./api";
import { developPresentation } from "./develop-state";
import { useDevelopPreview } from "./useDevelopPreview";

/** The same Darkroom state contract for the existing Video/Motion run list. */
export function RunDevelop({ workspaceId, run,caption,actions,onCancel,cancelling }: { workspaceId: string; run: Run;caption?:string;actions?:ReactNode;/** Stops this run; the card then offers Cancel. */onCancel?:()=>void;cancelling?:boolean }) {
  const frame = useDevelopPreview(workspaceId, run);
  const url = `/api/v1${workspacePath(workspaceId, `runs/${encodeURIComponent(run.id)}/preview`)}?v=${frame?.seq ?? 0}`;
  return <ResultTile caption={caption} actions={actions}
    develop={(()=>{const d=developPresentation(run.state, frame, url);
      // While it works, the run's own graph can be watched live in Nodes, as a copy that never touches the job.
      return d&&{...d,onCancel,cancelling,detail:d.active?<LinkButton variant="ghost" href={`#nodes/run/${encodeURIComponent(run.id)}`}>Go to nodes workflow</LinkButton>:d.detail};})()}
    status={<StatusText tone="idle">No artifact available</StatusText>}
  />;
}
