/*
 * What a Film Studio shot IS, read from the score the way the stage camera sees it: the camera move
 * in plain words, the lens and angle, and every character the camera actually shows - with its
 * screen side, framing, movement, entry and exit. The result feeds the shared shot direction
 * (src/capabilities/shot-direction.ts), so Make it real follows the blocking instead of guessing.
 */
import type {ShotBrief, ShotSubject, ScreenSide, Framing} from "../capabilities/shot-direction";
import {evaluateFrame} from "./score/evaluate";
import type {EvaluatedCamera, EvaluatedEntity, Shot, StageScore, Vec3} from "./score/schema";

const SAMPLES = 9;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

type View = {x: number; heightShare: number; depth: number};

/** Where an entity's body centre lands on screen (x in -1..1) and how much of the frame height it fills. */
function project(camera: EvaluatedCamera, aspect: number, entity: EvaluatedEntity): View | null {
  const forward = unit(sub(camera.target, camera.eye));
  const right = unit(cross(forward, camera.up));
  const up = cross(right, forward);
  const centre: Vec3 = [entity.position[0], entity.position[1] + entity.size.height / 2, entity.position[2]];
  const relative = sub(centre, camera.eye);
  const depth = dot(relative, forward);
  if (depth < 0.2) return null;
  const halfHeight = Math.tan((camera.fovDeg * Math.PI) / 360) * depth;
  const halfWidth = halfHeight * aspect;
  const x = dot(relative, right) / halfWidth;
  const y = dot(relative, up) / halfHeight;
  const heightShare = entity.size.height / (2 * halfHeight);
  // In frame when any part of the body is inside the gate.
  const halfBodyX = Math.max(0.15, entity.size.width / 2) / halfWidth;
  if (Math.abs(x) - halfBodyX > 1 || Math.abs(y) - heightShare > 1) return null;
  return {x, heightShare, depth};
}

const sideOf = (x: number): ScreenSide => (x < -0.4 ? "left" : x < -0.05 ? "left of centre" : x <= 0.05 ? "centre" : x <= 0.4 ? "right of centre" : "right");
const framingOf = (share: number): Framing => (share > 1.8 ? "close-up" : share > 1.05 ? "waist up" : "full body");

const metres = (value: number) => `${Math.abs(value).toFixed(1)} m`;

/**
 * The camera move in plain words, from the evaluated start and end of the shot. The eye's travel is
 * split in the camera's own start basis - sideways (truck), forward (dolly), up (crane) - and a
 * target that travels with the subjects is named as following them, so a moving shot is never
 * reduced to its one most obvious component.
 */
