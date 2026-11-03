import { cameraMove, type CameraKey, type StageAspect, type StageProp, type StageScene } from "./stage";

/** Ready-made sets to block a shot in: plain scene data, grey stand-ins for what the finished shot will show. */
type SetDef = { id: string; name: string; text: string; props: StageProp[]; camera: CameraKey; lens: number };
const prop = (id: string, type: StageProp["type"], pos: StageProp["pos"], size: StageProp["size"], extra: Partial<StageProp> = {}): StageProp => ({ id, type, pos, size, rot: 0, ...extra });

export const SETS: SetDef[] = [
  {
    id: "courtyard", name: "Courtyard", text: "One person between a crate and a pillar, a wall behind.", lens: 35,
    camera: { pos: [0, 1.55, 7.5], target: [0, 1.1, 0] },
    props: [prop("fig", "figure", [0, 0, 0], [0.5, 1.8, 0.3]), prop("crate", "box", [-1.9, 0, 0.6], [1.4, 1, 1.1], { rot: 18 }), prop("pillar", "cylinder", [2, 0, -0.8], [0.7, 3.2, 0.7]), prop("wall", "wall", [0, 0, -3.2], [10, 3.6, 0.3])],
  },
  {
    id: "street", name: "Street", text: "A narrow street between two walls, one person walking away.", lens: 28,
    camera: { pos: [0, 1.6, 8], target: [0, 1.4, -2] },
    props: [
      prop("left", "wall", [-3.2, 0, -2], [0.3, 6, 22], { rot: 0 }), prop("right", "wall", [3.2, 0, -2], [0.3, 6, 22]),
      prop("end", "wall", [0, 0, -13], [7, 6, 0.3]), prop("walker", "figure", [0.4, 0, 1.5], [0.5, 1.8, 0.3], { to: [0.1, 0, -4] }),
      prop("bin", "cylinder", [-2.3, 0, -1], [0.7, 1, 0.7]), prop("van", "box", [2.1, 0, -4.5], [1.8, 1.8, 4]),
    ],
  },
  {
    id: "crowd", name: "Square", text: "Five people at different distances, one crossing the square.", lens: 40,
    camera: { pos: [0, 1.6, 9], target: [0, 1.2, 0] },
    props: [
      prop("a", "figure", [-2.4, 0, 1.5], [0.5, 1.75, 0.3]), prop("b", "figure", [-0.8, 0, -1], [0.5, 1.85, 0.3]), prop("c", "figure", [1.6, 0, 0.5], [0.5, 1.7, 0.3]),
      prop("d", "figure", [3, 0, -2.5], [0.5, 1.8, 0.3]), prop("walker", "figure", [-4, 0, 0], [0.5, 1.8, 0.3], { to: [4, 0, 0.8] }),
      prop("fountain", "cylinder", [0, 0, -4], [2.4, 0.9, 2.4]), prop("back", "wall", [0, 0, -8], [16, 5, 0.3]),
    ],
  },
];
export const setById = (id: string) => SETS.find((s) => s.id === id);

export function buildScene(setId: string, moveId: string, aspect: StageAspect): StageScene {
  const set = setById(setId), move = cameraMove(moveId);
  if (!set) throw new Error(`Unknown set: ${setId}`);
  if (!move) throw new Error(`Unknown camera move: ${moveId}`);
  return { v: 1, props: set.props.map((p) => ({ ...p, size: [...p.size], pos: [...p.pos] as StageProp["pos"] })), keys: move.make(set.camera).map((k) => ({ pos: [...k.pos], target: [...k.target] })), lens: set.lens, aspect };
}
