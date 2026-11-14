/*
 * The camera capsule from the reference studio: a small field over the diorama
 * that names the active camera, its lens and maneuver, shows its full pose on
 * hover or focus, and copies a ready-to-paste YAML block when clicked.
 */
import {useState} from "react";
import {Button, Meta, Tooltip} from "../../ds";
import type {FilmStudioSession} from "../session";

const degrees = (radians: number) => `${((radians * 180) / Math.PI).toFixed(1)}°`;

/** The camera the viewport is showing: the film camera in Film cam, the observer otherwise. */
export function CameraCapsule({session}: {session: FilmStudioSession}) {
  const [copied, setCopied] = useState(false);
  const shot = session.frame.activeShot;
  const camera = session.view === "stage" ? session.frame.stageCamera : session.frame.observerCamera;
  const cue = shot?.camera;
  const lens = Math.round(camera.lensMm);
  const maneuver = (cue?.maneuver ?? "cut").toUpperCase();
  const title = session.view === "stage" ? "Stage camera" : "Observer camera";
  const yaml = [
    session.view === "stage" ? "stage_camera:" : "observer_camera:",
    `  target: [${camera.target.map((value) => value.toFixed(2)).join(", ")}]`,
    `  distance: ${camera.distance.toFixed(2)}`,
    `  pitch: ${((camera.pitch * 180) / Math.PI).toFixed(1)}`,
    `  yaw: ${((camera.yaw * 180) / Math.PI).toFixed(1)}`,
    `  roll: ${((camera.roll * 180) / Math.PI).toFixed(1)}`,
    `  lens: ${lens}mm`,
    `  maneuver: ${(cue?.maneuver ?? "cut").toLowerCase()}`,
  ].join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(yaml);
    } catch {
      // Clipboard access can be denied; the hint stays useful either way.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const details = (
    <div className="fs-caminfo">
      <Meta parts={[title, shot ? `#${String(shot.shotNumber).padStart(2, "0")} ${shot.label}` : "Stage baseline"]} />
      <Meta parts={[`Pitch ${degrees(camera.pitch)}`, `Yaw ${degrees(camera.yaw)}`, `Roll ${degrees(camera.roll)}`]} />
      <Meta parts={[`Distance ${camera.distance.toFixed(2)} m`, `Lens ${lens}mm`, `Gate ${camera.fovDeg.toFixed(1)}°`]} />
      <Meta parts={[`Target ${camera.target.map((value) => value.toFixed(2)).join(", ")}`]} />
      <Meta parts={[`Maneuver ${maneuver}`, cue ? `Easing ${cue.easing}` : ""]} />
      {camera.focusDistanceM !== undefined ? (
        <Meta parts={[`Focus ${camera.focusDistanceM.toFixed(2)} m`, cue?.dof ? `DoF ${cue.dof}` : "", camera.dofNearM !== undefined ? `Near ${camera.dofNearM.toFixed(2)} m` : "", camera.dofFarM !== undefined ? `Far ${camera.dofFarM.toFixed(2)} m` : ""]} />
      ) : null}
      <Meta>Click the capsule to copy this camera as a YAML block.</Meta>
    </div>
  );

  return (
    <div className="fs-camcapsule">
      <Tooltip content={details} focusable>
        <Button variant="secondary" onClick={() => void copy()}>{copied ? `Copied ${lens}mm` : `CAM · ${lens}mm · ${maneuver}`}</Button>
      </Tooltip>
    </div>
  );
}
