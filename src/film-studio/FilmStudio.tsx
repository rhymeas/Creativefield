/*
 * Film Studio: a modular 3D choreography workspace inside CreativeField.
 *
 * It reads StageFlow-style `*.yaml` choreography scores (scene, entities,
 * blocking timeline, film shots, observer camera) into the deterministic
 * evaluator, shows the grey-block diorama with the reference video, and keeps
 * the score editable and exportable. The studio is built from the design
 * system components only; the modules in `modules.ts` are the extension point
 * for analysis, generation and other later modes.
 */
import {useEffect, useMemo, useRef, useState} from "react";
import {ChevronLeft} from "lucide-react";
import {Button, Dialog, IconButton, Meta, ModeTabs, Notice, Page, PromptField, Row, Toolbar} from "../ds";
import type {Project, Workspace} from "../team/api";
import type {VideoHandoff} from "../capabilities/shot-direction";
import {DEFAULT_SCORE, EXAMPLE_SCORES} from "./score/examples";
import {evaluateFrame} from "./score/evaluate";
import {parseStageScore} from "./score/parse";
import type {StageScore, YamlDiagnostic} from "./score/schema";
import {FILM_STUDIO_MODULES} from "./modules";
import {downloadText} from "./download";
import {changedShotIndices, referenceFromUrl, type FilmStudioModuleId, type FilmStudioSession, type ReferenceSource} from "./session";
import {initialShotStatuses, nextShotStatus, type ShotStatus} from "./shot-status";
import type {AnalysisCacheState, ShotGeometry, ShotSkip} from "./analysis-contract";
import type {LabelMode, ViewMode} from "./stage/StageViewport";
import "./film-studio.css";

export type FilmStudioProps = {
  workspace?: Workspace;
  project?: Project;
  canCreate?: boolean;
  /** Leaves the studio and returns to the shot generator the app already had. */
  onOpenShotGenerator?: () => void;
  /** Hands a rendered grey-block clip to the AI video flow (wired by the app shell later). */
  onSendToVideo?: (assetId: string, handoff?: VideoHandoff) => void;
};

const firstScore = (): {text: string; score: StageScore; warnings: YamlDiagnostic[]} => {
  const parsed = parseStageScore(DEFAULT_SCORE);
  if (!parsed.score) throw new Error(parsed.error ?? "The bundled example score did not parse.");
  return {text: DEFAULT_SCORE, score: parsed.score, warnings: parsed.diagnostics};
};

