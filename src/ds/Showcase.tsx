import { useState,useRef, type ReactNode } from "react";
import {AnnotationEditor} from "./AnnotationEditor";
import {WordWave} from "./WordWave";
import {VisemeStrip} from "./VisemeStrip";
import {PoseStrip} from "./PoseStrip";
import posePreviewFixture from "./fixtures/pose-preview.json";
import speechVisemeFixture from "./fixtures/speech-visemes.json";
import speechPlaybackFixture from "./fixtures/speech-playback.json";
import type {SpeechPlayback} from "../capabilities/speech-playback";
import { DockStack } from "./DockStack";
import {JobQueueMenu} from "./JobQueueMenu";
import {CropHandles} from "./CropHandles";
import {AngleSweepViewer,type SweepFrame} from "./AngleSweepViewer";
import {CameraPathPreview} from "./CameraPathPreview";
import {CompareStrip} from "./CompareStrip";
import {TransformHandles} from "./TransformHandles";
import {CompareWipe,MaskOverlay,DriftOverlay} from "./PrecisionCompare";
import { ChevronLeft, ChevronRight, ArrowUp, Lock, Undo2, Download, Pencil, Maximize2, Camera, Plus, Search, Clock, Dices, LogOut, Settings, Video, History, Image, Info, MinusCircle, RectangleHorizontal, Sparkles, Brush, UserRound } from "lucide-react";
import {
  RotatingVideo,
  Avatar,
  Badge,
  Button,
  Checkbox,
  CodeLine,
  ConfirmDialog,
  DataRow,
  AddShotButton,
  Corkboard,
  EmptyState,
  FormSection,
  ItemList,
  ListItem,
  SearchField,
  Canvas,
  ClampText,
  HowItWorks,
  LinkButton,
  MediaCard,
  PromptGroup,
  Split,
  TopBar,
  UploadPair,
  MegaMenu,
  ToggleRow,
  Block,
  Collapsible,
  ContextBar,
  IconButton,
  Result,
  ResultSlot,
  ShotCard,
  ShotList,
  StatusText,
  Toolbar,
  Dialog,
  Meta,
  SectionHeader,
  GenerateButton,
  GlassButton,
  Graph,
  HistoryItem,
  ModelCard,
  FrameStrip,
  Hero,
  ModelOption,
  Node,
  ShimmerText,
  Skeleton,
  Socket,
  socketY,
  SparkleLoader,
  Widget,
  Wire,
  Notice,
  ParamButton,
  Params,
  Pill,
  PresetCard,
  PresetGrid,
  Progress,
  PromptField,
  Row,
  SegmentedTabs,
  Switch,
  Slider,
  Tag,
  TextField,
  ToastHost,
  ToolChip,
  UnderlineTabs,
  UploadSlot,
  UserMenu,
  useToast,
  AmbientReel,
  AmbientReelProvider,
  PanelSection,
  PickerRow,
  AddButton,
  ShotStrip,
  ShotTile,
  Thumb,
  ThumbGrid,
  ReferenceTray,
  Rule,
  ModeTabs,
  InfoButton,
  ShortcutSheet,
  HintButton,
  SliderField,
  Swatches,
  LayerRow,
  LayerList,
  Page,
  Stage,
  ToolRail,
  OptionsBar,
  Reveal,
  ExpandToggle,
  CommandBar,
  DensityControl,
  MediaViewer,
  MediaEditProvider,
  Tooltip,
  TileGrid,
  ModelTile,
  ContextMenu,
  ScrollFades,
  Working,
  TrimTimeline,
  AppRail,
  WorkspaceBar,
  PillMenu,
  DockPanel,
  DockTabs,
  PopoverButton,
  FloatingPanel,
  ResultGrid,
  ResultTile,
  ContactSheet,
  CameraAngleSheet,
  Flashlight,
  GestureStage,
  InbetweenRail,
  CastCard,
  DropTarget,
  ScoutReel,
  PerformanceMirror,
  TrackSticker,
  Teleprompter,
  LevelMeter,
  TabbedPanel,
  InlineSelect,
  InlineSlider,
  LabeledRow,
  ActionBar,
  MenuButton,
  FxIcon,
  ColorPicker,
  ForegroundBackground,
  StatusBar,
  UploadTile,
  ProblemBar,
  ProblemHost,
  ChoiceDialog,
} from "./index";

// Living reference for the design system. Open the app at #ds.

const SWATCHES = [
  ["--surface-page", "Page"],
  ["--surface-panel", "Panel"],
  ["--surface-control", "Control"],
  ["--surface-subtle", "Subtle"],
  ["--accent", "Accent"],
  ["--button-primary-bg", "Primary button"],
  ["--text-primary", "Text primary"],
  ["--text-secondary", "Text secondary"],
  ["--text-muted", "Text muted"],
  ["--status-danger", "Error (amber)"],
  ["--status-ok", "OK (sage)"],
  ["--badge-hot", "Promo"],
  ["--line-strong", "Line strong"],
];

const RADII = ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-2xl"];

/** Every dropdown in the app (a Row with options, the team's choice triggers) opens this dialog of boxes. */
function ChoiceDialogDemo(){
  const [open,setOpen]=useState(false),[picked,setPicked]=useState("wan-14b");
  return <>
    <Row label="Model" display={picked==="wan-14b"?"Wan 2.2 14B (image to video)":"Object replacement"} onClick={()=>setOpen(true)} />
    <ChoiceDialog open={open} title="Model" value={picked} onPick={value=>{setPicked(value);setOpen(false);}} onClose={()=>setOpen(false)} options={[
      {value:"wan-14b",label:"Wan 2.2 14B (image to video)",note:"Image to video · 14B · 480p",icon:<Video size={16}/>,status:"ready"},
      {value:"replace",label:"Object replacement",note:"Products, clothes and props via masked edit.",icon:<Sparkles size={16}/>,status:"ready"},
      {value:"soon",label:"Needs a node",note:"Install it to use this one.",icon:<Video size={16}/>,status:"missing",detail:"The worker has no RTX node yet."},
    ]}/>
  </>;
}
function WordWaveDemo(){const [time,setTime]=useState(0);return <WordWave playback={speechPlaybackFixture as SpeechPlayback} currentTime={time} onSeek={setTime}/>;}
function VisemeStripDemo(){const [time,setTime]=useState(0);return <VisemeStrip playback={speechVisemeFixture as SpeechPlayback} currentTime={time} onSeek={setTime}/>;}
function PoseStripDemo(){const [selected,setSelected]=useState(0);return <PoseStrip frames={posePreviewFixture.frames} selected={selected} onSelect={frame=>setSelected(frame.frameIndex)}/>;}

