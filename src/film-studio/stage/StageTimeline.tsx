/*
 * The timeline block under the stage, top to bottom: the continuous shot
 * timeline (one still per shot, sized by its real length; click seeks, the
 * arrow opens the shot actions), the scene quick-jump tags (#01 … #NN, the
 * active one lit), and the transport centred with the clock.
 */
import {useEffect, useRef} from "react";
import {Pause, Play, Repeat, RotateCcw, Volume2, VolumeX} from "lucide-react";
import {IconButton, Meta, Pill, ShotTimeline, Slider} from "../../ds";
import {formatClock} from "../score/evaluate";
import {geometryCoverage} from "../geometry-synthesis";
import {shotAnalysisLabel, type FilmStudioSession} from "../session";

const shotNumber = (value: number) => `#${String(value).padStart(2, "0")}`;

export function StageTimeline({session, stills, onOpenShot}: {session: FilmStudioSession; stills: Map<string, string>; onOpenShot: (shotId: string) => void}) {
  const score = session.score;
  const active = session.frame.activeShotIndex;
  const activeId = active >= 0 ? score.shots[active]?.id : undefined;
  const tags = useRef<HTMLDivElement>(null);
  const statuses = session.shotStatuses;
  const analysed = statuses.length === score.shots.length && statuses.length > 0;
  const geometries = new Map(session.analysisGeometries.map((geometry) => [geometry.shotIndex, geometry]));
  const coverage = geometryCoverage({geometries: session.analysisGeometries, skips: session.analysisSkips});
  const refining = statuses.filter((status) => status === "refining").length;
  const edited = statuses.filter((status) => status === "edited").length;
  const sections = score.shots.map((shot, index) => ({
    id: shot.id,
    index: shot.shotNumber,
    label: shot.label,
    seconds: Math.max(0.1, shot.endSec - shot.startSec),
    image: stills.get(shot.id),
    // The per-shot analysis state is one quiet Meta fact: measured, estimated, or the status word.
    ...(analysed ? {meta: shotAnalysisLabel(statuses[index], geometries.get(index))} : {}),
  }));
  const jump = (id: string) => {
    const shot = score.shots.find((entry) => entry.id === id);
    if (!shot) return;
    session.seek(shot.startSec + 0.001);
    session.setPlaying(false);
  };

  // Keep the lit tag in view while the film plays through 30 or more shots.
  useEffect(() => {
    const row = tags.current;
    const lit = row?.querySelector<HTMLElement>("[aria-current='true']");
    if (!row || !lit) return;
    const left = lit.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + lit.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollTo({left: left - row.clientWidth / 2 + lit.offsetWidth / 2, behavior: "smooth"});
  }, [activeId]);

  return (
    <div className="fs-timeline">
      <Slider
        aria-label="Timeline"
        className="fs-scrub"
        min={0}
        max={score.durationSec}
        step={0.01}
        value={session.time}
        onChange={(event) => session.seek(Number(event.target.value))}
      />
      <ShotTimeline label="Shots" sections={sections} value={activeId} onSelect={jump} onOpen={onOpenShot} />
      {analysed && (
        <Meta
          parts={[
            coverage.measured.length ? `${coverage.measured.length} measured` : "",
            coverage.estimated.length ? `${coverage.estimated.length} estimated` : "",
            coverage.skipped.length ? `${coverage.skipped.length} skipped` : "",
            refining ? `${refining} measuring` : "",
            edited ? `${edited} edited` : "",
            session.analysisStage,
            session.analysisCache && !session.analysisStage ? (session.analysisCache === "full" ? "from cache" : "cached blockout") : "",
          ]}
        />
      )}
      <div className="fs-transport">
        <div className="fs-tags" ref={tags} role="group" aria-label="Jump to a shot">
          {score.shots.map((shot) => (
            <Pill key={shot.id} quiet={shot.id !== activeId} aria-current={shot.id === activeId} title={shot.label} onClick={() => jump(shot.id)}>
              {shotNumber(shot.shotNumber)}
            </Pill>
          ))}
        </div>
        <div className="fs-transport__keys">
          <Meta parts={[formatClock(session.time), formatClock(score.durationSec)]} />
          <IconButton label="Restart" onClick={() => session.seek(0)}><RotateCcw size={16} /></IconButton>
          <IconButton label={session.playing ? "Pause (Space)" : "Play (Space)"} onClick={() => session.setPlaying(!session.playing)}>
            {session.playing ? <Pause size={18} /> : <Play size={18} />}
          </IconButton>
          <IconButton label={session.loop ? "Loop on" : "Loop off"} aria-pressed={session.loop} onClick={() => session.setLoop(!session.loop)}><Repeat size={16} /></IconButton>
          <IconButton label={session.sound ? "Sound on" : "Sound off"} aria-pressed={session.sound} onClick={() => session.setSound(!session.sound)}>
            {session.sound ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}
