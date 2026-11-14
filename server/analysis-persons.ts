/*
 * SAM 3.1 person masks -> metric person tracks on the measured floor plane.
 *
 * The masks come from the unchanged Video Segmentation (SAM3) blueprint with
 * individual_masks=true. The person pass does NOT run on the full shot clip: the
 * shot's keyframe stills (start/middle/end, 640 px) are encoded into a tiny H.264
 * clip at an explicit frame rate, so SAM3 sees one image per keyframe instead of
 * dozens of video frames (: ~2.9 s vs ~13 s on the same shot). The caller
 * passes the absolute clip seconds of each frame (`frameTimesSec`), so frame i of
 * the mask flattening maps to `frameTimesSec[i]` with no fps arithmetic.
 *
 * ComfyUI flattens individual masks frame-major, object by object: for a shot
 * whose people count is stable (the common single-person case, and any steady
 * multi-person shot) maskCount % frameCount === 0 gives the exact object count
 * per frame and the frame index is exact. When the count varies, masks are
 * assigned proportionally: multi-person shots across uneven detections are best
 * effort, documented limits below.
 *
 * Every mask contributes a head point (top-centre). Two ways to get the root:
 * - feet inside the frame: the bottom-centre pixel's ray hits the floor, and the
 *   head pixel gives a measured height (`heightSource: "mask"`, rawHeightM set);
 * - feet outside the bottom edge (walking towards camera): the head is still
 *   inside, so the root comes from the ~1.7 m height prior - the ray through the
 *   head reaches a point `priorM` above the floor and the root is below it
 *   (`heightSource: "prior"`, confidence ~0.55, rawHeightM not set - the height
 *   was not measured on that keyframe). The prior is the median of the raw
 *   heights measured on usable keyframes, else PERSON_HEIGHT_PRIOR_M (1.75 m);
 *   this is the anchor explicitly allows.
 *
 * A mask is unusable only when its head is also outside the top edge (close-up
 * torso: no point of the person that can be anchored) or the floor ray misses;
 * tiny masks are skipped too. Masks cut by the left/right edge keep their method
 * with reduced confidence.
 */
import sharp from "sharp";
import type {PersonKeyframe, PersonTrack} from "../src/film-studio/analysis-contract";
import {
  groundPointFromHeadPrior,
  groundPointFromPixel,
  HEAD_HEIGHT_ANCHOR_M,
  HEAD_WIDTH_ANCHOR_M,
  PERSON_HEIGHT_ANCHOR_M,
  PERSON_HEIGHT_PRIOR_M,
  personHeightFromMaskTop,
  plausiblePersonHeight,
  type CameraIntrinsics,
  type FloorPlane,
} from "../src/film-studio/geometry";

export type MaskImage = {filename: string; bytes: Buffer};

/** One decoded mask's bounding box, kept so a false-negative rejection can be audited. */
export type MaskDiagnostic = {
  filename: string;
  fileIndex: number;
  width: number;
  height: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  areaRatio: number;
};

export type PersonAnalysisInput = {
  /** Mask PNGs in ComfyUI batch order (the SaveImage counter order). */
  masks: MaskImage[];
  /**
   * Absolute clip seconds of each mask frame, in the person clip's frame order:
   * the shot's keyframe stills, e.g. [start, middle, end] for a 3-frame clip.
   * Frame i of the SAM3 flattening maps to frameTimesSec[i]; no fps math.
   */
  frameTimesSec: number[];
  /** Intrinsics at the mask resolution (width/height are the mask pixel size). */
  intrinsics: CameraIntrinsics;
  floor: FloorPlane;
  /** Masks smaller than this fraction of the frame are ignored (default 0.2 %). */
  minAreaRatio?: number;
};

