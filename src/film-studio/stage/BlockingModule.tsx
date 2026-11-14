/*
 * The Blocking module, laid out like FotoField: the 3D stage is the work
 * surface in the middle, the boxes on the right (Reference, Scene, Cast and
 * set) fold away and reorder by their grips, and the timeline block runs under
 * both. The stage keeps one control per corner: the shot card (top left),
 * labels (top right), view and framing (bottom left), the camera telemetry
 * (bottom right). Everything is driven by the shared session, so this module
 * can be swapped without losing the playhead.
 */
import {useRef, useState} from "react";
import {Box, Camera, Crosshair, Maximize, MoveHorizontal, MoveVertical} from "lucide-react";
import {Button, Canvas, DockPanel, DockStack, IconButton, InfoButton, Meta, SegmentedTabs} from "../../ds";
import {reorderVisible} from "../../ds/dock-layout";
import {formatClock} from "../score/evaluate";
import type {FilmStudioSession} from "../session";
import {downloadBlob} from "../download";
import {CameraCapsule} from "./CameraCapsule";
import {ReferenceMedia} from "./ReferenceMedia";
import {CameraPackage, CastAndSet, SceneSummary} from "./SceneDesk";
import {ShotActionsDialog} from "./ShotActionsDialog";
import {StageTimeline} from "./StageTimeline";
import {StageViewport, type FramePreset, type LabelMode, type StageViewportHandle, type ViewMode} from "./StageViewport";
import {useShotStills} from "./use-shot-stills";

type BoxId = "reference" | "scene" | "cast";
const BOX_IDS: BoxId[] = ["reference", "scene", "cast"];
type BoxState = {order: BoxId[]; collapsed: Partial<Record<BoxId, boolean>>};
const BOX_KEY = "cf-film-studio-boxes-v1";

function readBoxes(): BoxState {
  try {
    const saved = JSON.parse(localStorage.getItem(BOX_KEY) ?? "null");
    if (saved && Array.isArray(saved.order) && saved.order.length === BOX_IDS.length && BOX_IDS.every((id) => saved.order.includes(id))) return {order: saved.order, collapsed: saved.collapsed ?? {}};
  } catch {
    /* storage unavailable: defaults */
  }
  return {order: [...BOX_IDS], collapsed: {}};
}

const FRAMES: Array<{id: FramePreset; label: string; icon: JSX.Element}> = [
  {id: "fit", label: "Frame the action", icon: <Maximize size={16} />},
  {id: "top", label: "Top view", icon: <MoveVertical size={16} />},
  {id: "front", label: "Front view", icon: <Crosshair size={16} />},
  {id: "side", label: "Side view", icon: <MoveHorizontal size={16} />},
  {id: "iso", label: "Three-quarter view", icon: <Box size={16} />},
];

const shotNumber = (value: number) => `#${String(value).padStart(2, "0")}`;

