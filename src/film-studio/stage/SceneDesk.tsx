/*
 * What the score says about the scene, split into the studio's side boxes:
 * `SceneSummary` (facts, premise, camera package) and `CastAndSet` (cast,
 * props, marks, notes). Facts are Meta (level 3), never chips. The facts of the
 * shot under the playhead live on the stage (shot card, CAM capsule), so each
 * fact has one place.
 */
import {ClampText, Meta, PanelSection} from "../../ds";
import {formatClock} from "../score/evaluate";
import type {StageScore} from "../score/schema";
import type {FilmStudioSession} from "../session";
import {aspectText, referenceLabel} from "../session";

const millimeters = (lens: number) => `${Math.round(lens)}mm`;

/** Lens and maneuver sets, in the order they first appear in the score. */
function packageOf(score: StageScore): {lenses: number[]; maneuvers: string[]} {
  const lenses: number[] = [];
  const maneuvers: string[] = [];
  for (const shot of score.shots) {
    const camera = shot.camera;
    if (!camera) continue;
    for (const lens of [camera.start.lensMm, camera.end.lensMm]) if (!lenses.some((value) => Math.abs(value - lens) < 1)) lenses.push(lens);
    if (!maneuvers.includes(camera.maneuver)) maneuvers.push(camera.maneuver);
  }
  return {lenses, maneuvers};
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The camera body, stabilizer and other package facts: shown on request (info button). */
export function CameraPackage({score}: {score: StageScore}) {
  const {lenses, maneuvers} = packageOf(score);
  const kit = record(score.metadata?.camera_package);
  return (
    <div className="fs-desk">
      <PanelSection label="Prime lenses"><Meta parts={lenses.length ? lenses.map(millimeters) : ["None in this score"]} /></PanelSection>
      <PanelSection label="Moves"><Meta parts={maneuvers.length ? maneuvers.map((move) => move.toUpperCase()) : ["Static"]} /></PanelSection>
      {kit && Object.entries(kit).map(([key, value]) => (
        <PanelSection key={key} label={key.replace(/_/g, " ")}><Meta>{String(value)}</Meta></PanelSection>
      ))}
    </div>
  );
}

/** The Scene box: the facts once, the premise, the lens and move package. */
export function SceneSummary({session}: {session: FilmStudioSession}) {
  const score = session.score;
  const {lenses, maneuvers} = packageOf(score);
  return (
    <div className="fs-desk">
      <Meta parts={[formatClock(score.durationSec), `${score.shots.length} shots`, aspectText(score), referenceLabel(session.reference)]} />
      {score.description && <ClampText text={score.description} lines={4} title={score.title} />}
      {(lenses.length > 0 || maneuvers.length > 0) && (
        <PanelSection label="Camera">
          <Meta parts={[...lenses.map(millimeters), ...maneuvers.map((move) => move.toUpperCase())]} />
        </PanelSection>
      )}
    </div>
  );
}

/** The Cast and set box: who and what stands on the stage, and the production notes. */
export function CastAndSet({session}: {session: FilmStudioSession}) {
  const score = session.score;
  const cast = score.entities.filter((entity) => entity.kind === "character");
  const props = score.entities.filter((entity) => entity.kind === "prop");
  const marks = score.entities.filter((entity) => entity.kind === "marker");
  const notes = Array.isArray(score.metadata?.production_notes) ? score.metadata.production_notes.map((note) => String(note)) : [];
  if (!cast.length && !props.length && !marks.length && !notes.length) return <Meta>Nothing on stage yet.</Meta>;
  return (
    <div className="fs-desk">
      {cast.length > 0 && (
        <PanelSection label={`Cast · ${cast.length}`}>
          {cast.map((entity) => <Meta key={entity.id} parts={[entity.label, `${entity.height.toFixed(2)} m`]} />)}
        </PanelSection>
      )}
      {props.length > 0 && (
        <PanelSection label={`Props · ${props.length}`}>
          {props.map((entity) => <Meta key={entity.id} parts={[entity.label, entity.shape ?? "box"]} />)}
        </PanelSection>
      )}
      {marks.length > 0 && (
        <PanelSection label={`Marks · ${marks.length}`}>
          <Meta parts={marks.map((entity) => entity.label)} />
        </PanelSection>
      )}
      {notes.length > 0 && (
        <PanelSection label="Notes">
          {notes.map((note) => <Meta key={note}>{note}</Meta>)}
        </PanelSection>
      )}
    </div>
  );
}
