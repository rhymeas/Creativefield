/*
 * The reference media panel: a YouTube link, an uploaded clip, or no media for
 * a procedural (no-footage) score. The timeline stays the master clock; the
 * player follows it, so scrubbing the score scrubs the reference.
 *
 * Analysing a clip is progressive (,):
 *   scan -> cached score or cut-only blockout first paint -> vision decision
 *   batches over the whole shot list -> measured geometry batches -> cache commit.
 * The score and the per-shot statuses are updated after every batch, so the
 * studio stays usable while the measurement runs; the batches are sequential,
 * single-flight, and abort when the reference changes. A shot the person edited
 * is never overwritten: a new edit stops the run, and only an explicit
 * "Analyze again" request clears that state (shot-status.ts).
 *
 * When the server analysis routes are not available (or for a YouTube link whose
 * poster is the only frame), the studio keeps the older browser/staging path as
 * the fallback; it produces the same score through the same builder.
 *
 *: a YouTube link is analysed without downloading it. The explicit
 * "Analyze reference" click first probes the analysis cache for the video; a
 * cache hit paints the stored analysis with no capture and no permission
 * prompt. Otherwise the person shares this single tab through getDisplayMedia
 * and `youtube-capture.ts` reads the embedded player: cuts and keyframe stills
 * with player-clock timestamps, sent to the scan-frames route. The captures are
 * progressive (the cut structure is painted while the video runs) and the
 * decisions/geometry/commit loop below is the same one the uploaded clip uses.
 * A browser without tab capture or a denied share keeps the poster draft with
 * exactly one Notice.
 */
import {useCallback, useEffect, useRef, useState} from "react";
import {Button, EmptyState, Meta, PromptField, SegmentedTabs, StatusText, UploadSlot} from "../../ds";
import {shotBatches, scoreHash, type AnalysisScan, type GeometryBatchResult, type ShotDecision, type ShotGeometry, type ShotSkip} from "../analysis-contract";
import {AnalysisClientError, commitAnalysisCache, isFrameScanCacheMiss, requestGeometryBatch, scanReferenceClip, scanReferenceFrames} from "../analysis-client";
import {detectShotCuts, detectShotCutsOnServer, sampleFramesAt, sampleReferenceFrames} from "../analysis";
import {planToScoreYaml, type AnalysisPlan} from "../score-build";
import {classifyGeometryBatch, geometryTargetShots, heuristicPlan, mergeGeometryBatch, type AnalysisShotWindow, type SynthesisReport} from "../geometry-synthesis";
import {buildShotCards, decideShotsWithVision, routeShotAnalysis, visionPlanFromDecisions} from "../decision";
import {analysisCapabilities, localStagingPlan, requestLocalStaging} from "../local-staging";
import {applyShotEvent, initialShotStatuses, nextShotStatus, type ShotStatus} from "../shot-status";
import {youtubeId, youtubeSection, type FilmStudioSession, type ReferenceSource, type YoutubeSection} from "../session";
import {EXAMPLE_SCORES} from "../score/examples";
import {analyseYoutubeVideo, captureEmbeddedPlayer, supportsTabCapture, YouTubePlayerClock, type CaptureProgress} from "../youtube-capture";

type Mode = "none" | "link" | "file";

/** m:ss for a section bound. */
const clockText = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

const modeOf = (reference: ReferenceSource): Mode => (reference.kind === "youtube" ? "link" : reference.kind === "file" ? "file" : "none");

/** True while the open score is still one of the bundled examples (nothing of the person's own work to overwrite). */
const isPristineExample = (scoreText: string) => EXAMPLE_SCORES.some((example) => example.text.trim() === scoreText.trim());

/** A server stage that does not exist (or cannot be reached) falls back to the older path instead of failing. */
const serverStagesMissing = (error: unknown) => error instanceof AnalysisClientError && (error.status === 0 || error.status === 404 || error.status === 501);

/** The middle decision frame of a scan shot; the contract aligns frames with keyframes. */
const middleFrame = (frames: string[]): string => (frames.length ? frames[Math.floor((frames.length - 1) / 2)] : "");

/**
 * The score options that keep a captured YouTube reference in the generated
 * score: reopening the YAML restores the player instead of losing the link.
 */
const referenceOptions = (scan: AnalysisScan, section?: YoutubeSection): {videoUrl?: string} =>
  scan.clip.source === "youtube" && scan.clip.videoId
    ? // The section stays in the link: the rebuilt score must name the same reference, or the
      // studio would see a new one and stop the analysis that is writing it.
      {videoUrl: `https://www.youtube.com/watch?v=${scan.clip.videoId}${section ? `&t=${section.startSec}&end=${section.endSec}` : ""}`}
    : {};

/** YouTube's iframe API only sends its player messages to an embed that was told the parent origin. */
const iframeOrigin = (): string => (typeof window === "undefined" ? "" : `&origin=${encodeURIComponent(window.location.origin)}`);