function TransformDemo(){
  const initial={x:70,y:50,w:60,h:34,rotation:12};
  const [box,setBox]=useState(initial),[status,setStatus]=useState("Drag or use arrow keys; Enter applies, Escape resets");
  const drag=useRef<{handle:string;x:number;y:number;box:typeof initial}|null>(null);
  return <div className="ds-crophandle-demo"><TransformHandles autoFocus={false} box={box} viewport={{x:0,y:0,w:280,h:200}} width={140} height={100}
    onStart={(handle,event)=>{drag.current={handle,x:event.clientX,y:event.clientY,box};event.currentTarget.setPointerCapture(event.pointerId);}}
    onMove={event=>{const d=drag.current;if(!d)return;const dx=(event.clientX-d.x)/2,dy=(event.clientY-d.y)/2;if(d.handle==="move")setBox({...d.box,x:d.box.x+dx,y:d.box.y+dy});else if(d.handle==="rotate")setBox({...d.box,rotation:d.box.rotation+dx});else{const w=Math.max(20,d.box.w+dx*(d.handle.includes("w")?-1:1));setBox({...d.box,w,h:w*d.box.h/d.box.w});}}}
    onEnd={()=>{drag.current=null;}} onCancel={()=>{drag.current=null;}}
    onNudge={(handle,dx,dy)=>setBox(b=>handle==="rotate"?{...b,rotation:b.rotation+dx+dy}:handle==="move"?{...b,x:b.x+dx,y:b.y+dy}:{...b,w:Math.max(20,b.w+dx+dy),h:Math.max(20,b.w+dx+dy)*b.h/b.w})}
    onApply={()=>{drag.current=null;setStatus("Applied");}} onDiscard={()=>{drag.current=null;setBox(initial);setStatus("Reset");}}/>
    <Meta>{status}</Meta></div>;
}

