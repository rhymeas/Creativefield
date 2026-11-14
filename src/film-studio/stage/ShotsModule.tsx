/*
 * The Shots module: the film coverage as a list. Each row jumps back into the
 * blocking module at that cut. This is the second module of the workspace and
 * exists to show the modular shape: later modules (analysis, generation) read
 * the same session and add a tab, without touching the shell.
 */
import {Button, Meta} from "../../ds";
import {formatClock} from "../score/evaluate";
import {shotAnalysisLabel, type FilmStudioSession} from "../session";

export function ShotsModule({session}: {session: FilmStudioSession}) {
  const score = session.score;
  const active = session.frame.activeShotIndex;
  const statuses = session.shotStatuses;
  const analysed = statuses.length === score.shots.length && statuses.length > 0;
  const geometries = new Map(session.analysisGeometries.map((geometry) => [geometry.shotIndex, geometry]));
  return (
    <div className="fs-shots">
      <Meta parts={[`${score.shots.length} shots`, formatClock(score.durationSec), `${score.entities.length} stage marks`]} />
      {score.shots.length === 0 && <Meta>The score declares no shots; the baseline camera is used.</Meta>}
      {score.shots.map((shot, index) => {
        const camera = shot.camera;
        return (
          <div className="fs-shots__row" key={shot.id}>
            <Button
              variant={index === active ? "primary" : "secondary"}
              onClick={() => {
                session.seek(shot.startSec + 0.001);
                session.setPlaying(false);
                session.setModule("blocking");
              }}
            >
              {`#${String(shot.shotNumber).padStart(2, "0")} ${shot.label}`}
            </Button>
            <Meta
              parts={[
                formatClock(shot.startSec),
                formatClock(shot.endSec),
                camera ? `${Math.round(camera.end.lensMm)}mm` : "baseline",
                camera?.maneuver?.toUpperCase() ?? "",
                camera?.dof ? `dof ${camera.dof}` : "",
                camera?.focus || camera?.focusStart ? "focus set" : "",
              ]}
            />
            {/* Measured / Estimated (no floor) when geometry exists; the status word otherwise. */}
            {analysed ? <Meta>{shotAnalysisLabel(statuses[index], geometries.get(index))}</Meta> : null}
            {shot.description ? <Meta>{shot.description}</Meta> : null}
          </div>
        );
      })}
    </div>
  );
}