export function BlockingModule({session}: {session: FilmStudioSession}) {
  const viewport = useRef<StageViewportHandle>(null);
  const score = session.score;
  const shot = session.frame.activeShot;
  // The active shot's measured set: a render-only grey-block overlay from the reference analysis.
  const shotGeometry = session.analysisGeometries.find((geometry) => geometry.shotIndex === session.frame.activeShotIndex);
  const stills = useShotStills(score);
  const openShot = session.shotActions ? score.shots.find((entry) => entry.id === session.shotActions) : undefined;
  const [boxes, setBoxesState] = useState<BoxState>(readBoxes);
  const setBoxes = (update: (state: BoxState) => BoxState) =>
    setBoxesState((state) => {
      const next = update(state);
      try {
        localStorage.setItem(BOX_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable: keep it for this visit */
      }
      return next;
    });

  const capture = async () => {
    const blob = await viewport.current?.capturePng();
    if (blob) downloadBlob(blob, `${score.id}-${formatClock(session.time).replace(/[:.]/g, "-")}.png`);
  };
  const frame = (preset: FramePreset) => {
    viewport.current?.frame(preset);
    session.setPlaying(false);
    session.setView("free");
  };
  const lens = shot?.camera ? `${Math.round(shot.camera.end.lensMm)}mm` : "";
  const focus = session.frame.stageCamera.focusDistanceM;

  const box = (id: BoxId) => {
    const common = {
      key: id,
      id,
      collapsed: !!boxes.collapsed[id],
      onToggle: () => setBoxes((state) => ({...state, collapsed: {...state.collapsed, [id]: !state.collapsed[id]}})),
    };
    if (id === "reference") return <DockPanel {...common} label="Reference" title="Reference"><ReferenceMedia session={session} /></DockPanel>;
    if (id === "scene")
      return (
        <DockPanel {...common} label="Scene" title={score.title} end={<InfoButton title="Camera package"><CameraPackage score={score} /></InfoButton>}>
          <SceneSummary session={session} />
        </DockPanel>
      );
    return <DockPanel {...common} label="Cast and set" title="Cast and set"><CastAndSet session={session} /></DockPanel>;
  };

  return (
    <div className="fs-studio">
      <div className="fs-studio__main">
        <Canvas workspace>
          <div className="fs-stage">
            <StageViewport ref={viewport} score={score} frame={session.frame} view={session.view} labels={session.labels} setBlocks={shotGeometry?.set} onNavigateStart={session.unlockView} />
            <div className="fs-stage__overlay fs-stage__overlay--shot">
              {shot ? (
                <>
                  <Button variant="secondary" onClick={() => session.openShotActions(shot.id)}>{`${shotNumber(shot.shotNumber)}  ${shot.label}`}</Button>
                  <Meta parts={[lens, shot.camera?.maneuver?.toUpperCase() ?? "", focus !== undefined ? `F ${focus.toFixed(1)} m` : "", `${formatClock(shot.startSec)} – ${formatClock(shot.endSec)}`]} />
                </>
              ) : (
                <Meta>Stage baseline</Meta>
              )}
            </div>
            <div className="fs-stage__overlay fs-stage__overlay--labels">
              <SegmentedTabs
                quiet
                label="Labels"
                items={[
                  {id: "all", label: "All"},
                  {id: "cam", label: "Cam"},
                  {id: "off", label: "Off"},
                ]}
                value={session.labels}
                onChange={(value) => session.setLabels(value as LabelMode)}
              />
            </div>
            <div className="fs-stage__overlay fs-stage__overlay--view">
              <div className="fs-stage__tools" role="group" aria-label="Framing">
                {FRAMES.map((entry) => (
                  <IconButton key={entry.id} label={entry.label} onClick={() => frame(entry.id)}>{entry.icon}</IconButton>
                ))}
                <IconButton label="Save still" onClick={() => void capture()}><Camera size={16} /></IconButton>
              </div>
              <SegmentedTabs
                quiet
                label="Viewport camera"
                items={[
                  {id: "scripted", label: "Scripted"},
                  {id: "free", label: "Free orbit"},
                  {id: "stage", label: "Stage cam"},
                ]}
                value={session.view}
                onChange={(value) => session.setView(value as ViewMode)}
              />
            </div>
            <div className="fs-stage__overlay fs-stage__overlay--cam">
              <CameraCapsule session={session} />
            </div>
          </div>
        </Canvas>
        <DockStack className="fs-boxes" onReorder={(order) => setBoxes((state) => ({...state, order: reorderVisible(state.order, order)}))}>
          {boxes.order.map(box)}
        </DockStack>
      </div>
      <StageTimeline session={session} stills={stills} onOpenShot={session.openShotActions} />
      {openShot ? <ShotActionsDialog session={session} shot={openShot} still={stills.get(openShot.id)} onClose={session.closeShotActions} /> : null}
    </div>
  );
}
