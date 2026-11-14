/*
 * The Geometry module: what the analysis measured for each shot, in one quiet
 * record per shot. It is the studio side of the geometry stage:
 * floor confidence, the camera (height, pitch, lens) and the people (count and
 * heights) are level-3 Meta only, never controls.
 *
 * A shot whose floor is not usable gets an estimated geometry instead of a skip;
 * the record says "Estimated (no floor)" and one quiet line explains the basis
 * (the person's apparent size and where the camera height came from). This is a
 * fact about the shot, never a problem.
 *
 * The module reads the same session as every other mode, so a record's one
 * action seeks that shot and returns to the Blocking module - no second
 * navigation level and no analysis state of its own.
 */
import {Button, DataRow, EmptyState, Meta, Toolbar} from "../../ds";
import {horizontalFovFromLensMm, lensMmFromHorizontalFov, type ShotEstimate} from "../analysis-contract";
import {geometryCoverage, geometryQualityOf} from "../geometry-synthesis";
import {PERSON_HEIGHT_RANGE_M, measuredHeightM} from "../score-build";
import {shotAnalysisLabel, type FilmStudioSession} from "../session";

const shotNumber = (value: number) => `#${String(value).padStart(2, "0")}`;
const percent = (value: number) => `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
const metres = (value: number) => `${value.toFixed(2)} m`;
const degrees = (value: number) => `${Math.round(value)}°`;
const lensText = (lensMm: number, fovDeg: number) => {
  const lens = Number.isFinite(lensMm) && lensMm > 0 ? lensMm : lensMmFromHorizontalFov(Number.isFinite(fovDeg) ? fovDeg : 50);
  const fov = Number.isFinite(fovDeg) && fovDeg > 0 ? fovDeg : horizontalFovFromLensMm(lens);
  return `${Math.round(fov)}° · ${Math.round(lens)} mm`;
};

/**
 * The measured height used by the score, with the raw measurement in brackets when the
 * plausibility clamp actually moved it (e.g. "1.20 m (raw 0.98 m)"); an in-band raw value
 * adds nothing and stays hidden.
 */
function heightText(person: {heightM: number; rawHeightM?: number}): string {
  const clamped = measuredHeightM(person.heightM);
  const raw = person.rawHeightM;
  const outside = typeof raw === "number" && Number.isFinite(raw) && (raw < PERSON_HEIGHT_RANGE_M[0] || raw > PERSON_HEIGHT_RANGE_M[1]);
  return outside ? `${metres(clamped)} (raw ${metres(raw)})` : metres(clamped);
}

/** The quiet basis line of an estimated shot: apparent size, distance, camera height source. */
export function estimateText(estimate: ShotEstimate): string {
  const anchor = estimate.basis === "head-size" ? "head-size" : "person-height";
  const source =
    estimate.cameraHeightSource === "neighbor-floor" && estimate.neighborShotIndex !== undefined
      ? `camera height from neighbor shot ${shotNumber(estimate.neighborShotIndex + 1)}`
      : estimate.cameraHeightSource === "person-feet"
        ? "camera height and tilt from the person's feet and posture"
        : estimate.cameraHeightSource === "person-head"
          ? "camera height and tilt from the person's head and posture"
          : "eye level";
  return `estimated · ${anchor} ${Math.round(estimate.anchorPx)} px → ${metres(estimate.subjectDistanceM)}; ${source}`;
}

export function GeometryModule({session}: {session: FilmStudioSession}) {
  const score = session.score;
  const geometries = new Map(session.analysisGeometries.map((geometry) => [geometry.shotIndex, geometry]));
  const statuses = session.shotStatuses;
  const coverage = geometryCoverage({geometries: session.analysisGeometries, skips: session.analysisSkips});
  const analysed = statuses.length > 0 || geometries.size > 0;
  if (!analysed) {
    return (
      <EmptyState
        stage
        plain
        title="No measurements yet"
        text="Analyse a reference clip in the Reference panel. This module then shows the floor, camera and people per shot, and marks estimated shots."
      />
    );
  }
  return (
    <div className="fs-geometry">
      <Toolbar>
        <Meta
          parts={[
            `${score.shots.length} shots`,
            coverage.measured.length ? `${coverage.measured.length} measured` : "",
            coverage.estimated.length ? `${coverage.estimated.length} estimated` : "",
            coverage.skipped.length ? `${coverage.skipped.length} skipped` : "",
            session.analysisStage,
            session.analysisCache === "full" ? "from cache" : "",
          ]}
        />
      </Toolbar>
      <div className="fs-geometry__list">
        {score.shots.map((shot, index) => {
          const geometry = geometries.get(index);
          const status = statuses[index];
          const note = session.analysisShotNotes[index];
          const camera = geometry?.camera;
          const floor = geometry?.floor;
          const persons = geometry?.persons ?? [];
          const estimated = geometry ? geometryQualityOf(geometry) === "estimated" : false;
          const open = () => {
            session.seek(shot.startSec + 0.001);
            session.setPlaying(false);
            session.setModule("blocking");
          };
          return (
            <DataRow
              key={shot.id}
              title={`${shotNumber(shot.shotNumber)} ${shot.label}`}
              meta={
                <>
                  {/* Measured / Estimated (no floor) when geometry exists; the status word otherwise. */}
                  <Meta>{shotAnalysisLabel(status, geometry)}</Meta>
                  {/* The estimate's basis is a quiet fact about the shot, not a problem. */}
                  {estimated && geometry?.estimate ? <Meta>{estimateText(geometry.estimate)}</Meta> : null}
                  {/* A per-shot reason (no person, no usable floor) is one quiet fact, not a Notice. */}
                  {note && !geometry ? <Meta>{note}</Meta> : null}
                  {geometry ? (
                    <>
                      <Meta parts={[estimated ? "Floor estimated" : `Floor ${percent(floor?.confidence ?? 0)}`, estimated ? "" : floor ? `${floor.inliers} inliers` : ""]} />
                      <Meta parts={camera ? [`Camera ${metres(camera.heightM)}`, `Pitch ${degrees(camera.pitchDeg)}`, lensText(camera.lensMm, camera.fovDeg)] : ["Camera not measured"]} />
                      <Meta parts={[persons.length === 1 ? "1 person" : `${persons.length} people`, ...persons.slice(0, 4).map(heightText)]} />
                    </>
                  ) : note ? null : (
                    <Meta>{status === "refining" ? "Measuring this shot" : "Rough blockout only"}</Meta>
                  )}
                </>
              }
              actions={
                <Button variant="secondary" onClick={open}>
                  Open shot
                </Button>
              }
            />
          );
        })}
      </div>
    </div>
  );
}