export type MaskObservation = {
  maskIndex: number;
  frameIndex: number;
  timeSec: number;
  /** Foot point (bottom-centre of the mask) in pixels; for prior-based roots the estimated foot. */
  footPx: number;
  footPy: number;
  /** Head point (top-centre of the mask) in pixels. */
  headPx: number;
  headPy: number;
  areaRatio: number;
  /** Whether the height/root came from the mask's foot pixel or from the ~1.7 m prior. */
  heightSource: "mask" | "prior";
  /** The prior height used when heightSource is "prior". */
  heightPriorM?: number;
  /** Root position in the camera-relative floor frame, metres. */
  xM: number;
  zM: number;
  distanceM: number;
  /** Height measured from the head pixel, before the plausibility bounds; null for prior roots. */
  rawHeightM: number | null;
  heightM: number;
  heightPlausible: boolean;
  confidence: number;
};

export type PersonAnalysis = {
  tracks: PersonTrack[];
  observations: MaskObservation[];
  /** Evidence about how masks were assigned and which were skipped. */
  diagnostics: {
    maskCount: number;
    frameCount: number;
    exactFrameAssignment: boolean;
    masksPerFrame: number | null;
    skipped: Array<{filename: string; reason: string}>;
    skippedCount: number;
    /** Roots whose head-prior ray needed the camera-height fallback (MoGe scale overestimated the camera height). */
    cameraHeightFallbackCount: number;
    /** Raw measured heights of the usable (feet-visible) keyframes, in metres. */
    rawHeightsM: number[];
    /** The prior used for feet-outside-frame keyframes (median measured height, else 1.75 m). */
    heightPriorM: number;
    measuredObservationCount: number;
    priorObservationCount: number;
    /** Bounding box of every decoded mask (audit trail for a "no person root" rejection). */
    maskStats: MaskDiagnostic[];
  };
};

export const DEFAULT_MIN_MASK_AREA_RATIO = 0.002;

type MaskStats = {width: number; height: number; minX: number; maxX: number; minY: number; maxY: number; count: number};

/** Decode a mask PNG and measure its bounding box (MaskToImage writes white-on-black RGB). */
export async function readMaskStats(bytes: Buffer): Promise<MaskStats> {
  const {data, info} = await sharp(bytes, {failOn: "warning"})
    .greyscale()
    .raw()
    .toBuffer({resolveWithObject: true});
  const width = info.width;
  const height = info.height;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] > 127) {
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {width, height, minX, maxX, minY, maxY, count};
}

/** Everything the estimated-geometry path needs from one mask: bbox, row widths, centroid. */
export type MaskProfile = MaskStats & {rowWidths: number[]; centroidX: number};

/** Decode a mask PNG and measure its bounding box, per-row widths and centroid. */
export async function readMaskProfile(bytes: Buffer): Promise<MaskProfile> {
  const {data, info} = await sharp(bytes, {failOn: "warning"})
    .greyscale()
    .raw()
    .toBuffer({resolveWithObject: true});
  const width = info.width;
  const height = info.height;
  const rowWidths = new Array<number>(height).fill(0);
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  let count = 0;
  let sumX = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] > 127) {
        rowWidths[y] += 1;
        count += 1;
        sumX += x;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {width, height, minX, maxX, minY, maxY, count, rowWidths, centroidX: count ? sumX / count : width / 2};
}

/**
 * Head height in pixels from a mask's per-row widths: the head starts at the mask top,
 * and the shoulder row is where the silhouette first grows past ~1.5x the median head
 * width (the head top rows are the narrow baseline). Null when no shoulder line is found.
 */