/** Demo views for the sweep viewer: a near and a far shape shifting at different speeds, like parallax. */
const sweepDemoFrames:SweepFrame[]=Array.from({length:9},(_,i)=>{const t=i-4;const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#16181b"/><circle cx="${210-t*6}" cy="120" r="46" fill="#2a2f36"/><rect x="${96-t*16}" y="140" width="110" height="140" rx="16" fill="#3a414b"/></svg>`;return {src:`data:image/svg+xml,${encodeURIComponent(svg)}`,label:t===0?"Original":t<0?`Left ${-t}`:`Right ${t}`};});

export default function Showcase() {
  const [dockOrder, setDockOrder] = useState(["layers", "color"]);
  const [dockCollapsed, setDockCollapsed] = useState<Record<string, boolean>>({});
  const [utab, setUtab] = useState("a");
  const [utabNarrow, setUtabNarrow] = useState("a");
  const [seg, setSeg] = useState("history");
  const [sweepIndex, setSweepIndex] = useState(4);
  /* A showcase control must still do something: picking a row selects it, which is the behaviour
     the real screens use. A button that ignores the click teaches the wrong thing. */
  const [picked, setPicked] = useState("wan-14b");
  const fileActions = (
    <>
      <a className="ds-iconbtn" href="#ds" aria-label="Download" title="Download"><Download size={14} /></a>
      <IconButton label="Edit"><Pencil size={14} /></IconButton>
      <IconButton label="Full view"><Maximize2 size={14} /></IconButton>
    </>
  );
  const [dur, setDur] = useState(5);
  const [prompt, setPrompt] = useState("");
  const [dialog, setDialog] = useState(false);
  const [annotationOpen,setAnnotationOpen]=useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [checked, setChecked] = useState(true);
  const [preset, setPreset] = useState("push");
  const [gesture, setGesture] = useState("");
  const [selectedAngles,setSelectedAngles]=useState<string[]>(["high-left","right-45"]);
  const [scout, setScout] = useState("front");
  const [long, setLong] = useState("A ceramic cup on a wooden desk, soft morning light, gentle steam rising, a locked camera, shallow depth of field, a quiet kitchen in the background with a window on the left, dust in the air, warm tones, slow and calm, filmic grain, no people, no text, no logos, high detail on the cup rim and the grain of the wood.");
  const [short, setShort] = useState("");
  const [search, setSearch] = useState("");
  const [refs, setRefs] = useState(["portrait-front.png", "profile-reference.png", "jacket-front.png"]);

  return (
    <div data-showcase style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 16px 80px" }}>
      <h1 className="ds-display" style={{ marginBottom: 4 }}>Design system</h1>
      <p style={{ color: "var(--text-secondary)", margin: "0 0 32px", fontSize: 14 }}>
        Tokens in <code>src/ds/tokens.css</code>, components in <code>src/ds/components.tsx</code>.{" "}
        <a href="#" style={{ color: "var(--accent)" }}>Back to studio</a>
      </p>

      <Section title="Color">
        <div className="ds-crophandle-demo"><CropHandles box={{x:0,y:0,w:100,h:100}} viewport={{x:40,y:40,w:160,h:100}} width={100} height={100} onStart={()=>{}} onMove={()=>{}} onEnd={()=>{}} onCancel={()=>{}} onNudge={()=>{}}/><Meta>Crop handles · outside the image · drag or arrow keys</Meta></div>
        <TransformDemo/>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
          {SWATCHES.map(([v, name]) => (
            <div key={v} style={{ borderRadius: 12, overflow: "hidden", border: "1px solid var(--line-hairline)" }}>
              <div style={{ height: 56, background: `var(${v})` }} />
              <div style={{ padding: 8, fontSize: 12 }}>
                <div>{name}</div>
                <code style={{ color: "var(--text-secondary)" }}>{v}</code>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type">
        <p className="ds-display" style={{ margin: 0 }}>Display large</p>
        <p className="ds-modelcard__title" style={{ margin: "8px 0" }}>Display small</p>
        <p style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Body medium 16 / semibold</p>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>Body small 14 / medium</p>
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>Caption 12 / secondary</p>
      </Section>

      <Section title="Radius">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {RADII.map((r) => (
            <div key={r} style={{ textAlign: "center", fontSize: 12, color: "var(--text-secondary)" }}>
              <div style={{ width: 72, height: 72, borderRadius: `var(${r})`, background: "var(--surface-control)", border: "1px solid var(--line-strong)" }} />
              {r.replace("--radius-", "")}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Navigation">
        <JobQueueMenu items={[{id:"shot",title:"A cinematic character performance with a deliberately long workflow name",status:"Rendering",progress:.42},{id:"edit",title:"Image edit",status:"Queued"}]} onRefresh={()=>{}} onSelect={()=>{}} onAll={()=>{}}/>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <a className="ds-navlink" href="#ds">Inactive</a>
          <a className="ds-navlink" aria-current="page" href="#ds">Active</a>
          <Badge>New</Badge>
          <Badge tone="soft">Soon</Badge>
          <Badge tone="hot">55% OFF</Badge>
          <Pill>Pill</Pill>
          <Pill quiet size="lg">Choose from library</Pill>
          <Avatar initials="R" />
        </div>
        <div style={{ marginTop: 16, width: 318, background: "var(--surface-panel)", borderRadius: 16 }}>
          <UnderlineTabs
            label="Example"
            value={utab}
            onChange={setUtab}
            items={[{ id: "a", label: "Create Video" }, { id: "b", label: "Edit Video" }, { id: "c", label: "Motion Control" }]}
          />
        </div>
        {/* The Change panel is 268 px wide: four modes wrap instead of overflowing, short labels keep
            the full name as the accessible name and the hover title. */}
        <div style={{ marginTop: 16, width: 268, background: "var(--surface-panel)", borderRadius: 16 }}>
          <UnderlineTabs
            label="Four modes in a narrow panel"
            value={utabNarrow}
            onChange={setUtabNarrow}
            items={[
              { id: "a", label: "Replace character", short: "Replace" },
              { id: "b", label: "Motion transfer", short: "Motion" },
              { id: "c", label: "Object swap", short: "Swap" },
              { id: "d", label: "Restyle" },
            ]}
          />
        </div>
        <div style={{ marginTop: 16 }}>
          <SegmentedTabs
            label="Example"
            value={seg}
            onChange={setSeg}
            items={[{ id: "history", label: "History", icon: <History size={14} /> }, { id: "how", label: "How it works", icon: <Info size={14} /> }]}
          />
        </div>
      </Section>

      <Section title="Information hierarchy">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <ContextBar
            start={<Pill quiet>Video Core qualification</Pill>}
            meta={<Meta parts={["Shared", "admin"]} />}
            end={<SegmentedTabs quiet label="View" value={seg} onChange={setSeg} items={[{ id: "history", label: "Create Video" }, { id: "how", label: "Storyboard" }]} />}
          />
          <SectionHeader title="Create Video" meta={<Meta>Local ComfyUI</Meta>} />
          <Meta parts={["Latest 200 runs", "Updated 20:52"]} />
        </div>
      </Section>

      <Section title="Page layout and storyboard">
        <Canvas workspace toolbarStart={<Meta>Workspace canvas</Meta>}><EmptyState stage title="Full workspace" text="The editing stage fills the canvas body."/></Canvas>
        <div style={{ display: "flex", gap: 28, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ width: 380, background: "var(--surface-panel)", borderRadius: 22, padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ padding: 14 }}>
              <Toolbar>
                <Pill quiet>Two-shot storyboard</Pill>
                <Button variant="ghost">New board</Button>
              </Toolbar>
              <Meta parts={["Revision 2", "Unsaved changes"]} />
            </div>
            <ShotList label="Shots">
              <ShotCard index={1} selected title="A blue ceramic cup on a wooden table" meta={<Meta parts={["Wan 2.2 TI2V 5B", "1s"]} />} tools={<><IconButton label="Move up"><ArrowUp size={14} /></IconButton></>} onSelect={() => {}} />
              <ShotCard index={2} title="A red ceramic cup on a wooden table" meta={<Meta parts={["Wan 2.2 TI2V 5B", "1s"]} />} onSelect={() => {}} />
            </ShotList>
            <AddShotButton>Add shot</AddShotButton>
            <Collapsible title="Comfy API key" arrow="end">Opens a short form.</Collapsible>
            <Collapsible title="Render settings" open>
              <Meta parts={["Hard cuts", "Silent shots stay silent"]} />
            </Collapsible>
            <GenerateButton label="Render revision 2" />
          </div>
          <div style={{ flex: 1, minWidth: 320 }}>
            <Block>
              <Toolbar>
                <Pill quiet>Rev 2 · Cancellation requested</Pill>
                <StatusText tone="warn">Cancellation requested</StatusText>
                <Meta parts={["0 of 2 shots generated"]} />
              </Toolbar>
              <Result title="Shot 1" meta={<Meta parts={["24 frames", "1.00s"]} />} media={<ResultSlot status={<StatusText>Waiting</StatusText>}>Nothing to show yet.</ResultSlot>} actions={<Button variant="secondary">Download</Button>} />
            </Block>
          </div>
        </div>
      </Section>

      <Section title="Mode switch, toggles and menu">
        <div style={{ display: "flex", gap: 28, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ width: 318, background: "var(--surface-panel)", borderRadius: 22, padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
            <SegmentedTabs block label="Mode" value={seg} onChange={setSeg} items={[{ id: "history", label: "Motion transfer", icon: <History size={14} /> }, { id: "how", label: "Objects swap", icon: <Info size={14} /> }]} />
            <UploadSlot label="Add reference video" hint="4–30 s" accept="video/*" kinds={["video"]} onFile={() => {}} />
            {/* The media field: the drop zone fills the column and the tall library pill below it is flat. */}
            <Pill quiet size="lg">Choose from library</Pill>
            <ToggleRow label="Prompt" checked={false} onChange={() => {}} />
            <ToggleRow label="Instructions" checked onChange={() => {}} />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}><Switch checked label="Switch" onChange={() => {}} /><Meta>Bare switch, used inside ToggleRow</Meta></div>
            <GenerateButton disabled disabledReason="Choose a reference image first" label="Generate" />
          </div>
          <div style={{ flex: 1, minWidth: 360, height: 280, transform: "translateZ(0)" }}>
            <div>
              <MegaMenu
                features={[{ id: "a", icon: <Video size={18} />, title: "Create Video", text: "Generate AI videos", onSelect: () => {} }, { id: "b", icon: <Sparkles size={18} />, title: "Storyboard", badge: { text: "New" }, text: "Plan shots", onSelect: () => {} }]}
                models={[{ id: "c", icon: <Sparkles size={18} />, title: "Wan 2.2", text: "Text to video", onSelect: () => {} }]}
                onPick={() => {}}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section title="Long text, uploads and media">
        <div style={{ display: "flex", gap: 28, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ width: 318, background: "var(--surface-panel)", borderRadius: 22, padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
            <UploadPair>
              <UploadSlot tile label="Character" hint="Full body works best" accept="image/*" onFile={() => {}} />
              <UploadSlot tile label="Motion video" hint="About 3 seconds" accept="video/*" kinds={["video"]} onFile={() => {}} />
            </UploadPair>
            <PromptGroup>
              <PromptField label="Character and background" placeholder="How the character looks" value={long} onChange={setLong} />
              <PromptField compact label="Motion" placeholder="What the movement is" value={short} onChange={setShort} />
            </PromptGroup>
            <ClampText text={long} lines={3} title="Prompt" />
          </div>
          <div style={{ flex: 1, minWidth: 320, display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="ds-grid" style={{ ["--tile-min" as string]: "220px" }}>
              <MediaCard quiet media={<Video size={28} />} info={<><span>a-very-long-file-name-that-needs-to-be-cut-off-somewhere-source-clip-final.mp4</span><Meta>Validated mask</Meta></>} actions={fileActions} />
              <MediaCard quiet media={<Video size={28} />} info={<span>mask.mp4</span>} actions={fileActions} />
            </div>
            <TopBar brand={<span>Brand</span>} current="#a" items={[{ label: "Video", href: "#a" }, { label: "Library", href: "#b" }, { label: "Projects", href: "#c", suffix: "Paket-Test", dropdown: { items: [{ id: "1", title: "Paket-Test", onSelect: () => {} }, { id: "2", title: "Launch Campaign", onSelect: () => {} }], selectedId: "1", footer: { id: "all", title: "All projects…", onSelect: () => {} } } }]} />
          </div>
        </div>
        <Split>
          <Canvas toolbarStart={<Meta>Canvas toolbar</Meta>}>
            <HowItWorks title="How it works" lead="Three short steps" steps={[{ icon: <Sparkles size={24} />, title: "Add", text: "Upload your files." }]} />
          </Canvas>
        </Split>
      </Section>

      <Section title="Pages: lists, search and empty states">
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 760 }}>
          <SectionHeader large title="Catalogue" meta={<Meta parts={["27 workflows", "Local execution"]} />} />
          <Toolbar>
            <SearchField label="Search" placeholder="Search workflows" value={short} onChange={setShort} />
            <SegmentedTabs quiet label="Status" value={seg} onChange={setSeg} items={[{ id: "history", label: "All" }, { id: "how", label: "Supported" }]} />
          </Toolbar>
          <ItemList label="Examples">
            <ListItem icon={<Video size={16} />} title="Wan 2.2 14B (image to video)" text="Image to video · 14B · 480p" meta={<Meta parts={["Local ComfyUI", "Video"]} />} status={<StatusText tone="ok">Ready</StatusText>} selected={picked==="wan-14b"} onClick={() => setPicked("wan-14b")} />
            <ListItem icon={<Sparkles size={16} />} title="Object replacement" text="Products, clothes and props via masked edit." meta={<Meta parts={["Local ComfyUI", "Replacement"]} />} status={<StatusText tone="ok">Ready</StatusText>} selected={picked==="replacement"} onClick={() => setPicked("replacement")} />
          </ItemList>
          <EmptyState icon={<Sparkles size={18} />} title="No storyboards yet" text="Plan shots, render them locally and assemble one video." action={<Button variant="primary">Create storyboard</Button>} />
        </div>
      </Section>

      <Section title="Forms, feedback, menus and presets">
        <ToastHost>
          <div style={{ display: "flex", gap: 28, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 12 }}>
              <FormSection title="Register a worker" meta={<Meta>Local ComfyUI</Meta>}>
                <TextField label="Name" value={short} onChange={setShort} placeholder="Local RTX 4090" />
                <TextField label="Password" type="password" value={long.slice(0, 12)} onChange={() => {}} hint="At least 12 characters" />
                <TextField label="Origin" value="not a url" onChange={() => {}} error="Enter a full address such as http://127.0.0.1:8188" />
                <Checkbox checked onChange={() => {}}>Keep audio</Checkbox>
              </FormSection>
              <DataRow title="Local RTX 4090" meta={<Meta parts={["http://127.0.0.1:8188"]} />} status={<StatusText tone="ok">Online</StatusText>} actions={<Button variant="secondary">Probe</Button>} />
              <DataRow title="wan" meta={<Meta parts={["Updated today"]} />} status={<StatusText tone="ok">Configured</StatusText>} actions={<Button variant="ghost" onClick={() => setConfirmation(true)}>Remove</Button>} />
              <ConfirmDialog error="This item is still in use. Remove its references, then retry." open={confirmation} title="Remove this credential?" text="The stored credential is deleted from this server." confirmLabel="Remove credential" onCancel={() => setConfirmation(false)} onConfirm={() => setConfirmation(false)} />
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <ToastDemo />
                <UserMenu initials="R" name="Alex Example" extra={<><Meta parts={["2,110 credits"]} /><LinkButton variant="ghost" href="#ds">Add credits</LinkButton></>} meta={<Meta parts={["Studio", "admin"]} />} items={[{ id: "s", label: "Team settings", icon: <Settings size={14} />, onSelect: () => {} }, { id: "o", label: "Sign out", icon: <LogOut size={14} />, onSelect: () => {} }]} />
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 320 }}>
              <PresetGrid label="Camera moves">
                <PresetCard label="Dolly in" hint="Slow push" icon={<Camera size={20} />} selected onSelect={() => {}} />
                <PresetCard label="Orbit" hint="Around the subject" icon={<Camera size={20} />} onSelect={() => {}} />
                <PresetCard label="Handheld" hint="Natural shake" icon={<Camera size={20} />} onSelect={() => {}} />
                <PresetCard label="Crane up" icon={<Camera size={20} />} onSelect={() => {}} />
              </PresetGrid>
            </div>
          </div>
        </ToastHost>
      </Section>

      <Section title="Panel sections, pickers and add rows">
        <div style={{ width: 318, background: "var(--surface-panel)", borderRadius: 22, padding: 10, display: "flex", flexDirection: "column", gap: 16 }}>
          <PanelSection label="Brand kit" meta={<Meta>Revision 1</Meta>}>
            <PickerRow>
              <Row label="Brand kit" display="Backpacks Focus" value="a" options={[{ value: "a", label: "Backpacks Focus" }]} onChange={() => {}} />
            </PickerRow>
          </PanelSection>
          <AddButton>New character</AddButton>
        </div>
      </Section>

      <Section title="Shot strip">
        <ShotStrip label="Shots" onAdd={() => {}}>
          {Array.from({ length: 14 }, (_, i) => (
            <ShotTile key={i} index={i + 1} selected={i === 1} title={i === 0 ? "A blue ceramic cup on a wooden table, soft morning light" : i === 2 ? "" : `Shot number ${i + 1}`} meta={<Meta parts={["Wan 2.2 TI2V 5B", "1s"]} />} onSelect={() => {}} tools={i === 1 ? <><IconButton label="Earlier"><ChevronLeft size={12} /></IconButton><IconButton label="Later"><ChevronRight size={12} /></IconButton></> : undefined} />
          ))}
        </ShotStrip>
      </Section>

      <Section title="Corkboard (planned shots)">
        <Corkboard label="Planned shots">
          <ShotCard index={1} title="Mara steps onto the frozen lake at dawn." meta={<Meta>Wide · tracking</Meta>} onSelect={() => {}} />
          <ShotCard index={2} title="She notices the red cabin and stops." meta={<Meta>Close-up · face</Meta>} onSelect={() => {}} />
          <ShotCard index={3} title="The cabin door opens by itself." meta={<Meta>Low angle · slow push</Meta>} onSelect={() => {}} />
        </Corkboard>
      </Section>

      <Section title="Inbetween rail (first to last frame)">
        <InbetweenRail
          first="/reels/wan22-i2v-5b.png"
          last="/reels/wan22-flf-14b.png"
          frames={33}
          caption="Ghost slots until a real FLF run fills them"
        />
      </Section>

      <Section title="Sampled frame labels (illustrative images)"><InbetweenRail frames={17} images={["/reels/wan22-i2v-5b.png","/reels/wan22-flf-14b.png"]} imageFrameIndices={[0,16]} caption="Showcase illustration only; these two images are not extracted output frames."/></Section>

      <Section title="Notice with actions and a centered mode switch">
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
          <ContextBar start={<Pill quiet>Browser Campaign</Pill>} meta={<Meta parts={["Shared", "admin"]} />} center={<SegmentedTabs quiet large label="Mode" value={seg} onChange={setSeg} items={[{ id: "history", label: "Create Video" }, { id: "how", label: "Storyboard" }]} />} />
          <Notice title="Browser draft available" actions={<><Button variant="secondary">Restore draft</Button><Button variant="ghost">Discard</Button></>}>Revision 1 · 5 shots. The saved board has changed; review before saving.</Notice>
        </div>
      </Section>

      <Section title="Reference thumbs">
        <div style={{ maxWidth: 520 }}>
          <ThumbGrid label="Examples">
            <Thumb label="portrait-front.png" info={<><span>portrait-front.png</span><Meta>Shared image</Meta></>} selected onSelect={() => {}} />
            <Thumb label="profile-reference.png" onSelect={() => {}} />
            <Thumb label="read-only.png" />
          </ThumbGrid>
        </div>
      </Section>

      <Section title="Reference tray (up to 30), and a rule">
        <div style={{ maxWidth: 520, display: "flex", flexDirection: "column", gap: 12 }}>
          <ReferenceTray label="References" max={30} onAdd={() => setRefs((r) => [...r, `reference-${r.length + 1}.png`])}>
            {refs.map((name) => (
              <Thumb key={name} label={name} onSelect={() => {}} onRemove={() => setRefs((r) => r.filter((n) => n !== name))} />
            ))}
          </ReferenceTray>
          <Rule />
          <Meta>Prompt and model go below the rule</Meta>
        </div>
      </Section>

      <Section title="Editor parts: layers, sliders, swatches, stage">
        <LayerList label="Layers">
          <LayerRow name="Background" visible selected onSelect={() => {}} onToggle={() => {}} />
          <LayerRow name="Brush layer" visible={false} onSelect={() => {}} onToggle={() => {}} />
        </LayerList>
        <SliderField label="Opacity" value={80} min={0} max={100} unit="%" onChange={() => {}} />
        <Swatches label="Brush color" colors={["#ffffff", "#2fa8ff", "#f5c451", "#202020"]} value="#2fa8ff" onChange={() => {}} />
        <Page workspace><Stage rail={<ToolRail label="Tools" value="a" onChange={() => {}} items={[{ id: "a", label: "Move", icon: <Plus size={18} /> }, "separator", { id: "b", label: "Brush", icon: <Search size={18} /> }]} />}><canvas width={160} height={90} aria-label="Stage example" /></Stage></Page>
      </Section>

      <Section title="Color picker and working colors">
        <ColorPicker label="Color" value="#2fa8ff" onChange={() => {}} />
        <ForegroundBackground fg="#2fa8ff" bg="#202020" editing="fg" onEdit={() => {}} onSwap={() => {}} />
      </Section>

      <Section title="Tabbed tool panel (Layers)">
        <TabbedPanel label="Layers" tabs={[{ id: "layers", label: "Layers" }, { id: "channels", label: "Channels" }]} value="layers" onChange={() => {}}
          menu={<MenuButton label="Layer menu" icon={<Plus size={16} />} items={[{ id: "a", label: "Add image", onSelect: () => {} }]} />}
          footer={<ActionBar label="Layer actions"><IconButton label="Layer style"><FxIcon /></IconButton><IconButton label="New layer"><Plus size={16} /></IconButton></ActionBar>}>
          <div style={{ display: "flex", gap: 8 }}>
            <InlineSelect label="Blend" value="normal" options={[{ value: "normal", label: "Normal" }]} onChange={() => {}} />
            <InlineSlider label="Opacity" value={100} onChange={() => {}} />
          </div>
          <LabeledRow label="Lock"><IconButton label="Lock all"><Lock size={16} /></IconButton></LabeledRow>
        </TabbedPanel>
      </Section>

      <Section title="Result grid (batch of 4, 16:9)">
        <ResultGrid count={4} aspect={16 / 9} label="Batch">
          <ResultTile status="Generating…" /><ResultTile status="Generating…" /><ResultTile status="Generating…" /><ResultTile status="Generating…" />
        </ResultGrid>
      </Section>

      <Section title="Developing states">
        <ResultGrid count={4} aspect={16 / 9} label="Run states">
          <ResultTile develop={{ label: "Working on it · part 2 of 4 · 12/20", progress: .6, onCancel: () => {} }} />
          <ResultTile develop={{ label: "Cancelling…", progress: .2 }} />
          <ResultTile develop={{ label: "Failed at step 12/20", active: false }} />
          <ResultTile develop={{ label: "Cancelled at step 4/20", src: "/reels/wan22-i2v-5b.png", progress: .2, active: false }} />
        </ResultGrid>
      </Section>

      <Section title="Relight light guide">
        <Flashlight
          src="/reels/wan22-i2v-5b.png"
          direction="from the front-left"
          temperature="golden"
          temperatures={[{ id: "candle", label: "Candle" }, { id: "golden", label: "Golden" }, { id: "daylight", label: "Daylight" }]}
          onDirectionChange={() => {}}
          onTemperatureChange={() => {}}
        />
      </Section>

      <Section title="Precision compare and mask overlays">
        <Meta>Illustrative overlay fixtures; protected-region metrics appear only after a measured run.</Meta>
        <CompareWipe before="/reels/wan22-i2v-5b.png" after="/reels/wan22-i2v-14b.png"
          overlay={<MaskOverlay src={'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="832" height="480"><rect width="832" height="480" fill="black"/><rect x="200" y="140" width="300" height="200" fill="white"/></svg>')}/>}/>
        <CompareWipe before="/reels/wan22-i2v-5b.png" after="/reels/wan22-i2v-5b.png"
          overlay={<DriftOverlay src={'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="832" height="480"><rect width="832" height="480" fill="black"/><circle cx="620" cy="200" r="30" fill="white"/></svg>')}/>}/>
      </Section>

      <Section title="Camera gesture stage">
        <GestureStage
          src="/reels/wan22-i2v-5b.png"
          value={gesture}
          moves={[
            { id: "pan-left", label: "Pan left" },
            { id: "pan-right", label: "Pan right" },
            { id: "pan-up", label: "Pan up" },
            { id: "pan-down", label: "Pan down" },
            { id: "zoom-in", label: "Zoom in" },
            { id: "zoom-out", label: "Zoom out" },
          ]}
          onChange={setGesture}
          instruction="Real run only after Generate"
        />
      </Section>

      <Section title="Compare strip (swap check)">
        <div style={{ maxWidth: 520 }}>
          <CompareStrip label="Swap check" items={[{ src: "/reels/wan22-i2v-5b.png", label: "Scene" }, { src: "/reels/wan22-i2v-14b.png", label: "Reference 1" }, { src: "/reels/wan22-i2v-5b.png", label: "Result" }]} />
        </div>
      </Section>

      <Section title="Camera path preview (before rendering)">
        <div style={{ maxWidth: 360 }}>
          <CameraPathPreview src="/reels/wan22-i2v-5b.png" alt="Demo start frame" pose="Pan Right" speed={1.2} />
        </div>
      </Section>

      <Section title="Angle sweep (scrub camera views)">
        <div style={{ maxWidth: 360 }}>
          <AngleSweepViewer frames={sweepDemoFrames} originalIndex={4} index={sweepIndex} onIndex={setSweepIndex} onSave={() => {}} reliableSteps={2} />
        </div>
      </Section>

      <Section title="Kontaktbogen (batch export)">
        <CameraAngleSheet source={{src:"/reels/wan22-i2v-5b.png"}} items={[{id:"high-left",label:"High left"},{id:"high",label:"High"},{id:"high-right",label:"High right"},{id:"left-45",label:"Left 45"},{id:"right-45",label:"Right 45"},{id:"low-left",label:"Low left"},{id:"low",label:"Low"},{id:"low-right",label:"Low right"}]} selected={selectedAngles} onChange={setSelectedAngles}/>
        <ContactSheet
          items={[
            { src: "/reels/wan22-i2v-5b.png", label: "Approach" },
            { src: "/reels/wan22-i2v-14b.png", label: "Reverse" },
            { src: "/reels/wan22-flf-14b.png", label: "Close" },
          ]}
          caption="Three frames from one batch"
        />
      </Section>

      <Section title="Cast card and scene drop target">
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.3fr)", gap: 16 }}>
          <CastCard name="Mara Voss" portrait="/reels/wan22-i2v-5b.png" meta="Lead · drama" stats="3 refs · 7 shots" selected onActivate={() => {}} actions={<Button variant="ghost">Open</Button>} />
          <DropTarget label="Drop a cast card into the scene" hint="The chosen cast sets the character reference for this shot." onDrop={() => {}}>
            <Meta>Frozen lake · dawn</Meta>
          </DropTarget>
        </div>
      </Section>

      <Section title="Scout reel (destinations)">
        <ScoutReel
          value={scout}
          onSelect={setScout}
          items={[
            { id: "front", label: "Front", src: "/reels/wan22-i2v-5b.png" },
            { id: "left", label: "Left 45", src: "/reels/wan22-i2v-14b.png" },
            { id: "low", label: "Low angle", src: "/reels/wan22-flf-14b.png" },
          ]}
          caption="Wheel or arrow keys cycle while the subject stays fixed."
        />
      </Section>

      <Section title="Performance mirror and tracked object">
        <PerformanceMirror driving="/reels/wan22-t2v-5b.mp4" result="/reels/wan22-i2v-14b.mp4" caption="Play, pause and seek together. Full view offers independent playback." />
        <div style={{ position: "relative", width: "100%", maxWidth: 520, aspectRatio: "16 / 9", background: "var(--surface-subtle)", borderRadius: 12, overflow: "hidden" }}>
          <TrackSticker left={42} top={30} width={22} height={28} label="Cup" selected onSelect={() => {}} />
        </div>
      </Section>

      <Section title="Detected pose">
        <PoseStripDemo/>
      </Section>
      <Section title="Voice tools">
        <WordWaveDemo/>
        <VisemeStripDemo/>
        <Teleprompter lines={["The lake remembers every step.", "We only have until sunrise."]} current={1} />
        <LevelMeter level={0.62} />
      </Section>

      <Section title="Dock panel with tabs and a side popover">
        <DockStack onReorder={setDockOrder}>
          {dockOrder.map(id => <DockPanel key={id} id={id} label={id === "layers" ? "Layers" : "Color"} title={id === "layers" ? <DockTabs label="Panel" tabs={[{ id: "a", label: "Layers" }, { id: "b", label: "Channels" }]} value="a" onChange={() => {}} /> : "Color"}
            end={id === "layers" ? <PopoverButton label="Adjustments" icon={<Plus size={16} />} title="Adjustments"><SliderField label="Brightness" value={100} min={0} max={200} onChange={() => {}} /></PopoverButton> : undefined}
            collapsed={dockCollapsed[id]} onToggle={() => setDockCollapsed(value => ({ ...value, [id]: !value[id] }))}>
            <Meta>Drag the header to reorder. Escape cancels. Alt+↑ / Alt+↓ moves the focused grip.</Meta>
          </DockPanel>)}
        </DockStack>
      </Section>

      <Section title="Floating panel (drag the title bar)">
        <FloatingPanel open={false} title="Adjustments" onClose={() => {}}><Meta>Opens next to the side column.</Meta></FloatingPanel>
        <Meta>Opens from a layer double-click in the image editor.</Meta>
      </Section>

      <Section title="App rail and workspace bar">
        <div style={{ display: "flex", height: 220, border: "1px solid var(--line-hairline)", borderRadius: 12, overflow: "hidden" }}>
          <AppRail label="Sections" current="video" items={[{ id: "video", label: "Video", icon: <Video size={18} />, href: "#ds" }, { id: "image", label: "Image", icon: <Image size={18} />, href: "#ds" }]} />
          <div style={{ flex: 1 }}>
            <WorkspaceBar tabs={{ label: "Video", value: "create", items: [{ id: "storyboard", label: "Storyboard" }, { id: "create", label: "Create" }], onChange: () => {} }}
              end={<PillMenu label="Character" items={[{ id: "a", label: "Character" }]} value="a" onPick={() => {}} />} />
          </div>
        </div>
        <PanelSection label="Bar and page header share one edge">
          <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--line-hairline)", borderRadius: 12, overflow: "hidden" }}>
            <WorkspaceBar tabs={{ label: "All tools workspace", value: "create", items: [{ id: "create", label: "Create" }, { id: "edit", label: "Edit" }], onChange: () => {} }}
              density info={<InfoButton title="Workspace guide"><Meta>The bar's end group and the page header below stand on one right edge at every width.</Meta><Meta>A page whose content fills the work area says so itself with Page fill; the bar above it then keeps the plain gutter, so its tabs start over the panel they head.</Meta></InfoButton>} />
            <div className="ds-page" style={{ paddingTop: 0 }}>
              <Toolbar end={<SearchField label="Search tools" placeholder="Search tools" value={short} onChange={setShort} />}>
                <SectionHeader large title="All tools" />
              </Toolbar>
            </div>
          </div>
        </PanelSection>
      </Section>

      <Section title="Trim timeline">
        <Meta>Used by Trim Video: preview, film strip, in and out handles.</Meta>
        {false && <TrimTimeline src="" frames={97} start={0} end={97} onChange={() => {}} />}
      </Section>

      <Section title="Context menu (right-click)">
        <Meta>Opens at the pointer, for example on a layer mask.</Meta>
        {false && <ContextMenu x={0} y={0} items={[{ id: "a", label: "Delete mask", onSelect: () => {}, danger: true }]} onClose={() => {}} />}
      </Section>

      <Section title="Working indicator and scroll fades">
        <ScrollFades />
        <Working label="Filling the selection…" hint="ComfyUI is generating" />
      </Section>

      <Section title="Tile gallery (models)">
        <TileGrid label="Models">
          <ModelTile icon={<Sparkles size={16} />} title="Flux 2 Klein 4B" text="Text to image, local" status={<StatusText tone="ok">Ready</StatusText>} onClick={() => setPicked("flux-klein")} />
          <ModelTile dim icon={<Video size={16} />} title="Wan Animate" text="Needs a model file" status={<StatusText tone="warn">Setup</StatusText>} onClick={() => setPicked("wan-animate")} />
        </TileGrid>
      </Section>

      <Section title="Command bar (floats at the top center)">
        <Meta>Used for the free-intent input; fixed to the page, so it is not drawn here.</Meta>
        {false && <CommandBar label="Describe the result" value="" onChange={() => {}} placeholder="Describe the scene you imagine" />}
      </Section>

      <Section title="Reveal (lists ease in top to bottom)">
        <Reveal />
        <Meta>Active on every grid and list with more than two items.</Meta>
      </Section>

      <Section title="Expand toggle (hover to open)">
        <ExpandToggle icon={<Sparkles size={16} />} label="Free input" on onChange={() => {}} />
      </Section>

      <Section title="Annotation editor">
        <Button onClick={()=>setAnnotationOpen(true)}>Annotate image</Button>
        <AnnotationEditor open={annotationOpen} src="/reels/wan22-i2v-5b.png" onClose={()=>setAnnotationOpen(false)} onApply={()=>setAnnotationOpen(false)}/>
      </Section>
      <Section title="Density control and viewer">
        <DensityControl />
        <Tooltip content="View media details without covering the picture."><Button>Hover for details</Button></Tooltip>
        <MediaEditProvider><MediaCard quiet media={<img src="/reels/wan22-i2v-5b.png" alt="Preview example"/>}/><MediaViewer open={false} src="" name="Picture" onClose={() => {}} /></MediaEditProvider>
      </Section>

      <Section title="Keyboard shortcuts">
        <ShortcutSheet groups={[{ title: "Editor", items: [{ label: "Undo", keys: ["Ctrl+Z"] }, { label: "Redo", keys: ["Ctrl+Shift+Z"] }, { label: "Cancel gesture", keys: ["Escape"] }] }]} />
      </Section>

      <Section title="Options bar and status bar">
        <OptionsBar end={<IconButton label="Undo"><Undo2 size={16} /></IconButton>}>
            <SliderField label="Size" value={40} min={1} max={200} unit="px" onChange={() => {}} />
            <SliderField label="Flow" value={100} min={1} max={100} unit="%" onChange={() => {}} />
        </OptionsBar>
        <StatusBar>100%<span>2800 × 2000 px</span></StatusBar>
      </Section>

      <Section title="Hint button (what is still missing)">
        <HintButton><Meta>Required: Source video, Aligned edit mask</Meta><Meta>Replacement prompt: enter valid text.</Meta></HintButton>
      </Section>

      <Section title="Mode tabs and info button">
        <ModeTabs label="Modes" value={seg} onChange={setSeg} items={[{ id: "history", label: "Storyboard" }, { id: "how", label: "Create Video" }, { id: "x", label: "Trim Video" }]} />
        <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8 }}>
          <SectionHeader large title="Audio" />
          <InfoButton title="Audio"><Meta parts={["The video timeline stays fixed", "ffmpeg 7.1"]} /></InfoButton>
        </div>
      </Section>

      <Section title="Upload tile">
        <div className="ds-grid" style={{ ["--tile-min" as string]: "220px", maxWidth: 520 }}>
          <MediaCard quiet media={<Video size={28} />} info={<><span>mask.mp4</span><Meta>video/mp4 · Validated mask</Meta></>} actions={fileActions} />
          <UploadTile state="uploading" />
          <UploadTile state="failed" onRetry={() => {}} onDismiss={() => {}} />
        </div>
      </Section>

      <Section title="Problem bar: one place, one row">
        <ProblemHost>
          <ProblemBar />
          <Notice priority={100} title="Team server unavailable" actions={<Button variant="secondary">Retry connection</Button>}>Drafts remain available.</Notice>
          <Notice priority={20} title="Team server unavailable">Drafts remain available.</Notice>
          <Notice priority={40} title="Image could not be decoded">Try another image.</Notice>
          <Notice priority={45} title="ComfyUI isn't answering" actions={<Button variant="secondary">Start ComfyUI</Button>} details={"object_info:request_failed\nmodels:request_failed"}>ComfyUI isn't answering at 127.0.0.1:8188. It may not be running.</Notice>
          <Notice priority={50} consequence title="Run update unavailable">Workspace permission required</Notice>
          <Notice priority={30} consequence title="ComfyUI is offline" actions={<Button variant="secondary">Start ComfyUI</Button>}>Start it on this computer to run this model.</Notice>
        </ProblemHost>
      </Section>

      <Section title="Buttons">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <LinkButton variant="ghost" href="#ds">Link</LinkButton>
          <span style={{ padding: 8, background: "#444", borderRadius: 8 }}>
            <GlassButton><Sparkles size={12} /> Glass</GlassButton>
          </span>
          <ToolChip icon={<MinusCircle size={12} />} pressed>Tool on</ToolChip>
          <ToolChip pressed={false}>Tool off</ToolChip>
        </div>
        <div style={{ width: 286, marginTop: 16, display: "grid", gap: 8 }}>
          <GenerateButton />
          <GenerateButton busy disabled />
        </div>
      </Section>

      <Section title="Forms, account and presets">
        <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 1fr) minmax(320px, 1fr)", gap: 20, alignItems: "start" }}>
          <FormSection title="Workspace setup" meta={<Meta>Canonical form controls</Meta>}>
            <TextField label="Project name" value={short} onChange={setShort} hint="Stored with the shared project." />
            <Checkbox checked={checked} onChange={setChecked}>Preserve source audio</Checkbox>
            <DataRow title="Local RTX 4090" meta={<Meta parts={["ComfyUI"]}/>} status={<StatusText tone="ok">Online</StatusText>} actions={<Button variant="secondary">Probe</Button>}/>
            <Toolbar>
              <Button variant="secondary" onClick={()=>setConfirm(true)}>Confirm action</Button>
              <UserMenu initials="C" name="creator@example.test" meta={<Meta parts={["Shared", "Creator"]}/>} items={[{id:"settings",label:"Settings",onSelect:()=>{}},{id:"out",label:"Sign out",onSelect:()=>{}}]}/>
            </Toolbar>
          </FormSection>
          <Block label="Preset cards">
            <PresetGrid label="Camera movement">
              <PresetCard label="Push in" hint="Slow" icon={<Video size={18}/>} selected={preset==="push"} onSelect={()=>setPreset("push")}/>
              <PresetCard label="Locked" hint="Static" icon={<RectangleHorizontal size={18}/>} selected={preset==="locked"} onSelect={()=>setPreset("locked")}/>
            </PresetGrid>
            <PanelSection label="Tool cards">
              <PresetGrid label="All tools">
                <PresetCard size="tool" label="Fix a picture" hint="Paint over a part and say what should be there." icon={<Brush size={20}/>} onSelect={()=>{}}/>
                <PresetCard size="tool" label="My characters" hint="Save a person once, then use them to replace a face, make a picture or fill a shot." icon={<UserRound size={20}/>} onSelect={()=>{}}/>
              </PresetGrid>
            </PanelSection>
            <ToastHost><ToastDemo/></ToastHost>
          </Block>
        </div>
        <ConfirmDialog open={confirm} title="Confirm this action?" text="This example shows the canonical confirmation dialog." confirmLabel="Confirm" onConfirm={()=>setConfirm(false)} onCancel={()=>setConfirm(false)}/>
      </Section>

      <Section title="Frame strip">
        <FrameStrip label="What the model saw" items={[{ src: "/reels/wan22-i2v-5b.png", label: "Your picture" }, { src: "/reels/wan22-flf-14b.png", label: "Reference frame" }, { src: "/reels/wan22-t2v-5b.png", label: "First frame" }]} />
      </Section>

      <Section title="Hero">
        <Hero title="Turn one video into many" text="Take the motion and recast it with your characters, places and products." media={<video src="/reels/wan22-i2v-5b.mp4" muted loop autoPlay playsInline aria-hidden />} />
      </Section>

      <Section title="Hero stage and rotating video">
        <Hero stage accent="many" title="Turn one video into many" text="The loop fills the band, drifts slowly, and the clips take turns." media={<RotatingVideo srcs={["/reels/mj-02.mp4", "/reels/mj-01.mp4", "/reels/mj-03.mp4"]} />} />
      </Section>

      <Section title="Control panel parts">
        <div style={{ width: 302, display: "grid", gap: 8 }}>
          <Block label="Ambient reel">
            <AmbientReelProvider src="/reels/wan22-i2v-5b.mp4">
              <div style={{ position: "relative", width: 302, height: 100, overflow: "hidden", borderRadius: "var(--radius-2xl)" }}>
                <AmbientReel />
              </div>
            </AmbientReelProvider>
          </Block>
          <ModelCard title="Wan 2.1" subtitle="Image to video · 14B · 480p" video="/reels/wan22-flf-14b.mp4" onChange={() => {}} />
          <UploadSlot label="Upload media" hint="Image, video or audio" accept="image/*" kinds={["image", "video", "audio"]} onFile={() => {}} />
          <UploadSlot label="Audio take preview" hint="Demonstration tone" accept="audio/wav" kinds={["audio"]} previewKind="audio" preview="/reels/ds-audio-demo.wav" compact onFile={()=>{}}/>
          <ThumbGrid label="Audio asset example"><Thumb audio label="Audio take" onSelect={()=>{}}/></ThumbGrid>
          <PromptField label="Prompt" placeholder="Describe your scene" value={prompt} onChange={setPrompt} tools={<ToolChip icon={<Image size={12} />}>Elements</ToolChip>} />
          <Row label="Model" display="Wan 2.1 I2V 14B" options={[{ value: "a", label: "Wan 2.1" }]} value="a" onChange={() => {}} />
          <ChoiceDialogDemo />
          <Params>
            <ParamButton title="Duration" icon={<Clock size={16} />} label={`${dur}s`} value={dur} onChange={setDur} options={[3, 4, 5].map((v) => ({ value: v, label: `${v} seconds` }))} />
            <ParamButton title="Ratio" icon={<RectangleHorizontal size={16} />} label="16:9" value="a" onChange={() => {}} options={[{ value: "a", label: "16:9" }]} />
            <ParamButton title="Resolution" icon={<Sparkles size={16} />} label="480p" value="a" onChange={() => {}} options={[{ value: "a", label: "480p" }]} />
          </Params>
          <Row subtle label="Seed" icon={<Dices size={16} color="var(--text-secondary)" />} trailing={<Tag>Random</Tag>} options={[{ value: "r", label: "Random" }]} value="r" onChange={() => {}} />
        </div>
      </Section>

      <Section title="Search, lists and empty states">
        <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
          <SearchField label="Search projects" value={search} onChange={setSearch} placeholder="Search projects" />
          <ItemList label="Projects">
            <ListItem icon={<Video size={16} />} title="Campaign cut" text="Two-shot video project" meta={<Meta parts={["Shared", "Updated today"]} />} status={<StatusText tone="ok">Ready</StatusText>} selected={picked==="campaign"} onClick={() => setPicked("campaign")} />
            <ListItem dim icon={<Sparkles size={16} />} title="Replacement study" text="Needs a validated mask" status={<StatusText tone="warn">Requirements</StatusText>} selected={picked==="study"} onClick={() => setPicked("study")} />
          </ItemList>
          <EmptyState icon={<Video size={20} />} title="No matching projects" text="Change the search or create a project." action={<Button variant="secondary">New project</Button>} />
        </div>
      </Section>

      <Section title="Model picker">
        <div style={{ display: "grid", gap: 10, maxWidth: 560 }}>
          <ModelOption title="Wan 2.2" subtitle="Image to video · 5B · 720p" status="ready" selected meta={<><Tag icon={<Clock size={12} />}>up to 5s</Tag><Tag icon={<Sparkles size={12} />}>720p</Tag></>} onSelect={() => {}} />
          <ModelOption
            title="Wan 2.2 Quality"
            subtitle="Image to video · 14B · 720p"
            status="missing"
            selected={false}
            onSelect={() => {}}
            detail={
              <>
                <ul><li>Missing model file diffusion_models/wan2.2_i2v_high_noise_14B_fp8.safetensors</li></ul>
                <span>Download them, then press Recheck:</span>
                <CodeLine>bash scripts/download-models.sh pipelines/i2v/wan22-i2v-14b/models.txt</CodeLine>
              </>
            }
          />
          <ModelOption title="Experimental" subtitle="Needs a newer ComfyUI" status="incompatible" selected={false} onSelect={() => {}} />
          <ModelOption title="Checking" subtitle="Asking ComfyUI" status="checking" selected={false} onSelect={() => {}} />
        </div>
        <div style={{ marginTop: 12 }}>
          <Button onClick={() => setDialog(true)}>Open dialog</Button>
          <Dialog open={dialog} title="Choose a model" onClose={() => setDialog(false)} footer={<Button variant="primary" onClick={() => setDialog(false)}>Done</Button>}>
            <ModelOption title="Wan 2.2" subtitle="Image to video · 5B · 720p" status="ready" selected onSelect={() => {}} />
          </Dialog>
        </div>
      </Section>

      <Section title="Loading">
        <div style={{ display: "flex", gap: 32, alignItems: "center", flexWrap: "wrap" }}>
          <SparkleLoader size="sm" />
          <SparkleLoader />
          <SparkleLoader size="lg" />
          <ShimmerText>Rendering frame 42 of 81</ShimmerText>
          <div style={{ width: 220, display: "grid", gap: 8 }}>
            <Skeleton width="80%" />
            <Skeleton />
            <Skeleton width="55%" />
          </div>
        </div>
      </Section>

      <Section title="Spacing roles">
        <div style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-secondary)", maxWidth: 520 }}>
          {[
            ["--pad-chip", "Tags, tool chips, badges"],
            ["--pad-control", "Param buttons, small buttons"],
            ["--pad-row", "Full-width rows"],
            ["--pad-field", "Text fields"],
            ["--pad-card", "Cards, notices, node body"],
            ["--pad-panel", "Inside the control panel"],
            ["--pad-canvas", "Inside the canvas"],
            ["--gap-stack", "Between panel parts"],
          ].map(([token, use]) => (
            <div key={token} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "var(--surface-control)", borderRadius: "var(--radius-xs)" }}>
              <code style={{ color: "var(--text-primary)" }}>{token}</code>
              <span>{use}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Node graph">
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 900 }}>
            <Graph
              height={340}
              wires={
                <>
                  <Wire type="image" from={[264, 40 + socketY(0)]} to={[330, 60 + 2 + socketY(2)]} active />
                  <Wire type="conditioning" from={[264, 190 + socketY(0)]} to={[330, 60 + 2 + socketY(1)]} active />
                  <Wire type="latent" from={[570, 60 + 2 + socketY(0)]} to={[636, 110 + socketY(0)]} />
                </>
              }
            >
              <Node title="Load Image" kind="LoadImage" x={24} y={40}>
                <Socket dir="out" type="image" label="IMAGE" />
                <Widget label="image" value="lighthouse.png" />
              </Node>
              <Node title="Prompt" kind="CLIPTextEncode" x={24} y={190}>
                <Socket dir="out" type="conditioning" label="CONDITIONING" />
                <Socket dir="in" type="clip" label="clip" />
                <Widget label="text" value="Waves crash, the beam sweeps…" />
              </Node>
              <Node title="Wan Image to Video" kind="WanImageToVideo" x={330} y={60} selected running progress={64}>
                <Socket dir="out" type="latent" label="LATENT" />
                <Socket dir="in" type="conditioning" label="positive" />
                <Socket dir="in" type="image" label="start_image" />
                <Widget label="width × height" value="832 × 480" />
                <Widget label="length" value="81" />
              </Node>
              <Node title="Save Video" kind="SaveVideo" x={636} y={110}>
                <Socket dir="in" type="video" label="video" />
                <Widget label="prefix" value="video/out" />
              </Node>
            </Graph>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
          {(["image", "latent", "model", "clip", "vae", "conditioning", "video", "int", "string"] as const).map((t) => (
            <Tag key={t}>
              <span className="ds-dot" style={{ background: `var(--type-${t})` }} /> {t.toUpperCase()}
            </Tag>
          ))}
        </div>
      </Section>

      <Section title="History item">
        <HistoryItem onDelete={async()=>{}}
          media={<Progress label="Rendering" value={64} />}
          model={<Tag icon={<Sparkles size={12} />}>Wan 2.1 I2V</Tag>}
          prompt="A lighthouse on a cliff at dusk. Waves crash below, the beam sweeps slowly, the camera pushes in."
          meta={
            <>
              <Tag icon={<Sparkles size={12} />}>480p</Tag>
              <Tag icon={<Clock size={12} />}>5.0s</Tag>
              <Tag icon={<Dices size={12} />}>184467</Tag>
            </>
          }
          date="October 16, 2026"
        />
      </Section>

      <Section title="Feedback">
        <div style={{ display: "grid", gap: 12, maxWidth: 420 }}>
          <Progress label="Rendering" value={42} />
          <Progress label="Queued" value={null} />
          <Notice title="Generation failed">Out of memory in node 52 (WanImageToVideo). Try 480p or a shorter clip.</Notice>
          <Notice tone="info" title="Nothing here yet">Your generations will appear here.</Notice>
          <div style={{ display: "flex", gap: 6 }}>
            <Tag icon={<Sparkles size={12} />}>480p</Tag>
            <Tag icon={<Clock size={12} />}>5.0s</Tag>
          </div>
          <Slider aria-label="Sample value" defaultValue={60} />
        </div>
      </Section>
    </div>
  );
}

function ToastDemo(){
  const toast=useToast();
  return <Button variant="secondary" onClick={()=>toast("Saved")}>Show toast</Button>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 40 }}>
      <h2 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--text-secondary)", margin: "0 0 12px" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}
