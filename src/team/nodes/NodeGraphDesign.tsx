import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MousePointer2 } from "lucide-react";
import { Canvas, IconButton, InlineSelect, InlineSlider, LinkButton, Meta, Node, PanelSection, SectionHeader, StatusText, Toolbar } from "../../ds";
import "./node-graph-design.css";

/* Design prototype for a ComfyField-native node graph. Static data, no ComfyUI connection yet.
   Built only from design-system parts, so it can be matched into the app once it looks right. */

const NODE_W = 220;
const HEAD_H = 36;
const ROW_H = 22;
const BODY_TOP = 12;

type Port = { name: string };
type Widget =
  | { kind: "select"; key: string; label: string; options: string[] }
  | { kind: "slider"; key: string; label: string; min: number; max: number; unit?: string };

type NodeModel = {
  id: string;
  title: string;
  category: string;
  x: number;
  y: number;
  inputs: Port[];
  outputs: Port[];
  widgets: Widget[];
};

const NODES: NodeModel[] = [
  { id: "model", title: "Load Diffusion Model", category: "Loader", x: 40, y: 56, inputs: [], outputs: [{ name: "MODEL" }],
    widgets: [{ kind: "select", key: "model", label: "Model", options: ["flux-2-klein-4b", "flux-2-dev", "qwen-image-edit"] }] },
  { id: "shift", title: "Model Sampling", category: "Advanced", x: 300, y: 56, inputs: [{ name: "model" }], outputs: [{ name: "MODEL" }],
    widgets: [{ kind: "slider", key: "shift", label: "Shift", min: 0, max: 10, unit: "" }] },
  { id: "clip", title: "Load CLIP", category: "Loader", x: 40, y: 276, inputs: [], outputs: [{ name: "CLIP" }],
    widgets: [
      { kind: "select", key: "encoder", label: "Text encoder", options: ["qwen_3_4b", "t5xxl"] },
      { kind: "select", key: "clipType", label: "Type", options: ["lumina2", "flux", "sd3"] },
    ] },
  { id: "pos", title: "Positive prompt", category: "Conditioning", x: 300, y: 252, inputs: [{ name: "clip" }], outputs: [{ name: "CONDITIONING" }],
    widgets: [] },
  { id: "neg", title: "Negative prompt", category: "Conditioning", x: 300, y: 432, inputs: [{ name: "clip" }], outputs: [{ name: "CONDITIONING" }],
    widgets: [] },
  { id: "latent", title: "Empty Latent Image", category: "Latent", x: 300, y: 612, inputs: [], outputs: [{ name: "LATENT" }],
    widgets: [
      { kind: "slider", key: "width", label: "Width", min: 256, max: 2048, unit: "px" },
      { kind: "slider", key: "height", label: "Height", min: 256, max: 2048, unit: "px" },
    ] },
  { id: "sampler", title: "KSampler", category: "Sampling", x: 580, y: 120,
    inputs: [{ name: "model" }, { name: "positive" }, { name: "negative" }, { name: "latent_image" }], outputs: [{ name: "LATENT" }],
    widgets: [
      { kind: "slider", key: "steps", label: "Steps", min: 1, max: 50, unit: "" },
      { kind: "slider", key: "guidance", label: "Guidance", min: 0, max: 10, unit: "" },
      { kind: "select", key: "sampler", label: "Sampler", options: ["res_multistep", "euler", "dpmpp_2m"] },
      { kind: "select", key: "scheduler", label: "Scheduler", options: ["simple", "karras", "normal"] },
    ] },
  { id: "decode", title: "VAE Decode", category: "Latent", x: 860, y: 120, inputs: [{ name: "samples" }, { name: "vae" }], outputs: [{ name: "IMAGE" }], widgets: [] },
  { id: "save", title: "Save Image", category: "Output", x: 1100, y: 120, inputs: [{ name: "images" }], outputs: [], widgets: [] },
];

const LINKS: Array<{ from: [string, number]; to: [string, number] }> = [
  { from: ["model", 0], to: ["shift", 0] },
  { from: ["clip", 0], to: ["pos", 0] },
  { from: ["clip", 0], to: ["neg", 0] },
  { from: ["shift", 0], to: ["sampler", 0] },
  { from: ["pos", 0], to: ["sampler", 1] },
  { from: ["neg", 0], to: ["sampler", 2] },
  { from: ["latent", 0], to: ["sampler", 3] },
  { from: ["sampler", 0], to: ["decode", 0] },
  { from: ["decode", 0], to: ["save", 0] },
];

/** Where a port sits on the canvas: inputs on the left edge, outputs on the right. */
function portPoint(node: NodeModel, side: "in" | "out", index: number) {
  const y = node.y + HEAD_H + BODY_TOP + index * ROW_H + ROW_H / 2;
  return { x: side === "in" ? node.x : node.x + NODE_W, y };
}

const COLUMNS = { width: 1340, height: 760 };

