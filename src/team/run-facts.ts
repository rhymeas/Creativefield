/*
 * The one list of facts every result view shows about the run that made it: model, quality,
 * format, length, seed, render time and where it ran. The project feed, the asset full view and
 * the Library viewer all call this, so a fact added here appears everywhere at once.
 */
import type {Run} from "./api";
import {runLocation} from "./job-queue";
import {renderTime} from "./RunDevelop";

export type RunFact = {label: string; value: string};

/**
 * `latest` is the freshest copy of the run (the polled list row): state and times come from it,
 * because a detail fetched while the run was still rendering would otherwise hide the render time
 * for good. `detail` adds the invocation (controls) when it was loaded separately.
 */
export function runFacts(latest: Run, options: {model: string; detail?: Run; /** Unknown (undefined) leaves "Ran on" out instead of guessing. */ cloud?: boolean}): RunFact[] {
  const controls = (options.detail?.invocation ?? latest.invocation)?.controls ?? {};
  const took = renderTime(latest);
  return [
    {label: "Model", value: options.model},
    ...(typeof controls.width === "number" && typeof controls.height === "number"
      ? [{label: "Quality", value: `${controls.width} × ${controls.height}`}]
      : controls.megapixels !== undefined
        ? [{label: "Quality", value: `${controls.megapixels} MP`}]
        : controls.resolution !== undefined
          ? [{label: "Quality", value: String(controls.resolution)}]
          : []),
    ...(controls.aspect_ratio !== undefined ? [{label: "Format", value: String(controls.aspect_ratio).replace(/ \(.*\)$/, "")}] : []),
    ...(controls.length !== undefined ? [{label: "Length", value: `${controls.length} s`}] : []),
    ...(controls.seed !== undefined ? [{label: "Seed", value: String(controls.seed)}] : []),
    ...(took ? [{label: "Render time", value: took}] : []),
    ...(options.cloud !== undefined ? [{label: "Ran on", value: runLocation(latest.transport, options.cloud)}] : []),
  ];
}