export function headSizeFromRowWidths(rowWidths: number[], minY: number, maxY: number = rowWidths.length - 1): {anchorPx: number; shoulderRow: number; baselinePx: number} | null {
  if (!rowWidths.length || minY < 0 || minY >= rowWidths.length) return null;
  const bboxHeight = Math.max(1, maxY - minY + 1);
  // The baseline is the median width of the top band (~15 % of the mask bbox): the head rows.
  const bandRows = Math.max(3, Math.round(bboxHeight * 0.15));
  const bandEnd = Math.min(rowWidths.length, Math.min(maxY + 1, minY + bandRows));
  const band = rowWidths.slice(minY, bandEnd);
  if (band.length < 2) return null;
  const baselinePx = median(band);
  if (!baselinePx || baselinePx <= 0) return null;
  // The shoulder line is the first row clearly wider than the head band (>= ~3 rows below the top).
  for (let row = minY + 3; row <= Math.min(maxY, rowWidths.length - 1); row++) {
    if (rowWidths[row] > baselinePx * 1.6) {
      const anchorPx = row - minY;
      if (anchorPx < 4) return null;
      return {anchorPx, shoulderRow: row, baselinePx};
    }
  }
  return null;
}


/**
 * The widest row of the head band (mask top down to ~30 % of the mask height): the head-width
 * fallback anchor for very close faces where no shoulder line separates (0.15 m anchor).
 */
export function headWidthFromRowWidths(rowWidths: number[], minY: number, height: number): number | null {
  if (!rowWidths.length || minY < 0 || minY >= rowWidths.length) return null;
  const bandEnd = Math.max(minY + 1, Math.min(rowWidths.length, minY + Math.max(8, Math.round((Math.max(1, height) - minY) * 0.3))));
  let widest = 0;
  for (let row = minY; row < bandEnd; row++) widest = Math.max(widest, rowWidths[row]);
  return widest >= 4 ? widest : null;
}
/** A size anchor: the real-world size (anchorM) and measured pixel size (anchorPx) that give the distance. */
export type MaskAnchor = {
  /** Contract basis: a full person height or a head (height or, when cut, width). */
  basis: "person-height" | "head-size";
  /** Real-world size of the anchor in metres (1.75 person, 0.2333 head height, 0.15 head width). */
  anchorM: number;
  anchorPx: number;
  centroidPx: number;
  profile: MaskProfile;
  /** The sub-kind of a head-size anchor, for diagnostics. */
  headKind?: "height" | "width";
};

/**
 * The size anchor a person mask offers for the estimated (no-floor) geometry.
 *
 * The HEAD-HEIGHT anchor is preferred whenever the row-width profile shows a shoulder line:
 * the bbox of a torso/face close-up is not a 1.75 m person (mask bottom cut), but the head
 * (~1/7.5 of a body) is a stable size cue. A full-body mask with no detectable head uses the
 * bbox height only when it is genuinely body-shaped (tall bbox, feet inside). A very close
 * face with no shoulder line falls back to the head WIDTH (~0.15 m); nothing usable -> null.
 */
export function classifyMaskAnchor(profile: MaskProfile): MaskAnchor | null {
  if (profile.count === 0) return null;
  const bboxHeight = profile.maxY - profile.minY + 1;
  const bboxWidth = profile.maxX - profile.minX + 1;
  if (bboxHeight < 8) return null;
  // 1. Head height from the shoulder line: the most reliable cue, close-up or full shot.
  if (profile.minY > 2) {
    const head = headSizeFromRowWidths(profile.rowWidths, profile.minY, profile.maxY);
    if (head) {
      return {basis: "head-size", anchorM: HEAD_HEIGHT_ANCHOR_M, anchorPx: head.anchorPx, centroidPx: profile.centroidX, profile, headKind: "height"};
    }
  }
  // 2. Full visible body with no detectable head: head inside, body reaching the frame bottom
  //    and a human body proportion of the frame height (0.35..1.0).
  const frameShare = bboxHeight / Math.max(1, profile.height);
  const looksFullBody = profile.minY > 2 && profile.maxY > profile.height - 3 && frameShare >= 0.35 && frameShare <= 1
    && bboxHeight / Math.max(1, bboxWidth) >= 1.4 && bboxWidth >= Math.max(8, profile.width * 0.03);
  if (looksFullBody) {
    return {basis: "person-height", anchorM: PERSON_HEIGHT_ANCHOR_M, anchorPx: bboxHeight, centroidPx: profile.centroidX, profile};
  }
  // 3. Very close face (wide mask, no shoulder line): the head width is all that is left.
  const headWidth = headWidthFromRowWidths(profile.rowWidths, Math.max(0, profile.minY), profile.height);
  if (headWidth) {
    return {basis: "head-size", anchorM: HEAD_WIDTH_ANCHOR_M, anchorPx: headWidth, centroidPx: profile.centroidX, profile, headKind: "width"};
  }
  // Nothing anchorable: the shot cannot be estimated (honest skip).
  return null;
}
/**
 * Frame index of each mask in ComfyUI's frame-major flattening.
 * Exact when the object count per frame is constant; proportional fallback otherwise.
 */
