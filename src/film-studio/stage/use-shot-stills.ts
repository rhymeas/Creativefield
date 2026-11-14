/*
 * Rectangular wireframe stills for the shot timeline. Rendered once per parsed
 * score in the scene's own aspect ratio, so a 2.39:1 score shows wide sections
 * and a 16:9 score shows 16:9 ones.
 */
import {useEffect, useState} from "react";
import type {StageScore} from "../score/schema";
import {renderShotStills} from "./shot-capture";

export function useShotStills(score: StageScore): Map<string, string> {
  const [stills, setStills] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let alive = true;
    let rendered: Map<string, string>;
    try {
      rendered = renderShotStills(score);
    } catch {
      // No WebGL (or a lost context): the timeline falls back to empty sections.
      return;
    }
    if (alive) setStills(rendered);
    return () => {
      alive = false;
    };
  }, [score]);
  return stills;
}