export function FilmStudio(props: FilmStudioProps) {
  const initial = useRef<{text: string; score: StageScore; warnings: YamlDiagnostic[]} | null>(null);
  if (!initial.current) initial.current = firstScore();
  const boot = initial.current;
  const [scoreText, setScoreText] = useState(boot.text);
  const [score, setScore] = useState<StageScore>(boot.score);
  const [warnings, setWarnings] = useState<YamlDiagnostic[]>(boot.warnings);
  const [error, setError] = useState("");
  const [time, setTime] = useState(0);
  const timeRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [sound, setSound] = useState(false);
  const [reference, setReference] = useState<ReferenceSource>(() => referenceFromUrl(boot.score.videoUrl));
  const [view, setView] = useState<ViewMode>("scripted");
  const [labels, setLabels] = useState<LabelMode>("all");
  const [module, setModule] = useState<FilmStudioModuleId>("blocking");
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState("");
  const [exampleId, setExampleId] = useState(EXAMPLE_SCORES[0].id);
  const [shotActions, setShotActions] = useState("");
  // Progressive analysis is a shell-level state: the timeline, the shot cards and the
  // media panel all read the same per-shot status list.
  const [shotStatuses, setShotStatuses] = useState<ShotStatus[]>([]);
  const [analysisStage, setAnalysisStage] = useState("");
  const [analysisCache, setAnalysisCache] = useState<AnalysisCacheState["stage"] | null>(null);
  const [analysisProblem, setAnalysisProblem] = useState<{title: string; detail: string} | null>(null);
  const [analysisGeometries, setAnalysisGeometries] = useState<ShotGeometry[]>([]);
  const [analysisShotNotes, setAnalysisShotNotes] = useState<Record<number, string>>({});
  const [analysisSkips, setAnalysisSkips] = useState<ShotSkip[]>([]);

  const frame = useMemo(() => evaluateFrame(score, time), [score, time]);
  const active = FILM_STUDIO_MODULES.find((entry) => entry.id === module) ?? FILM_STUDIO_MODULES[0];
  const ActiveModule = active.Component;

  const seek = (target: number) => {
    const clamped = Math.min(score.durationSec, Math.max(0, Number.isFinite(target) ? target : 0));
    timeRef.current = clamped;
    setTime(clamped);
  };

  // Playback is the only clock: the evaluator stays pure, the playhead moves once per frame.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const delta = Math.max(0, (now - last) / 1000);
      last = now;
      let next = timeRef.current + delta;
      if (next >= score.durationSec) {
        if (loop) {
          next = 0;
        } else {
          timeRef.current = score.durationSec;
          setTime(score.durationSec);
          setPlaying(false);
          return;
        }
      }
      timeRef.current = next;
      setTime(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, score.durationSec, loop]);

  useEffect(() => {
    if (timeRef.current > score.durationSec) seek(score.durationSec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score.durationSec]);

  const applyScore = (text: string, options: {userEdit?: boolean} = {}): string => {
    const parsed = parseStageScore(text);
    if (!parsed.score) return parsed.error ?? "The score did not parse.";
    // Deterministic edit rule (session.ts): a user-applied score marks the shots whose data it changed.
    if (options.userEdit && shotStatuses.length) {
      if (shotStatuses.length !== parsed.score.shots.length) {
        setShotStatuses(initialShotStatuses(parsed.score.shots.length));
      } else {
        const changed = new Set(changedShotIndices(score, parsed.score));
        if (changed.size) setShotStatuses(shotStatuses.map((status, index) => (changed.has(index) ? nextShotStatus(status, "userEdited") : status)));
      }
    }
    setScoreText(text);
    setScore(parsed.score);
    setWarnings(parsed.diagnostics);
    setError("");
    setPlaying(false);
    seek(0);
    const nextReference = referenceFromUrl(parsed.score.videoUrl);
    if (nextReference.kind !== "none") setReference(nextReference);
    return "";
  };

  const openEditor = () => {
    setDraft(scoreText);
    setDraftError("");
    setExampleId(EXAMPLE_SCORES.find((entry) => entry.text === scoreText)?.id ?? EXAMPLE_SCORES[0].id);
    setEditorOpen(true);
  };

  const applyDraft = () => {
    const failure = applyScore(draft, {userEdit: true});
    if (failure) setDraftError(failure);
    else setEditorOpen(false);
  };

  // Keyboard shortcuts of the reference studio: Space play/pause, arrows seek, Home/End, L cycles labels.
  const keyboard = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyboard.current = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (editorOpen) return;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
    if (event.key === " ") {
      event.preventDefault();
      setPlaying((value) => !value);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      seek(timeRef.current + (event.shiftKey ? -5 : -1));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      seek(timeRef.current + (event.shiftKey ? 5 : 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      seek(0);
    } else if (event.key === "End") {
      event.preventDefault();
      seek(score.durationSec);
    } else if (event.key.toLowerCase() === "l") {
      setLabels((value) => (value === "all" ? "cam" : value === "cam" ? "off" : "all"));
    }
  };
  useEffect(() => {
    const handle = (event: KeyboardEvent) => keyboard.current(event);
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);

  const session: FilmStudioSession = {
    workspace: props.workspace,
    project: props.project,
    canCreate: props.canCreate ?? false,
    score,
    frame,
    scoreText,
    time,
    playing,
    loop,
    sound,
    reference,
    view,
    labels,
    module,
    error,
    warnings,
    canSendToVideo: !!props.onSendToVideo,
    seek,
    setPlaying,
    setLoop,
    setSound,
    setModule,
    setView,
    setLabels,
    setReference,
    // The reference app releases the scripted camera to a free orbit when the user grabs the stage.
    unlockView: () => {
      setPlaying(false);
      setView("free");
    },
    openEditor,
    exportScore: () => downloadText(scoreText, `${score.id || "choreography"}.yaml`),
    applyGeneratedScore: (yaml: string) => applyScore(yaml),
    sendToVideo: props.onSendToVideo,
    shotStatuses,
    setShotStatuses,
    analysisStage,
    setAnalysisStage,
    analysisCache,
    setAnalysisCache,
    analysisProblem,
    setAnalysisProblem,
    analysisGeometries,
    setAnalysisGeometries,
    analysisShotNotes,
    setAnalysisShotNotes,
    analysisSkips,
    setAnalysisSkips,
    shotActions,
    openShotActions: setShotActions,
    closeShotActions: () => setShotActions(""),
  };
  // The one main action: render the shot under the playhead (or the first one before it starts).
  const renderTarget = frame.activeShot?.id ?? score.shots[0]?.id;

  return (
    <Page workspace>
      <div className="fs-shell">
        <Toolbar
          className="fs-modebar"
          end={
            <div className="fs-actions">
              <Button variant="secondary" onClick={openEditor}>Edit score</Button>
              <Button variant="secondary" onClick={session.exportScore}>Export</Button>
              {renderTarget && <Button variant="primary" onClick={() => setShotActions(renderTarget)}>Render shot</Button>}
            </div>
          }
        >
          <div className="fs-modebar__start">
            {props.onOpenShotGenerator && <IconButton label="Back to Block a shot" onClick={props.onOpenShotGenerator}><ChevronLeft size={16} /></IconButton>}
            {warnings.length > 0 && <Meta>{warnings.length === 1 ? warnings[0].message : `${warnings.length} parser notes`}</Meta>}
          </div>
          {FILM_STUDIO_MODULES.length > 1 && (
            <ModeTabs label="Film Studio mode" items={FILM_STUDIO_MODULES.map((entry) => ({id: entry.id, label: entry.title}))} value={module} onChange={(id) => setModule(id)} />
          )}
        </Toolbar>
        {error && (
          <Notice priority={20} title="The score was not applied" details={error} actions={<Button variant="secondary" onClick={openEditor}>Edit score</Button>}>
            Nothing else was changed.
          </Notice>
        )}
        {/* One problem at a time: the analysis problem flows into the single ProblemBar, never a second area. */}
        {analysisProblem && (
          <Notice priority={30} title={analysisProblem.title} details={analysisProblem.detail}>
            The score stays usable. Use Analyze reference in the Reference panel to try again.
          </Notice>
        )}
        <div className="fs-body">
          <ActiveModule session={session} />
        </div>
      </div>
      <Dialog
        open={editorOpen}
        title="Choreography score"
        wide
        onClose={() => setEditorOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditorOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={applyDraft}>Apply score</Button>
          </>
        }
      >
        <div className="fs-editor">
          <Row
            label="Example"
            display={EXAMPLE_SCORES.find((entry) => entry.id === exampleId)?.title ?? "Choose an example"}
            value={exampleId}
            options={EXAMPLE_SCORES.map((entry) => ({value: entry.id, label: entry.title}))}
            onChange={(id) => {
              const example = EXAMPLE_SCORES.find((entry) => entry.id === id);
              if (!example) return;
              setExampleId(id);
              setDraft(example.text);
              setDraftError("");
            }}
          />
          <PromptField
            label="Score (YAML)"
            value={draft}
            onChange={(value) => {
              setDraft(value);
              setDraftError("");
            }}
            placeholder={'version: "1.0"\ntitle: "My scene"\nentities:\n  - { id: "hero", kind: "character", position: [0, 0, 0] }'}
          />
          {draftError && <Notice priority={30} title="The score has a problem" details={draftError}>Fix the score and apply it again.</Notice>}
        </div>
      </Dialog>
    </Page>
  );
}
