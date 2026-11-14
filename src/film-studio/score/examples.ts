/*
 * Two original example scores that ship with Film Studio. They are authored the
 * way the StageFlow manual teaches the format (documentation only — no study
 * files are copied), and together they exercise every part of the reader: flow
 * maps, comments, aliases, a blocking timeline that spans cuts, an arc, an
 * orbit, DoF focus and a decoupled observer camera.
 */

export type ExampleScore = {id: string; title: string; text: string};

const TWO_SHOT = `# Two-shot dialogue: the smallest score that uses both a dolly and a cut.
version: "1.0"
id: "two-shot-dialogue"
title: "Two-shot: the letter"
description: "A detective slides a letter across the table while the witness watches."
video: "procedural://two-shot"
aspect_ratio: "16:9"
duration: 8.0

stage:
  width: 9
  depth: 9
  observer_camera: { target: [0, 1.1, 0], distance: 6.8, pitch: 24, yaw: 32, lens: 35mm }

entities:
  - id: "detective"
    label: "Detective"
    kind: "character"
    position: [-1.1, 0, 0.4]
    rotation: 90
    color: "#38bdf8"
  - id: "witness"
    label: "Witness"
    kind: "character"
    position: [1.1, 0, 0.2]
    rotation: -90
    color: "#f59e0b"
  - id: "table"
    label: "Table"
    kind: "prop"
    shape: "box"
    position: [0, 0, 0]
    width: 1.6
    height: 0.76
    depth: 0.8
    color: "#94a3b8"

shots:
  - id: "wide"
    label: "Wide: the two of them"
    description: "Slow push toward the table between them."
    start: 0.0
    end: 4.2
    stage_camera:
      target: ["detective", "witness"]
      maneuver: "dolly"
      distance_start: 5.4
      distance_end: 3.3
      pitch: 12
      yaw: 0
      lens: 35mm
  - id: "close"
    label: "Close: the letter"
    start: 4.2
    end: 8.0
    stage_camera:
      target: "table"
      maneuver: "cut"
      distance: 1.9
      pitch: 16
      yaw: 18
      lens: 85mm
`;

const WALK_AND_TALK = `# Walk and talk: one continuous walk under three cuts and a diorama orbit.
version: "1.0"
id: "walk-and-talk"
title: "Walk and talk: the corridor"
description: "Two colleagues cross a corridor in one unbroken walk while the camera cuts twice and the diorama keeps orbiting."
video: "procedural://walk-and-talk"
aspect_ratio: "2.39:1"
duration: 16.0
offset: 0.0

metadata:
  music: "A slow drum loop"
  camera_package:
    camera: "ARRI Alexa Mini LF"
    stabilizer: "Steadicam M-2"
  production_notes:
    - "Cross behind the second mark at 00:09.0s"
    - "Keep the door frame on the right third"

stage:
  width: 16
  depth: 12
  grid_step: 1
  observer_camera: { target: [0, 1.1, 0], distance: 9.5, pitch: 30, yaw: 40, lens: 35mm }

entities:
  - { id: "ada", label: "Ada", kind: "character", position: [-4, 0, 1.5], rotation: 90, color: "#38bdf8" }
  - { id: "bram", label: "Bram", kind: "character", position: [-4.6, 0, 1.1], rotation: 90, color: "#f59e0b" }
  - { id: "door", label: "Door frame", kind: "prop", shape: "box", position: [3.4, 0, -2.2], width: 0.9, height: 2.1, depth: 0.24, color: "#94a3b8" }
  - { id: "vector_disc", label: "Vector Disc", kind: "prop", shape: "cylinder", position: [0, 0, 0.6], width: 1.1, height: 0.14, depth: 1.1, color: "#e2b53c" }
  - { id: "glyph_north", label: "North Glyph Node", kind: "marker", shape: "circle", style: "glow", position: [0, 0, -4.5], color: "#fbbf24" }
  - { id: "glyph_south", label: "South Glyph Node", kind: "marker", shape: "circle", style: "glow", position: [0, 0, 4.5], color: "#fbbf24" }
  - { id: "glyph_east", label: "East Glyph Node", kind: "marker", shape: "circle", style: "glow", position: [5.5, 0, 0], color: "#38bdf8" }
  - { id: "glyph_west", label: "West Glyph Node", kind: "marker", shape: "circle", style: "glow", position: [-5.5, 0, 0], color: "#f59e0b" }
  - { id: "mark_a", label: "Mark A", kind: "marker", shape: "t", position: [-4, 0, 1.5], color: "#fb7185" }

blocking:
  - id: "ada-cross"
    entity: "ada"
    start: 0.0
    duration: 12.0
    position: [3.2, 0, 1.0]
    easing: "cruise"
    look_at: "bram"
  - id: "bram-cross"
    entity: "bram"
    start: 0.0
    duration: 12.0
    position: [2.4, 0, 1.8]
    easing: "cruise"
    look_at: "ada"
  - id: "bram-at-the-door"
    start: 13.0
    duration: 2.0
    entities:
      bram: { height: 1.2, rotation: 180, highlighted: true }

shots:
  - id: "wide-master"
    label: "Wide master"
    start: 0.0
    end: 5.0
    stage_camera: { target: ["ada", "bram"], maneuver: "dolly", distance_start: 7.2, distance_end: 5.6, pitch: 10, yaw: 0, lens: 35mm }
  - id: "steadi-lead"
    label: "Steadicam lead"
    start: 5.0
    end: 10.5
    stage_camera: { target: "ada", maneuver: "arc", distance: 2.9, pitch: 8, yaw_start: -22, yaw_end: 26, easing: "cruise", lens: 50mm }
  - id: "door-close"
    label: "Close by the door"
    start: 10.5
    end: 16.0
    stage_camera: { target: "ada", maneuver: "orbit", distance: 2.4, pitch: 6, yaw: 20, revolutions: 0.5, direction: "ccw", lens: 85mm, focus: "ada", dof: "shallow" }

observer_shots:
  - id: "obs-master"
    start: 0.0
    end: 16.0
    target: "center"
    maneuver: "orbit"
    easing: "cruise"
    distance: 9.5
    pitch: 28
    yaw_start: 40
    yaw_end: 120
    lens: 35mm
`;

export const EXAMPLE_SCORES: ExampleScore[] = [
  {id: "two-shot", title: "Two-shot dialogue", text: TWO_SHOT},
  {id: "walk-and-talk", title: "Walk and talk", text: WALK_AND_TALK},
];

export const DEFAULT_SCORE = WALK_AND_TALK;
export const DEFAULT_SCORE_TITLE = "Walk and talk: the corridor";