export function assignMaskFrames(maskCount: number, frameCount: number): {frames: number[]; exact: boolean; masksPerFrame: number | null} {
  if (maskCount <= 0) return {frames: [], exact: true, masksPerFrame: 0};
  if (frameCount <= 0) return {frames: new Array(maskCount).fill(0), exact: false, masksPerFrame: null};
  if (maskCount % frameCount === 0) {
    const masksPerFrame = maskCount / frameCount;
    return {frames: Array.from({length: maskCount}, (_, index) => Math.floor(index / masksPerFrame)), exact: true, masksPerFrame};
  }
  // Best effort: spread the masks proportionally over the clip frames.
  return {frames: Array.from({length: maskCount}, (_, index) => Math.min(frameCount - 1, Math.floor((index * frameCount) / maskCount))), exact: false, masksPerFrame: null};
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Group observations into tracks by temporal continuity (greedy nearest on the floor). */
export function buildPersonTracks(observations: MaskObservation[], frameCount: number): PersonTrack[] {
  type TrackState = {observations: MaskObservation[]; lastFrame: number; lastTimeSec: number; lastX: number; lastZ: number};
  const states: TrackState[] = [];
  /** A person may walk/cross the frame between sparse keyframes: the gate grows with the time gap. */
  const allowedDistanceM = (timeGapSec: number): number => Math.min(6, Math.max(1.5, 3 * Math.max(0, timeGapSec)));
  const maxFrameGap = Math.max(2, Math.round(frameCount * 0.2));
  const ordered = [...observations].sort((a, b) => a.frameIndex - b.frameIndex || a.maskIndex - b.maskIndex);
  for (const observation of ordered) {
    let best: TrackState | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const state of states) {
      // One detection per person per keyframe: two people in the same frame are two tracks.
      if (state.lastFrame === observation.frameIndex) continue;
      if (observation.frameIndex - state.lastFrame > maxFrameGap) continue;
      const distance = Math.hypot(observation.xM - state.lastX, observation.zM - state.lastZ);
      if (distance < allowedDistanceM(observation.timeSec - state.lastTimeSec) && distance < bestDistance) {
        best = state;
        bestDistance = distance;
      }
    }
    if (best) {
      best.observations.push(observation);
      best.lastFrame = observation.frameIndex;
      best.lastTimeSec = observation.timeSec;
      best.lastX = observation.xM;
      best.lastZ = observation.zM;
    } else {
      states.push({observations: [observation], lastFrame: observation.frameIndex, lastTimeSec: observation.timeSec, lastX: observation.xM, lastZ: observation.zM});
    }
  }
  const minObservations = frameCount <= 4 ? 1 : Math.max(2, Math.round(frameCount * 0.15));
  const kept = states
    .filter((state) => state.observations.length >= minObservations)
    .sort((a, b) => b.observations.length - a.observations.length || a.observations[0].frameIndex - b.observations[0].frameIndex);
  return kept.map((state, index) => {
    // Height is only measured on keyframes with the feet inside the frame; a track made
    // only of prior-based roots keeps the prior value and leaves rawHeightM unset.
    const measured = state.observations
      .filter((observation) => observation.heightSource === "mask")
      .map((observation) => observation.rawHeightM)
      .filter((height): height is number => height !== null && Number.isFinite(height));
    const heightMedian = median(measured);
    const measuredHeight = plausiblePersonHeight(heightMedian ?? Number.NaN);
    const priorOnly = median(state.observations.map((observation) => observation.heightM)) ?? PERSON_HEIGHT_PRIOR_M;
    const keyframes: PersonKeyframe[] = state.observations.map((observation) => ({
      timeSec: observation.timeSec,
      xM: Number(observation.xM.toFixed(3)),
      zM: Number(observation.zM.toFixed(3)),
      confidence: Number(observation.confidence.toFixed(3)),
    }));
    // rawHeightM first: a measurement at the clamp boundary stays visible instead of
    // being silently rounded into the 1.2..2.1 m band.
    const rawHeightM = heightMedian === null ? undefined : Number(heightMedian.toFixed(3));
    const heightM = heightMedian === null ? plausiblePersonHeight(priorOnly).heightM : measuredHeight.heightM;
    return {
      id: `person-${index + 1}`,
      ...(rawHeightM === undefined ? {} : {rawHeightM}),
      heightM: Number(heightM.toFixed(3)),
      keyframes,
    };
  });
}

