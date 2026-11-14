/*
 * The shot popup from the reference studio: a rectangular wireframe still of
 * the shot, its facts, and the arrow that records the grey-block clip and hands
 * it to Make it real (or points at Models when that flow is not set up here).
 */
import {useState} from "react";
import {ArrowRight} from "lucide-react";
import {Button, ClampText, Dialog, Meta, Notice} from "../../ds";
import type {Shot} from "../score/schema";
import type {FilmStudioSession} from "../session";
import {downloadBlob} from "../download";
import {uploadBlockoutClip} from "./handoff";
import {renderShotClipFrames} from "./shot-capture";
import {compileShotDirection} from "../../capabilities/shot-direction";
import {shotBrief} from "../shot-brief";

const shotNumber = (value: number) => `#${String(value).padStart(2, "0")}`;

export function ShotActionsDialog({session, shot, still, onClose}: {session: FilmStudioSession; shot: Shot; still?: string; onClose: () => void}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const camera = shot.camera;

  const saveStill = () => {
    if (!still) return;
    const [, data] = still.split(",");
    if (!data) return;
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    downloadBlob(new Blob([bytes], {type: "image/png"}), `${session.score.id}-shot-${String(shot.shotNumber).padStart(2, "0")}.png`);
  };

  /** Render the shot at exact frame times and let the server encode it to an MP4 asset. */
  const renderClip = async (): Promise<{assetId: string; name: string}> => {
    const workspace = session.workspace;
    if (!workspace) throw new Error("Choose a workspace before exporting a shot.");
    setBusy("Rendering the shot at 24 fps");
    // The handoff look plus this shot's rebuilt set: the clip a video model reads must show the place
    // and make camera travel visible, not the studio's dark diorama with its marks.
    const shotIndex = session.score.shots.findIndex((entry) => entry.id === shot.id);
    const set = session.analysisGeometries.find((geometry) => geometry.shotIndex === shotIndex)?.set;
    const clip = await renderShotClipFrames(session.score, shot.id, {fps: 24, width: 1280, maxFrames: 180, maxDurationSec: 6, look: "handoff", set});
    setBusy(`Encoding ${clip.frames.length} frames`);
    const name = `${session.score.id}-shot-${String(shot.shotNumber).padStart(2, "0")}-${clip.fps}fps.mp4`;
    const asset = await uploadBlockoutClip(workspace.id, session.project?.id, {frames: clip.frames, fps: clip.fps, name});
    return {assetId: asset.id, name};
  };

  const makeReal = async () => {
    if (!session.sendToVideo) return;
    try {
      const {assetId} = await renderClip();
      setBusy("Preparing the video input");
      // The shared shot direction: camera move, lens and who stands where, read from the score.
      session.sendToVideo(assetId, {prompt: compileShotDirection(shotBrief(session.score, shot, {sound: true})), aspectRatio: session.score.aspectRatio});
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The clip could not be handed over.");
    } finally {
      setBusy("");
    }
  };

  const downloadClip = async () => {
    const workspace = session.workspace;
    if (!workspace) {
      setError("Choose a workspace before exporting a shot.");
      return;
    }
    try {
      const {assetId, name} = await renderClip();
      setBusy("Downloading the clip");
      const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/assets/${encodeURIComponent(assetId)}/content`, {credentials: "same-origin"});
      if (!response.ok) throw new Error(`The encoded clip could not be downloaded (${response.status}).`);
      downloadBlob(await response.blob(), name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The clip could not be exported.");
    } finally {
      setBusy("");
    }
  };

  return (
    <Dialog
      open
      wide
      title={`${shotNumber(shot.shotNumber)} ${shot.label}`}
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={!!busy}>Cancel</Button>
          <Button variant="secondary" onClick={() => void downloadClip()} disabled={!!busy}>Download MP4</Button>
          <Button variant="secondary" onClick={saveStill} disabled={!!busy || !still}>Save still</Button>
          {session.sendToVideo ? (
            <Button variant="primary" onClick={() => void makeReal()} disabled={!!busy}>
              <ArrowRight size={14} />
              {busy || "Make it real"}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => { location.hash = "#catalogue"; }}>Open Models</Button>
          )}
        </>
      }
    >
      <div className="fs-shotactions">
        {still ? <img className="fs-shotactions__still" src={still} alt="Grey-block still of this shot, framed by its camera" /> : <Meta>This shot could not be rendered as a still.</Meta>}
        <Meta parts={[
          shotNumber(shot.shotNumber),
          `${(shot.endSec - shot.startSec).toFixed(1)} s`,
          camera ? `${Math.round(camera.end.lensMm)}mm` : "baseline camera",
          camera?.maneuver?.toUpperCase() ?? "",
          camera?.dof ? `DoF ${camera.dof}` : "",
          camera?.focus || camera?.focusStart ? "focus set" : "",
        ]} />
        {shot.description ? <ClampText text={shot.description} lines={3} /> : null}
        {session.sendToVideo ? (
          <Meta>The grey-block clip is rendered at 24 fps from exact frame times and encoded to MP4. Download it, or open it in Make it real with character, prop and location references.</Meta>
        ) : (
          <Meta>No Grey-block-to-video workflow is ready on this computer. Download the 24 fps MP4 here, or set up the H3 previs workflow in Models to render a shot from it.</Meta>
        )}
        {busy ? <Meta>{busy}…</Meta> : null}
        {error ? <Notice priority={20} title="The shot could not be handed over" details={error}>Nothing else was changed.</Notice> : null}
      </div>
    </Dialog>
  );
}