export function ReferenceMedia({session}: {session: FilmStudioSession}) {
  const [mode, setMode] = useState<Mode>(modeOf(session.reference));
  const [link, setLink] = useState(session.reference.kind === "youtube" ? session.reference.url : "");
  const [linkError, setLinkError] = useState("");
  const [analysing, setAnalysing] = useState(false);
  const [analysisInfo, setAnalysisInfo] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  /** The hidden element the captured tab stream is drawn from (tab capture,). */
  const captureVideo = useRef<HTMLVideoElement>(null);
  /** True while getDisplayMedia runs: the studio's own player sync must not fight the capture. */
  const capturing = useRef(false);
  const player = useRef<YouTubePlayerClock | null>(null);
  const provisionalCuts = useRef(0);
  const lastTime = useRef(session.time);
  const attempted = useRef("");
  const run = useRef<{controller: AbortController; key: string; scanDone: boolean} | null>(null);
  // The loop below runs in a closure that started in an older render; the person may edit the
  // score while a batch is in flight. Reading the newest shell state keeps an edit authoritative.
  const latest = useRef({statuses: session.shotStatuses});
  latest.current = {statuses: session.shotStatuses};
  const reference = session.reference;

  const stopRun = useCallback(() => {
    run.current?.controller.abort();
    run.current = null;
  }, []);

  // The YouTube player clock reads the embed's iframe-API messages; it is the score clock of a
  // capture (the capture never uses the wall clock) and it reports the video duration before the
  // cache probe. One clock per embedded video, disposed when the reference changes.
  const youtubeVideoId = reference.kind === "youtube" ? reference.videoId : "";
  useEffect(() => {
    if (!youtubeVideoId) return;
    const frame = iframe.current;
    if (!frame) return;
    const clock = new YouTubePlayerClock(frame);
    player.current = clock;
    clock.start();
    return () => {
      if (player.current === clock) player.current = null;
      clock.stop();
    };
  }, [youtubeVideoId]);

  // The player follows the score clock: a jump seeks, playing starts and stops the media.
  useEffect(() => {
    const element = video.current;
    if (!element || reference.kind !== "file") return;
    element.muted = !session.sound;
    if (session.playing) void element.play().catch(() => undefined);
    else element.pause();
    const target = Math.min(element.duration || session.score.durationSec, Math.max(0, session.time));
    if (Math.abs(element.currentTime - target) > 0.35) element.currentTime = target;
  }, [session.time, session.playing, session.sound, reference, session.score.durationSec]);

  // YouTube is driven over the embed API; the score clock stays authoritative. While a tab
  // capture runs the capture engine owns the player, so the sync stands aside.
  useEffect(() => {
    const frame = iframe.current;
    if (!frame || reference.kind !== "youtube") return;
    if (capturing.current) return;
    const jumped = Math.abs(session.time - lastTime.current) > 0.35;
    lastTime.current = session.time;
    const command = (func: string, args: unknown[]) => frame.contentWindow?.postMessage(JSON.stringify({event: "command", func, args}), "*");
    // A section starts at its own source second: score time 0 is the section start.
    if (jumped) command("seekTo", [session.time + (reference.section?.startSec ?? 0), true]);
    command(session.sound ? "unMute" : "mute", []);
    if (session.playing) command("playVideo", []);
    else command("pauseVideo", []);
  }, [session.time, session.playing, session.sound, reference]);

  /* ── The progressive server analysis ──────────────────────────────────── */

  /** Apply one plan through the shell, so the editor and the timeline see the same score. */
  const applyPlan = useCallback(
    (plan: AnalysisPlan, scan: AnalysisScan): {yaml: string; shots: number} => {
      const cuts = scan.clip.cuts;
      // Cut count and shot count must agree, otherwise the plan's own times are already the truth.
      const authoritative = cuts.length > 0 && cuts.length + 1 === scan.shots.length;
      const built = planToScoreYaml(plan, {
        durationSec: scan.clip.durationSec,
        aspectRatio: scan.clip.aspectRatio,
        ...(authoritative ? {cuts} : {}),
        ...referenceOptions(scan, reference.kind === "youtube" ? reference.section : undefined),
      });
      const failure = session.applyGeneratedScore(built.yaml);
      if (failure) throw new Error(failure);
      return built;
    },
    [session],
  );

  /**
   * The progressive loop shared by an uploaded clip and a captured YouTube embed:
   * first paint -> vision decisions -> measured geometry -> cache commit. Throws;
   * the caller turns the error into the studio's one problem Notice.
   */
  const runAnalysisScan = useCallback(
    async (workspaceId: string, scan: AnalysisScan, title: string, signal: AbortSignal, explicit: boolean) => {
      const aborted = () => signal.aborted;
      if (aborted()) return;
      const windows: AnalysisShotWindow[] = scan.shots.map((shot) => ({shotIndex: shot.index, startSec: shot.startSec, endSec: shot.endSec}));
      const shotCount = scan.shots.length;
      const editedAtStart = new Set<number>();
      let statuses: ShotStatus[] = scan.statuses.length === shotCount ? [...scan.statuses] : initialShotStatuses(shotCount);
      if (explicit) {
        // An explicit request is the only way out of the edited state (shot-status.ts).
        statuses = statuses.map((status) => nextShotStatus(status, "reanalyze"));
      }
      statuses.forEach((status, index) => {
        if (status === "edited") editedAtStart.add(index);
      });
      session.setShotStatuses(statuses);
      // `full` means a usable score is cached; `pending` says whether stages are still missing, so a
      // partial refine (score committed, geometry running) continues from the cache instead of stopping.
      const nothingPending = !scan.pending.decisions && !scan.pending.geometry;
      session.setAnalysisCache(scan.cache.stage === "full" && nothingPending ? "full" : "partial");
      if (scan.scoreYaml?.trim()) setAnalysisInfo(`Cached score: ${shotCount} ${shotCount === 1 ? "shot" : "shots"} in ${scan.timings.totalMs} ms.`);
      const geometries = new Map<number, ShotGeometry>((scan.geometries ?? []).map((geometry) => [geometry.shotIndex, geometry]));
      session.setAnalysisGeometries([...geometries.values()].sort((left, right) => left.shotIndex - right.shotIndex));
      // Per-shot reasons (no person, a refused floor) are notes for the Geometry module, not Notices.
      // A skip is persisted with the cache, so a repeat scan does not retry a shot that cannot be measured.
      const skips = new Map<number, ShotSkip>((scan.skips ?? []).map((skip) => [skip.shotIndex, skip]));
      const shotNotes: Record<number, string> = {};
      for (const skip of skips.values()) shotNotes[skip.shotIndex] = skip.reason;
      session.setAnalysisShotNotes({...shotNotes});
      session.setAnalysisSkips([...skips.values()].sort((left, right) => left.shotIndex - right.shotIndex));
      const setNote = (shotIndex: number, note: string | null) => {
        if (note) shotNotes[shotIndex] = note;
        else delete shotNotes[shotIndex];
        session.setAnalysisShotNotes({...shotNotes});
      };
      const addSkip = (shotIndex: number, reason: string) => {
        // The server accepts up to 1200 characters for a stored skip reason; keep the persisted
        // value inside that contract (floor attempts can produce a long three-attempt sentence).
        skips.set(shotIndex, {shotIndex, reason: reason.slice(0, 1200)});
        setNote(shotIndex, reason);
        session.setAnalysisSkips([...skips.values()].sort((left, right) => left.shotIndex - right.shotIndex));
      };
      // A skipped shot stays a rough blockout (never "measuring"); an edit still wins over the skip.
      for (const skip of skips.values()) if (statuses[skip.shotIndex] && statuses[skip.shotIndex] !== "edited") statuses[skip.shotIndex] = "blockout";
      session.setShotStatuses(statuses);
      // First paint: the cached score, or the cut-only blockout. The server may answer an empty
      // scoreYaml on a cache miss/partial hit (the studio owns the first paint), so build it here.
      const cuts = scan.clip.cuts ?? [];
      const authoritativeCuts = cuts.length > 0 && cuts.length + 1 === shotCount;
      const firstPaint = scan.scoreYaml?.trim()
        ? scan.scoreYaml
        : planToScoreYaml(
            {title, premise: "Shot boundaries detected; positions and blocking are being measured."},
            {durationSec: scan.clip.durationSec, aspectRatio: scan.clip.aspectRatio, ...(authoritativeCuts ? {cuts} : {}), ...referenceOptions(scan, reference.kind === "youtube" ? reference.section : undefined)},
          ).yaml;
      const failure = session.applyGeneratedScore(firstPaint);
      if (failure) throw new Error(failure);
      // From here on the run yields to the person's edits: a new `edited` status aborts it (see the effect).
      if (run.current) run.current.scanDone = true;
      let built = {yaml: firstPaint, shots: shotCount};
      if (scan.cache.stage === "full" && nothingPending) {
        setAnalysisInfo(`Cached analysis: ${shotCount} ${shotCount === 1 ? "shot" : "shots"} in ${scan.timings.totalMs} ms.`);
        return;
      }
      // The person's live edit wins over the local copy of the run: before each automatic apply
      // the shell statuses are read again, and a new "edited" stops the loop before it can write.
      const syncStatuses = (): ShotStatus[] => {
        const shell = latest.current.statuses;
        if (shell.length !== statuses.length) return statuses;
        const merged = statuses.map((status, index) => (shell[index] === "edited" ? "edited" : status));
        statuses = merged;
        return statuses;
      };
      const newlyEdited = () => latest.current.statuses.some((status, index) => status === "edited" && !editedAtStart.has(index));
      const stopBecauseEdited = () => {
        setAnalysisInfo("Stopped because you edited the score. Analyze again to measure the edited shots.");
      };
      let decisions: ShotDecision[] = [...(scan.decisions ?? [])];
      let plan = heuristicPlan(decisions, windows, title);
      // A cached score is already on screen; only rebuild it when the decisions are still missing.
      if (scan.pending.decisions || !scan.scoreYaml?.trim()) built = applyPlan(plan, scan);

      /**
       * Persist what is known so far: after the decision stage and after every geometry batch.
       * The server merges per shot, so an interrupted or slow refine still leaves a cached
       * score for the next scan (cache.stage/partial + pending.geometry), instead of losing
       * the whole run. The final commit below upgrades the row to complete.
       */
      const storeProgress = async (): Promise<void> => {
        if (aborted()) return;
        try {
          const stored = await commitAnalysisCache(workspaceId, {
            cacheKey: scan.cacheKey,
            decisions,
            geometries: [...geometries.values()],
            skips: [...skips.values()],
            scoreYaml: built.yaml,
            scoreHash: scoreHash(built.yaml),
            statuses,
          });
          if (!aborted()) session.setAnalysisCache(stored.complete ? "full" : "partial");
        } catch (reason) {
          // A progress write is best effort; the final commit reports the real state.
          console.warn("The partial analysis could not be stored; the final commit will try again.", reason);
        }
      };

      // Vision decisions, sequential batches over the whole shot list (the score updates after each).
      if (scan.pending.decisions) {
        for (const batch of shotBatches(shotCount)) {
          if (aborted()) return;
          syncStatuses();
          const pending = batch.indices.filter((index) => !decisions.some((decision) => decision.shotIndex === index) && statuses[index] !== "edited");
          if (!pending.length) continue;
          session.setAnalysisStage(`Reading shots ${batch.start + 1}–${batch.start + batch.indices.length} of ${shotCount}`);
          const frames: string[] = [];
          const indices: number[] = [];
          for (const index of pending) {
            const frame = middleFrame(scan.shots[index]?.frames ?? []);
            if (frame) {
              frames.push(frame);
              indices.push(index);
            }
          }
          if (!frames.length) continue;
          const vision = await decideShotsWithVision(workspaceId, frames, indices);
          if (aborted()) return;
          // Never write a batch over an edit made while that batch was in flight.
          if (newlyEdited()) {
            stopBecauseEdited();
            return;
          }
          if (!vision) continue;
          const fresh: ShotDecision[] = vision.decisions.map(({index, decision}) => ({
            shotIndex: index,
            people: decision.people,
            size: decision.size,
            motion: decision.motion,
            // The stored decision schema takes whole numbers; the model's confidence is fractional.
            needsStaging: Math.max(0, Math.round(decision.needsStaging)),
          }));
          decisions = [...decisions, ...fresh].sort((left, right) => left.shotIndex - right.shotIndex);
          plan = heuristicPlan(decisions, windows, title);
          built = applyPlan(plan, scan);
          statuses = applyShotEvent(statuses, "blockoutReady", indices);
          session.setShotStatuses(statuses);
          if (newlyEdited()) {
            stopBecauseEdited();
            return;
          }
        }
      }

      // Every shot that is not measured, edited or already a confirmed skip is requested. The
      // decision pass does not pre-filter: a d3 people_count of 0 is not authoritative, the server
      // confirms (SAM3 keyframe check) and returns the skip reason itself.
      const editedNow = statuses.map((status, index) => (status === "edited" ? index : -1)).filter((index) => index >= 0);
      const targets = geometryTargetShots({
        shotCount,
        decisions,
        measuredShotIndices: [...geometries.keys()],
        editedShotIndices: editedNow,
        skippedShotIndices: [...skips.keys()],
      });
      const targetSet = new Set(targets.targets);
      // The decisions are cached before the slow geometry stage starts.
      if (scan.pending.decisions) await storeProgress();

      // Measured geometry, sequential batches; per-shot refusals fall back to the rough blockout.
      let lastReport: SynthesisReport | null = null;
      let geometryError: string | null = null;
      if (scan.pending.geometry) {
        for (const batch of shotBatches(shotCount)) {
          if (aborted()) return;
          syncStatuses();
          const pending = batch.indices.filter((index) => targetSet.has(index) && !geometries.has(index) && statuses[index] !== "edited");
          if (!pending.length) continue;
          const measuring = `Measuring shots ${batch.start + 1}–${batch.start + batch.indices.length} of ${shotCount}`;
          session.setAnalysisStage(measuring);
          statuses = applyShotEvent(statuses, "refineStarted", pending);
          session.setShotStatuses(statuses);
          // A real 8-shot batch can take many minutes. The wait is one await (the UI stays usable);
          // the stage line ticks so a long measurement never looks frozen, and an edit aborts it.
          const batchStarted = Date.now();
          const ticker = window.setInterval(() => {
            if (aborted()) return;
            const elapsed = Math.floor((Date.now() - batchStarted) / 1000);
            session.setAnalysisStage(`${measuring} · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`);
          }, 1000);
          let result: GeometryBatchResult;
          try {
            result = await requestGeometryBatch(workspaceId, {cacheKey: scan.cacheKey, shotIndices: pending}, {signal});
          } catch (reason) {
            if (aborted()) return;
            statuses = applyShotEvent(statuses, "geometryFailed", pending);
            session.setShotStatuses(statuses);
            geometryError = reason instanceof Error ? reason.message : "The geometry batch failed.";
            break;
          } finally {
            window.clearInterval(ticker);
          }
          if (aborted()) return;
          // A person edit during the (possibly minutes long) batch wins: stop before merging it.
          if (newlyEdited()) {
            stopBecauseEdited();
            return;
          }
          for (const geometry of result.geometries ?? []) geometries.set(geometry.shotIndex, geometry);
          session.setAnalysisGeometries([...geometries.values()].sort((left, right) => left.shotIndex - right.shotIndex));
          const measuredIndices = (result.geometries ?? []).map((geometry) => geometry.shotIndex);
          for (const measuredIndex of measuredIndices) setNote(measuredIndex, null);
          // The server's confirmed skip reasons (no usable floor / no person root) become persisted
          // skips with a quiet note; anything else stays a real failure and gets the one Notice.
          const outcome = classifyGeometryBatch(result);
          for (const skip of outcome.skips) addSkip(skip.shotIndex, skip.reason);
          for (const [noteIndex, note] of Object.entries(outcome.notes)) setNote(Number(noteIndex), note);
          const failedIndices = (result.errors ?? []).map((error) => error.shotIndex);
          const realFailures = outcome.failures;
          const editedIndices = statuses.map((status, index) => (status === "edited" ? index : -1)).filter((index) => index >= 0);
          const merged = mergeGeometryBatch(plan, result.geometries ?? [], {shots: windows, aspectRatio: scan.clip.aspectRatio, editedShotIndices: editedIndices});
          plan = merged.plan;
          lastReport = merged.report;
          built = applyPlan(plan, scan);
          statuses = applyShotEvent(statuses, "geometryFailed", failedIndices);
          statuses = applyShotEvent(statuses, "geometryReady", measuredIndices.filter((index) => !failedIndices.includes(index)));
          session.setShotStatuses(statuses);
          // Every measured batch is stored immediately: a slow refine never loses earlier shots.
          await storeProgress();
          if (realFailures.length) {
            const detail = realFailures.slice(0, 3).map((error) => `#${String(error.shotIndex + 1).padStart(2, "0")}: ${error.message}`).join(" · ");
            session.setAnalysisProblem({title: "Some shots could not be measured", detail: `${realFailures.length} of ${pending.length} shots fell back to the rough blockout. ${detail}`});
          }
          if (newlyEdited()) {
            stopBecauseEdited();
            return;
          }
        }
      }

      // The cache commit makes the next identical scan an instant hit; a partial commit keeps decisions.
      session.setAnalysisStage("Saving the analysis");
      try {
        const measuredSoFar = statuses.filter((status) => status === "spatial" || status === "edited").length;
        const estimatedSoFar = [...geometries.values()].filter((geometry) => geometry.quality === "estimated").length;
        const measuredExact = Math.max(0, measuredSoFar - estimatedSoFar);
        const skipCount = skips.size;
        // A skipped shot counts as covered by the stage; only a real failure or a stopped stage is not.
        const complete = measuredSoFar + skipCount >= shotCount && !geometryError;
        const commit = await commitAnalysisCache(workspaceId, {
          cacheKey: scan.cacheKey,
          decisions,
          geometries: [...geometries.values()],
          skips: [...skips.values()],
          scoreYaml: built.yaml,
          scoreHash: scoreHash(built.yaml),
          statuses,
        });
        session.setAnalysisCache(complete && commit.complete ? "full" : "partial");
        // Measured and estimated shots are counted separately: an estimated close-up has a camera
        // and a position but no floor, and must never be presented as a measured one.
        const coveredText = [
          `${measuredExact} measured`,
          estimatedSoFar ? `${estimatedSoFar} estimated` : "",
          `${skipCount} skipped`,
        ].filter(Boolean).join(" · ");
        setAnalysisInfo(
          complete
            ? `${coveredText}${lastReport?.rejectedCount ? ` · ${lastReport.rejectedCount} impossible values refused` : ""}. Cached for the next run.`
            : `${coveredText}; the rest keep the rough blockout. The analysis cache is partial.`,
        );
      } catch (reason) {
        if (aborted()) return;
        // The score is already applied: a cache miss on the next run is not a user-facing failure.
        console.warn("The analysis cache could not be stored.", reason);
        setAnalysisInfo(`${shotCount} shots analysed; the cache could not be stored, so the next run measures again.`);
      }
      if (geometryError) session.setAnalysisProblem({title: "The geometry stage stopped", detail: geometryError});
    },
    [applyPlan, session],
  );

  /** One upload scan run: the server hashes/analyses the clip, then the shared progressive loop runs. */
  const analyseOnServer = useCallback(
    async (workspaceId: string, clip: Blob, filename: string, signal: AbortSignal, explicit: boolean) => {
      const scan = await scanReferenceClip(workspaceId, clip, {signal, filename});
      if (signal.aborted) return;
      await runAnalysisScan(workspaceId, scan, `Reference: ${filename}`, signal, explicit);
    },
    [runAnalysisScan],
  );

  /* ── The browser/staging fallback for YouTube and servers without the analysis stages ── */

  /** The older sampling + local staging path: same score builder, no server analysis stages. */
  const analyseWithBrowser = useCallback(
    async (workspaceId: string, signal: AbortSignal): Promise<boolean> => {
      if (reference.kind === "youtube") {
        // No cloud provider: the poster is fetched by our server and the local vision model reads it.
        session.setAnalysisStage("Reading the YouTube poster");
        const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/youtube-poster`, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          credentials: "same-origin",
          body: JSON.stringify({videoId: reference.videoId}),
        });
        const payload = (await response.json().catch(() => null)) as {frame?: string; error?: string} | null;
        if (!response.ok || !payload?.frame) throw new Error(payload?.error ?? "The YouTube poster could not be loaded.");
        session.setAnalysisStage("Local staging (vision model)");
        const staging = await requestLocalStaging(workspaceId, [payload.frame]);
        const built = planToScoreYaml(localStagingPlan(staging.shots, [0], `YouTube: ${reference.videoId}`), {
          videoUrl: reference.url,
          titleHint: "YouTube reference",
          durationSec: 12,
          aspectRatio: 16 / 9,
        });
        const failure = session.applyGeneratedScore(built.yaml);
        if (failure) throw new Error(failure);
        setAnalysisInfo(`Draft from the YouTube poster in ${staging.ms} ms (${staging.model}); duration and movement are estimated.`);
        return true;
      }
      if (reference.kind !== "file") throw new Error("Add a clip or a YouTube link before analysing.");
      session.setAnalysisStage("Finding shot cuts");
      let detected: Awaited<ReturnType<typeof detectShotCutsOnServer>> | null = null;
      try {
        if (!reference.blob) throw new Error("The clip is not available for a server scan.");
        detected = await detectShotCutsOnServer(workspaceId, reference.blob, reference.name);
      } catch (reason) {
        console.warn("Server shot scan failed; using the browser fallback.", reason);
        detected = null;
      }
      if (!detected) {
        try {
          detected = await detectShotCuts(reference.url);
        } catch {
          detected = null;
        }
      }
      if (signal.aborted) return true;
      if (!detected) throw new Error("The clip's shots could not be detected.");
      const cuts = detected.cuts;
      const shotCount = cuts.length ? cuts.length + 1 : detected.shots.length;
      let durationSec = detected.durationSec;
      let aspectRatio = detected.aspectRatio;
      let frames: string[] = [];
      let analyzed: number[] = [];
      session.setShotStatuses(initialShotStatuses(shotCount));
      session.setAnalysisGeometries([]);
      session.setAnalysisShotNotes({});
      session.setAnalysisSkips([]);
      if (cuts.length) {
        const triage = routeShotAnalysis(buildShotCards(cuts, durationSec), {maxFrames: 8});
        analyzed = triage.analyze.map((card) => card.index);
        session.setAnalysisStage(`Reading ${analyzed.length} of ${shotCount} shots`);
        const times = triage.analyze.map((card) => card.start + card.durationSec * 0.65);
        frames = (await sampleFramesAt(reference.url, times)).frames;
      } else {
        session.setAnalysisStage("Reading the reference");
        const sampled = await sampleReferenceFrames(reference.url, 6);
        frames = sampled.frames;
        durationSec = sampled.durationSec;
        aspectRatio = sampled.aspectRatio;
      }
      if (signal.aborted) return true;
      const scoreOptions = {titleHint: reference.name, durationSec, aspectRatio, ...(cuts.length ? {cuts} : {}), ...(analyzed.length ? {analyzedShotIndices: analyzed} : {})};
      const caps = await analysisCapabilities(workspaceId);
      if (cuts.length && analyzed.length && frames.length) {
        session.setAnalysisStage("Fast blockout (local vision)");
        try {
          const vision = await decideShotsWithVision(workspaceId, frames, analyzed);
          if (vision) {
            const visionPlan = visionPlanFromDecisions(vision.decisions, `Reference: ${reference.name}`);
            const fast = planToScoreYaml(visionPlan, scoreOptions);
            if (!session.applyGeneratedScore(fast.yaml)) setAnalysisInfo(`Fast blockout: ${vision.decisions.length} of ${shotCount} shots from local vision decisions in ${vision.ms} ms (d3:2b).`);
          }
        } catch {
          // The precise local staging pass below may still work.
        }
      }
      let stagingApplied = false;
      let stagingError = "";
      if (caps.staging && cuts.length && analyzed.length && frames.length) {
        session.setAnalysisStage("Local staging (vision model)");
        try {
          const staging = await requestLocalStaging(workspaceId, frames);
          if (!staging.shots.some(Boolean)) throw new Error(`The local vision model returned no usable shot descriptions (${staging.model}).`);
          const built = planToScoreYaml(localStagingPlan(staging.shots, analyzed, `Reference: ${reference.name}`), scoreOptions);
          const failure = session.applyGeneratedScore(built.yaml);
          if (failure) throw new Error(failure);
          stagingApplied = true;
          setAnalysisInfo(`Local staging: ${staging.shots.filter(Boolean).length} of ${shotCount} shots in ${staging.ms} ms (${staging.model}); the browser fallback places positions generically.`);
        } catch (reason) {
          stagingError = reason instanceof Error ? reason.message : "Local staging failed.";
        }
      }
      if (!stagingApplied) {
        if (!cuts.length) throw new Error(stagingError || "No local shot description could be built for this clip.");
        const cutOnly = planToScoreYaml({title: `Reference: ${reference.name}`, premise: "Shot boundaries were detected locally; staging is unavailable."}, scoreOptions);
        const failure = session.applyGeneratedScore(cutOnly.yaml);
        if (failure) throw new Error(failure);
        setAnalysisInfo(`${shotCount} shots detected; ${cutOnly.shots} rebuilt from the cut structure.${stagingError ? ` Local staging is unavailable (${stagingError}).` : ""}`);
      }
      return true;
    },
    [reference, session],
  );

  /* ── The YouTube tab-capture path ───────────────────────────── */

  /** Put the embed back under the score clock after a capture (the engine leaves it muted and paused). */
  const restorePlayer = useCallback(() => {
    const clock = player.current;
    if (!clock) return;
    clock.command(session.sound ? "unMute" : "mute", []);
    clock.command("pauseVideo", []);
    clock.command("seekTo", [Math.max(0, session.time), true]);
  }, [session]);

  /**
   * Analyse the embedded player without downloading it: the cache probe comes first (a second
   * analysis of the same link never asks for the tab), then one tab capture, then the shared
   * progressive loop. An unsupported browser, a denied share or a player that never starts keeps
   * the poster draft and sets exactly one Notice.
   */
  const analyseYoutube = useCallback(
    async (workspaceId: string, videoId: string, signal: AbortSignal, explicit: boolean) => {
      const frame = iframe.current;
      const hidden = captureVideo.current;
      const clock = player.current;
      if (!frame || !hidden || !clock) {
        // The player surface is not mounted: keep today's poster draft working.
        await analyseWithBrowser(workspaceId, signal);
        return;
      }
      provisionalCuts.current = 0;
      await analyseYoutubeVideo({
        videoId,
        ...(reference.kind === "youtube" && reference.section ? {section: reference.section} : {}),
        explicit,
        signal,
        iframe: frame,
        video: hidden,
        clock,
        fps: 8,
        maxDurationSec: 900,
        playerDuration: () => clock.durationSec,
        probe: async (request) => {
          try {
            return await scanReferenceFrames(workspaceId, request, {signal});
          } catch (error) {
            // A video that was never analysed answers the frames-less probe with the route's
            // "needs its keyframe stills" refusal: that is a cache miss, not a failure.
            if (isFrameScanCacheMiss(error)) return null;
            throw error;
          }
        },
        scanFrames: (request) => scanReferenceFrames(workspaceId, request, {signal}),
        capture: (options) => {
          // While the capture owns the player, the studio's own sync must not pause or seek it.
          capturing.current = true;
          try {
            return captureEmbeddedPlayer(options);
          } finally {
            capturing.current = false;
          }
        },
        supportsTabCapture: () => supportsTabCapture(),
        runScan: (scan) => runAnalysisScan(workspaceId, scan, `YouTube: ${videoId}`, signal, explicit),
        posterDraft: async () => {
          await analyseWithBrowser(workspaceId, signal);
        },
        notice: (notice) => session.setAnalysisProblem(notice),
        stage: (text) => session.setAnalysisStage(text),
        info: (text) => setAnalysisInfo(text),
        // Provisional first paint: the cut structure fills in while the player runs, before the scan.
        onProgress: (progress: CaptureProgress) => {
          if (!progress.cuts.length || progress.cuts.length === provisionalCuts.current) return;
          provisionalCuts.current = progress.cuts.length;
          const durationSec = progress.durationSec > 0 ? progress.durationSec : Math.max(1, progress.playerTimeSec + 1);
          const built = planToScoreYaml(
            {title: `YouTube: ${videoId}`, premise: "Shot boundaries are detected while the reference plays; the blocking is measured after the capture."},
            {durationSec, aspectRatio: 16 / 9, cuts: progress.cuts},
          );
          session.applyGeneratedScore(built.yaml);
        },
      });
    },
    [analyseWithBrowser, runAnalysisScan, session],
  );

  /* ── The one analysis entry point ─────────────────────────────────────── */

  const analyse = useCallback(
    async (explicit = true) => {
      stopRun();
      const workspace = session.workspace;
      session.setAnalysisProblem(null);
      session.setAnalysisStage("");
      setAnalysisInfo("");
      if (!workspace) {
        session.setAnalysisProblem({title: "No workspace selected", detail: "Choose a workspace before analysing a reference."});
        return;
      }
      const controller = new AbortController();
      run.current = {controller, key: reference.kind === "youtube" ? `${reference.videoId}${reference.section ? `@${reference.section.startSec}-${reference.section.endSec}` : ""}` : reference.kind === "file" ? reference.url : "", scanDone: false};
      setAnalysing(true);
      try {
        if (reference.kind === "youtube") {
          try {
            await analyseYoutube(workspace.id, reference.videoId, controller.signal, explicit);
          } catch (reason) {
            if (controller.signal.aborted) return;
            if (serverStagesMissing(reason)) {
              // The captured-analysis route is not live yet: keep today's poster draft working.
              console.warn("The captured analysis route is unavailable; using the poster draft.", reason);
              await analyseWithBrowser(workspace.id, controller.signal);
              return;
            }
            throw reason;
          } finally {
            if (!controller.signal.aborted) restorePlayer();
          }
          return;
        }
        if (reference.kind !== "file") throw new Error("Add a clip or a YouTube link before analysing.");
        if (!reference.blob) {
          await analyseWithBrowser(workspace.id, controller.signal);
          return;
        }
        const clip: Blob = reference.blob;
        try {
          await analyseOnServer(workspace.id, clip, reference.name, controller.signal, explicit);
        } catch (reason) {
          if (controller.signal.aborted) return;
          if (serverStagesMissing(reason)) {
            // The server analysis stages are not live yet: keep the older path working end to end.
            console.warn("Server analysis stages unavailable; using the browser fallback.", reason);
            await analyseWithBrowser(workspace.id, controller.signal);
            return;
          }
          throw reason;
        }
      } catch (reason) {
        if (controller.signal.aborted) return;
        session.setAnalysisProblem({title: "The reference could not be analysed", detail: reason instanceof Error ? reason.message : "The reference could not be analysed."});
      } finally {
        if (run.current?.controller === controller) {
          run.current = null;
          setAnalysing(false);
          session.setAnalysisStage("");
        }
      }
    },
    [analyseOnServer, analyseWithBrowser, analyseYoutube, reference, restorePlayer, session, stopRun],
  );

  // A reference change or leaving the studio cancels the running analysis: single-flight, cancellable.
  // It runs before the auto-analysis effect, so a changed reference cancels the old run and starts the new one.
  const analysisKey = reference.kind === "youtube" ? `youtube:${reference.videoId}${reference.section ? `@${reference.section.startSec}-${reference.section.endSec}` : ""}` : reference.kind === "file" ? `file:${reference.url}` : "";
  useEffect(() => {
    stopRun();
  }, [analysisKey, stopRun]);
  useEffect(() => () => stopRun(), [stopRun]);

  // An edit during a batch aborts the run immediately (a geometry batch can take many minutes):
  // the person's score wins, the measuring shots fall back to their blockout, and the loop ends.
  useEffect(() => {
    const active = run.current;
    if (!active?.scanDone || !analysing || active.controller.signal.aborted) return;
    const statuses = session.shotStatuses;
    if (!statuses.some((status) => status === "edited")) return;
    active.controller.abort();
    session.setAnalysisStage("");
    session.setShotStatuses(statuses.map((status) => (status === "refining" ? "blockout" : status)));
    setAnalysisInfo("Stopped because you edited the score. Analyze again to measure the edited shots.");
  }, [session.shotStatuses, analysing, session]);

  // Adding a reference analyses it once, but only while the score is still a bundled example.
  // This is an automatic run (`explicit = false`): a cached full hit keeps its measured statuses
  // instead of pushing every spatial shot back to refining.
  useEffect(() => {
    if (!analysisKey || attempted.current === analysisKey) return;
    attempted.current = analysisKey;
    if (isPristineExample(session.scoreText)) void analyse(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisKey]);

  const useLink = () => {
    const id = youtubeId(link);
    if (!id) {
      setLinkError("Paste a YouTube watch, share or Shorts link.");
      return;
    }
    setLinkError("");
    const section = youtubeSection(link);
    session.setReference({kind: "youtube", url: link.trim(), videoId: id, ...(section ? {section} : {})});
  };

  const analysisPanel = (
    <div className="fs-reference__analysis">
      <Button variant="secondary" onClick={() => void analyse()} disabled={analysing}>
        {analysing ? "Analysing reference" : analysisInfo ? "Analyze again" : "Analyze reference"}
      </Button>
      {analysing && <StatusText tone="active">{session.analysisStage || "Reading the reference and writing the scene"}</StatusText>}
      {analysisInfo && <Meta>{analysisInfo}</Meta>}
    </div>
  );

  return (
    <div className="fs-reference">
      <SegmentedTabs
        quiet
        label="Reference video"
        items={[
          {id: "none", label: "No video"},
          {id: "link", label: "YouTube"},
          {id: "file", label: "Clip"},
        ]}
        value={mode}
        onChange={(next) => {
          setMode(next);
          if (next === "none") session.setReference({kind: "procedural"});
          if (next === "link" && reference.kind !== "youtube") session.setReference({kind: "none"});
          if (next === "file" && reference.kind !== "file") session.setReference({kind: "none"});
        }}
      />
      {mode === "none" && <EmptyState plain title="No reference video" text="The stage and camera work on their own. Add a clip or a YouTube link to line the blocking up against real footage." />}
      {mode === "link" && reference.kind !== "youtube" && (
        <>
          <PromptField label="YouTube link" value={link} onChange={(value) => { setLink(value); setLinkError(""); }} placeholder="https://www.youtube.com/watch?v=…" />
          <div className="fs-reference__actions"><Button variant="secondary" onClick={useLink}>Use this link</Button></div>
          {linkError && <Meta>{linkError}</Meta>}
        </>
      )}
      {mode === "link" && reference.kind === "youtube" && (
        <>
          <div className="fs-reference__player">
            <iframe
              ref={iframe}
              title="Reference video"
              src={`https://www.youtube.com/embed/${reference.videoId}?enablejsapi=1&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3${reference.section ? `&start=${Math.floor(reference.section.startSec)}` : ""}${iframeOrigin()}`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
            {/* The captured tab is read from this hidden element; it never holds a file, only the live stream. */}
            <video ref={captureVideo} className="fs-reference__capture" playsInline muted aria-hidden />
          </div>
          {reference.section && <Meta>{`Section ${clockText(reference.section.startSec)}–${clockText(reference.section.endSec)} (${Math.round(reference.section.endSec - reference.section.startSec)} s)`}</Meta>}
          {analysisPanel}
        </>
      )}
      {mode === "file" && reference.kind !== "file" && (
        <UploadSlot
          label="Reference clip"
          hint="Drop a clip or choose a file"
          accept="video/mp4,video/webm,video/quicktime"
          kinds={["video"]}
          previewKind="video"
          onFile={(file: File | null) => {
            if (file) session.setReference({kind: "file", name: file.name, url: URL.createObjectURL(file), blob: file});
          }}
        />
      )}
      {mode === "file" && reference.kind === "file" && (
        <>
          <div className="fs-reference__player"><video ref={video} src={reference.url} playsInline muted={!session.sound} /></div>
          <div className="fs-reference__actions"><Meta>{reference.name}</Meta></div>
          {analysisPanel}
        </>
      )}
      {reference.kind === "procedural" && <Meta>The score runs without footage: a procedural clock keeps the timeline.</Meta>}
      {reference.kind === "file" && reference.url.startsWith("blob:") && <Meta>Local file, kept in this browser only.</Meta>}
    </div>
  );
}

/** The same upload box used by the panel, shown from the timeline (works with `openSlot` below). */
export function ReferenceUploadSlot({onFile}: {onFile: (file: File | null) => void}) {
  return (
    <UploadSlot
      label="Reference clip"
      hint="Drop a clip or choose a file"
      accept="video/mp4,video/webm,video/quicktime"
      kinds={["video"]}
      compact
      previewKind="video"
      onFile={onFile}
    />
  );
}