export function NodeGraphDesign() {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [selected, setSelected] = useState<string | null>("sampler");
  const [values, setValues] = useState<Record<string, string | number>>({
    model: "flux-2-klein-4b", shift: 3, encoder: "qwen_3_4b", clipType: "lumina2", steps: 8, guidance: 1, sampler: "res_multistep",
    scheduler: "simple", width: 1024, height: 1024,
  });
  const [tool, setTool] = useState<"select" | "hand">("select");
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const nodes = NODES.map((n) => ({ ...n, ...(positions[n.id] ?? {}) }));
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

  const onHeadDown = (event: ReactPointerEvent<HTMLElement>, node: NodeModel) => {
    setSelected(node.id);
    const rect = event.currentTarget.parentElement!.parentElement!.getBoundingClientRect();
    drag.current = { id: node.id, dx: event.clientX - rect.left - node.x, dy: event.clientY - rect.top - node.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHeadMove = (event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const stage = event.currentTarget.parentElement!.parentElement!.getBoundingClientRect();
    const x = Math.max(0, Math.round(event.clientX - stage.left - d.dx));
    const y = Math.max(0, Math.round(event.clientY - stage.top - d.dy));
    setPositions((p) => ({ ...p, [d.id]: { x, y } }));
  };
  const onHeadUp = () => { drag.current = null; };

  const selectedNode = selected ? byId[selected] : undefined;

  const widgetControl = (w: Widget) => {
    if (w.kind === "select") {
      return (
        <InlineSelect
          key={w.key}
          label={w.label}
          value={String(values[w.key])}
          options={w.options.map((o) => ({ value: o, label: o }))}
          onChange={(v) => setValues((s) => ({ ...s, [w.key]: v }))}
        />
      );
    }
    return (
      <InlineSlider
        key={w.key}
        label={w.label}
        min={w.min}
        max={w.max}
        unit={w.unit ?? ""}
        value={Number(values[w.key])}
        onChange={(v) => setValues((s) => ({ ...s, [w.key]: v }))}
      />
    );
  };

  return (
    <div className="ndg">
      <Canvas
        toolbarStart={
          <div className="ndg__title">
            <SectionHeader large title="Node design preview" meta={<Meta parts={["Example graph", "Preview only"]} />} />
          </div>
        }
        toolbarEnd={
          <LinkButton variant="secondary" href="#nodes">Open node editor</LinkButton>
        }
      >
        <div className="ndg__body">
          <div className="ndg__rail" role="toolbar" aria-label="Tools">
            <IconButton label="Select" aria-pressed={tool === "select"} onClick={() => setTool("select")}><MousePointer2 size={16} /></IconButton>
          </div>

          <div className="ndg__stage" data-tool={tool}>
            <svg className="ndg__links" width={COLUMNS.width} height={COLUMNS.height} aria-hidden>
              {LINKS.map((l, i) => {
                const a = portPoint(byId[l.from[0]], "out", l.from[1]);
                const b = portPoint(byId[l.to[0]], "in", l.to[1]);
                const mid = Math.max(60, Math.abs(b.x - a.x) / 2);
                return <path key={i} d={`M ${a.x} ${a.y} C ${a.x + mid} ${a.y}, ${b.x - mid} ${b.y}, ${b.x} ${b.y}`} />;
              })}
            </svg>

            {nodes.map((node) => (
              <Node
                key={node.id}
                className="ndg-node"
                title={node.title}
                selected={selected === node.id}
                x={node.x} y={node.y} width={NODE_W}
                onPointerDown={() => setSelected(node.id)}
                header={<header
                  className="ndg-node__head"
                  onPointerDown={(e) => onHeadDown(e, node)}
                  onPointerMove={onHeadMove}
                  onPointerUp={onHeadUp}
                  onPointerCancel={onHeadUp}
                >
                  <span className="ndg-node__title">{node.title}</span>
                  <span className="ndg-node__category">{node.category}</span>
                </header>}
              >
                <div className="ndg-node__ports">
                  {Array.from({ length: Math.max(node.inputs.length, node.outputs.length) }, (_, i) => (
                    <div key={i} className="ndg-node__row">
                      <span className="ndg-node__in">
                        {node.inputs[i] && <><span className="ndg-node__dot" />{node.inputs[i].name}</>}
                      </span>
                      <span className="ndg-node__out">{node.outputs[i]?.name}{node.outputs[i] && <span className="ndg-node__dot" />}</span>
                    </div>
                  ))}
                </div>
                {node.widgets.length > 0 && <div className="ndg-node__widgets">{node.widgets.map(widgetControl)}</div>}
              </Node>
            ))}
          </div>

          <aside className="ndg__inspector">
            <PanelSection label={selectedNode ? selectedNode.title : "Nothing selected"} meta={selectedNode && <Meta parts={[selectedNode.category]} />}>
              {selectedNode && selectedNode.widgets.length > 0 ? (
                <div className="ndg__controls">{selectedNode.widgets.map(widgetControl)}</div>
              ) : (
                <p className="ndg__hint">Select a node to edit its settings. Drag a node by its header to move it.</p>
              )}
            </PanelSection>
            <Toolbar>
              <StatusText tone="idle">Preview only</StatusText>
            </Toolbar>
          </aside>
        </div>
      </Canvas>
    </div>
  );
}