function cameraMove(shot: Shot, start: EvaluatedCamera, end: EvaluatedCamera, subjectsTravel: Vec3 | null): string {
  const travel = sub(end.eye, start.eye);
  const yawChange = ((end.yaw - start.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const lensChange = end.lensMm - start.lensMm;
  if (Math.hypot(...travel) < 0.05 && Math.abs(yawChange) < 0.02 && Math.abs(lensChange) < 1) return "a locked-off static frame, the camera does not move";
  const forward = unit(sub(start.target, start.eye));
  const flatForward = unit([forward[0], 0, forward[2]]);
  const right = unit(cross(forward, start.up));
  const sideways = dot(travel, right);
  const ahead = dot(travel, flatForward);
  const rise = travel[1];
  const targetTravel = sub(end.target, start.target);
  const parts: string[] = [];
  const maneuver = shot.camera?.maneuver;
  const orbiting = Math.abs(yawChange) > 0.12 || maneuver === "orbit" || maneuver === "arc" || maneuver === "sweep" || maneuver === "spiral";
  if (orbiting) {
    parts.push(`${Math.abs(yawChange) > 1.2 ? "an orbit" : "an arc"} around the subjects, the camera moving to its ${sideways >= 0 ? "right" : "left"} (about ${Math.round((Math.abs(yawChange) * 180) / Math.PI)} degrees)`);
  } else if (Math.abs(sideways) > 0.25) {
    const following = subjectsTravel !== null && Math.hypot(subjectsTravel[0], subjectsTravel[2]) > 0.5 && dot(targetTravel, subjectsTravel) > 0;
    parts.push(`a sideways tracking move: the camera travels ${metres(sideways)} to its ${sideways > 0 ? "right" : "left"}${following ? ", moving with the walking people so they stay in the centre of frame the whole time" : ""}`);
  }
  // On an arc the forward component is the chord of the circle; the dolly is the change in distance.
  const closer = orbiting ? start.distance - end.distance : ahead;
  if (Math.abs(closer) > 0.2) parts.push(`a ${Math.abs(closer) > 2 ? "" : "slow "}dolly ${closer > 0 ? "in toward" : "back from"} the subjects (${metres(closer)})`);
  if (Math.abs(rise) > 0.3) parts.push(`a crane ${rise > 0 ? "up" : "down"} of ${metres(rise)}`);
  if (Math.abs(lensChange) >= 1) parts.push(`a zoom from ${Math.round(start.lensMm)} to ${Math.round(end.lensMm)} mm`);
  if (!parts.length) parts.push("a slow tracking move that keeps the subjects framed");
  return parts.join(", combined with ");
}

/** Height above the floor and tilt, in numbers: the model cannot guess them from "a high angle". */
function angleOf(camera: EvaluatedCamera): string {
  const downDeg = (Math.atan2(camera.eye[1] - camera.target[1], Math.hypot(camera.eye[0] - camera.target[0], camera.eye[2] - camera.target[2])) * 180) / Math.PI;
  const tilt = Math.abs(downDeg) < 3 ? "level" : `tilted about ${Math.round(Math.abs(downDeg))} degrees ${downDeg > 0 ? "down" : "up"}`;
  const height = camera.eye[1] > 2.2 ? "above head height" : camera.eye[1] < 1.1 ? "below eye level" : "at eye level";
  return `the lens about ${camera.eye[1].toFixed(1)} m above the floor (${height}), ${tilt}`;
}


/**
 * The motion of an entity across the shot in screen terms, from its world displacement seen in the
 * camera's start basis (a dolly changes the depth of a standing figure; that is not walking).
 */
function actionOf(camera: EvaluatedCamera, displacement: Vec3): string {
  const flat: Vec3 = [displacement[0], 0, displacement[2]];
  if (Math.hypot(flat[0], flat[2]) < 0.4) return "stands in place";
  const forward = unit(sub(camera.target, camera.eye));
  const right = unit(cross(forward, camera.up));
  const toward = -dot(flat, forward);
  const sideways = dot(flat, right);
  if (Math.abs(toward) > Math.abs(sideways) * 1.5) return toward > 0 ? "walks toward the camera" : "walks away from the camera";
  return `walks to the ${sideways > 0 ? "right" : "left"} of frame`;
}

/**
 * The brief for one shot. Characters the camera never shows are left out (they would only make the
 * model invent people); the visible ones are ordered left to right and take pictures 1..n.
 */
export function shotBrief(score: StageScore, shot: Shot, options: {sound: boolean; maxPictures?: number}): ShotBrief {
  const duration = Math.max(0.1, shot.endSec - shot.startSec);
  const times = Array.from({length: SAMPLES}, (_, index) => shot.startSec + Math.min(duration - 0.001, (duration * index) / (SAMPLES - 1)));
  const frames = times.map((time) => evaluateFrame(score, time - score.offsetSec));
  const aspect = score.aspectRatio;
  const characters = score.entities.filter((entity) => entity.kind === "character");
  const seen: Array<{subject: Omit<ShotSubject, "picture">; x: number}> = [];
  const travels: Vec3[] = [];
  for (const character of characters) {
    const views = frames.map((frame) => {
      const entity = frame.entities.find((item) => item.id === character.id);
      return entity && entity.visible ? project(frame.stageCamera, aspect, entity) : null;
    });
    const visible = views.map((view) => view !== null);
    if (!visible.some(Boolean)) continue;
    const firstIndex = visible.indexOf(true);
    const lastIndex = visible.lastIndexOf(true);
    const middle = views[Math.round((firstIndex + lastIndex) / 2)] ?? views[firstIndex]!;
    const startEntity = frames[firstIndex].entities.find((item) => item.id === character.id)!;
    const endEntity = frames[lastIndex].entities.find((item) => item.id === character.id)!;
    travels.push(sub(endEntity.position, startEntity.position));
    seen.push({
      x: middle.x,
      subject: {
        label: character.label,
        side: sideOf(middle.x),
        framing: framingOf(Math.max(...views.filter((view): view is View => view !== null).map((view) => view.heightShare))),
        action: actionOf(frames[firstIndex].stageCamera, sub(endEntity.position, startEntity.position)),
        ...(firstIndex > 0 ? {entersAtSec: times[firstIndex] - shot.startSec} : {}),
        ...(lastIndex < SAMPLES - 1 ? {exitsAtSec: times[lastIndex + 1] - shot.startSec} : {}),
      },
    });
  }
  seen.sort((left, right) => left.x - right.x);
  const maxPictures = options.maxPictures ?? 4;
  const subjects: ShotSubject[] = seen.map((entry, index) => ({...entry.subject, ...(index < maxPictures ? {picture: index + 1} : {})}));
  const first = frames[0].stageCamera;
  const last = frames[frames.length - 1].stageCamera;
  return {
    durationSec: duration,
    camera: {move: cameraMove(shot, first, last, travels.length ? travels.reduce((sum, item) => [sum[0] + item[0] / travels.length, sum[1] + item[1] / travels.length, sum[2] + item[2] / travels.length], [0, 0, 0] as Vec3) : null), lensMm: frames[Math.floor(SAMPLES / 2)].stageCamera.lensMm, angle: angleOf(frames[Math.floor(SAMPLES / 2)].stageCamera)},
    subjects,
    direction: shot.description?.trim() || undefined,
    sound: options.sound,
  };
}