/** Full SAM3 mask -> position/height stage for one shot. */
export async function analyzePersons(input: PersonAnalysisInput): Promise<PersonAnalysis> {
  const minAreaRatio = input.minAreaRatio ?? DEFAULT_MIN_MASK_AREA_RATIO;
  const frameTimesSec = input.frameTimesSec.filter((timeSec) => Number.isFinite(timeSec));
  if (!frameTimesSec.length) throw new Error("The person pass needs at least one keyframe time");
  const frameCount = frameTimesSec.length;
  const frameTime = (frameIndex: number): number => frameTimesSec[Math.min(frameIndex, frameTimesSec.length - 1)];
  const {frames, exact, masksPerFrame} = assignMaskFrames(input.masks.length, frameCount);
  const observations: MaskObservation[] = [];
  let cameraHeightFallbackCount = 0;
  const skipped: Array<{filename: string; reason: string}> = [];
  const maskStats: MaskDiagnostic[] = [];
  if (input.masks.length) {
    const first = await readMaskStats(input.masks[0].bytes);
    if (first.width !== input.intrinsics.width || first.height !== input.intrinsics.height) {
      throw new Error(`SAM3 masks are ${first.width}x${first.height} but the camera intrinsics are for ${input.intrinsics.width}x${input.intrinsics.height}`);
    }
  }
  // Pass 1: decode, classify, and measure every mask whose feet are inside the frame.
  const pendingPrior: Array<{index: number; stats: MaskStats; headPx: number; feetCut: boolean; sideCut: boolean; frameIndex: number}> = [];
  for (let index = 0; index < input.masks.length; index++) {
    const mask = input.masks[index];
    const stats = await readMaskStats(mask.bytes);
    const areaRatio = stats.count / (stats.width * stats.height);
    maskStats.push({filename: mask.filename, fileIndex: index, width: stats.width, height: stats.height, minX: stats.minX, maxX: stats.maxX, minY: stats.minY, maxY: stats.maxY, areaRatio});
    if (stats.count === 0) {
      skipped.push({filename: mask.filename, reason: "empty mask"});
      continue;
    }
    if (areaRatio < minAreaRatio) {
      skipped.push({filename: mask.filename, reason: `too small (${(areaRatio * 100).toFixed(2)} % of frame)`});
      continue;
    }
    if (stats.minY <= 1) {
      // Head outside the top edge: nothing of the person that can be anchored.
      skipped.push({filename: mask.filename, reason: "head outside the top edge (close-up torso; no person root)"});
      continue;
    }
    const headPx = (stats.minX + stats.maxX) / 2;
    const feetCut = stats.maxY >= stats.height - 2;
    const sideCut = stats.minX <= 1 || stats.maxX >= stats.width - 2;
    const frameIndex = frames[index];
    if (!feetCut) {
      const ground = groundPointFromPixel(input.floor, input.intrinsics, headPx, stats.maxY);
      if (!ground) {
        skipped.push({filename: mask.filename, reason: "foot ray misses the floor plane"});
        continue;
      }
      const rawHeightM = personHeightFromMaskTop(input.floor, input.intrinsics, {xM: ground.xM, zM: ground.zM}, {px: headPx, py: stats.minY});
      const measured = plausiblePersonHeight(rawHeightM ?? Number.NaN);
      const areaConfidence = Math.min(1, 0.35 + 0.65 * Math.min(1, areaRatio / 0.04));
      observations.push({
        maskIndex: index,
        frameIndex,
        timeSec: frameTime(frameIndex),
        footPx: headPx,
        footPy: stats.maxY,
        headPx,
        headPy: stats.minY,
        areaRatio,
        heightSource: "mask",
        xM: ground.xM,
        zM: ground.zM,
        distanceM: ground.distanceM,
        rawHeightM,
        heightM: measured.heightM,
        heightPlausible: measured.plausible,
        confidence: areaConfidence * (sideCut ? 0.7 : 1),
      });
    } else {
      // Feet outside the bottom edge: defer to pass 2, where the height prior is known.
      pendingPrior.push({index, stats, headPx, feetCut, sideCut, frameIndex});
    }
  }
  // The prior is the median raw height the usable keyframes measured, else the 1.75 m anchor.
  const measuredHeights = observations.map((observation) => observation.rawHeightM).filter((height): height is number => height !== null && Number.isFinite(height));
  const heightPriorM = median(measuredHeights) ?? PERSON_HEIGHT_PRIOR_M;
  // Pass 2: feet outside the frame -> root from the head ray + height prior (never a measured rawHeightM).
  for (const pending of pendingPrior) {
    const ground = groundPointFromHeadPrior(input.floor, input.intrinsics, {px: pending.headPx, py: pending.stats.minY}, heightPriorM);
    const mask = input.masks[pending.index];
    if (!ground) {
      skipped.push({filename: mask.filename, reason: `feet outside frame and the head ray misses the floor with the ${heightPriorM.toFixed(2)} m prior`});
      continue;
    }
    if (ground.usedCameraHeightFallback) cameraHeightFallbackCount += 1;
    const heightM = plausiblePersonHeight(heightPriorM).heightM;
    observations.push({
      maskIndex: pending.index,
      frameIndex: pending.frameIndex,
      timeSec: frameTime(pending.frameIndex),
      footPx: pending.headPx,
      footPy: pending.stats.maxY,
      headPx: pending.headPx,
      headPy: pending.stats.minY,
      areaRatio: pending.stats.count / (pending.stats.width * pending.stats.height),
      heightSource: "prior",
      heightPriorM,
      xM: ground.xM,
      zM: ground.zM,
      distanceM: ground.distanceM,
      rawHeightM: null,
      heightM,
      heightPlausible: true,
      confidence: (ground.usedCameraHeightFallback ? 0.45 : 0.55) * (pending.sideCut ? 0.7 : 1),
    });
  }
  const tracks = buildPersonTracks(observations, frameCount);
  return {
    tracks,
    observations,
    diagnostics: {
      maskCount: input.masks.length,
      frameCount,
      exactFrameAssignment: exact,
      masksPerFrame,
      skipped,
      skippedCount: skipped.length,
      rawHeightsM: measuredHeights,
      heightPriorM,
      cameraHeightFallbackCount,
      measuredObservationCount: observations.filter((observation) => observation.heightSource === "mask").length,
      priorObservationCount: observations.filter((observation) => observation.heightSource === "prior").length,
      maskStats,
    },
  };
}
