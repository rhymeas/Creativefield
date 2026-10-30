# Design system

Dark, dense studio UI. Surfaces, type sizes, and layout come from the reference video generator's computed styles (see [../../../docs/higgsfield-ui-map.md](../../../docs/higgsfield-ui-map.md)). The accent (neon blue), the glow buttons, the rounder radii, the motion, and the node graph are our own.

Live reference: run `npm run dev` and open `http://localhost:5173/#ds`.

## Rules

1. **Tokens only.** Components read `tokens.css` variables. No hex values, pixel radii, or font names inside components or screens.
2. **Padding by role.** Use `--pad-chip`, `--pad-control`, `--pad-row`, `--pad-field`, `--pad-card`, `--pad-panel`, `--pad-canvas`, `--pad-page`, and `--gap-stack` / `--gap-inline`. Raw `--space-*` values are for one-off layout only.
3. **One accent, used as light.** Neon blue (`--accent`) marks the active nav item, the model title, focus rings, glows, and the selected node. Nothing else.
4. **No gradients on buttons.** Primary buttons are dark (`--button-primary-bg`) with an accent hairline and a soft glow (`--accent-glow`), which strengthens on hover (`--accent-glow-strong`).
5. **Banned colors:** purple, red, and neon green. Errors are warm amber, success is muted sage, node types use muted hues.
6. **Surfaces step up in lightness:** page → panel → control → control-hover. Never put a darker surface on a lighter one.
7. **Weights.** Inputs, body text, menu items, and errors are regular (400). Labels, values, and tabs are medium (500). Only the generate button and primary button are semibold (600). Bold (700) is only the display font.
8. **Placeholders** use `--text-placeholder` (white at 30 %).
9. **Errors are quiet.** Always use `Notice`: a sentence-case title, a plain sentence below it, regular weight, and amber only on the icon and hairline. No colored body text, no capitals, no bold.
10. **Every interactive element has hover and focus feedback.** Surface steps up one shade and a hairline appears; press scales to 0.97–0.99; focus shows the accent ring. Native `disabled` is only for a transient busy state. When the current surface can make an input valid, keep the action visible with `aria-disabled="true"`, a normal appearance, and a visible `aria-describedby` hint.
11. **Loading.** `SparkleLoader` is the only spinner. Text that describes a running state uses `ShimmerText`; unknown content uses `Skeleton`. Motion is off under `prefers-reduced-motion`.
12. **Buttons stay quiet.** Only the primary action (Generate, Done) is bright and glows. Secondary, ghost, and glass buttons (Cancel, Reuse, Download, Change, Remove) use secondary text color and regular weight, and brighten only on hover.
13. **Progress is text.** The shared `JobQueueMenu` in the header may use the requested circular progress hint; it pairs it with a readable state and percentage in the dropdown. Other surfaces keep text progress. The sparkle, a shimmering label, and a quiet percentage. There is no progress bar.
14. **Context stays out of the way.** Secondary information and repeated per-item actions may appear on hover, but must also appear on `:focus-within`. A primary action is never hover-only. Detail overlays open over the content so nothing shifts.
15. **Three levels of information, never more.** Every piece of text on a screen is exactly one of these:

    | Level | Role | Style | Component |
    |---|---|---|---|
    | L1 | Title: what this screen or panel is | `--text-md`, medium, `--text-primary` | `SectionHeader` |
    | L2 | Context: where you are, what you can switch | `--text-xs`/`sm`, regular, `--text-secondary`, quiet pill | `ContextBar`, `Pill quiet`, `SegmentedTabs quiet` |
    | L3 | Meta: facts about the thing (role, source, counts, timestamps) | `--text-xs`, regular, `--text-tertiary`, plain text, dot-separated | `Meta` |

    The top bar is L0 (navigation) and is the only place with white medium-weight text besides L1.
16. **Chips are for actions or states, not facts.** `Tag` is for a value the user can read as a status (Supported, Ready) or act on. Static facts ("Local ComfyUI", "admin · Shared", "Latest 200 runs") are `Meta`, never a chip.
17. **Scope has one place.** The project is chosen in the top bar (Projects menu, the chosen project shown after the label). Screens have no row of pills above their content; the mode switch is `ModeTabs` (rule 32). `ContextBar` exists in the system but is not used by the team screens.
18. **Do not invent a style for a new element.** Reuse a level above. If none fits, add a component to `src/ds/` and a showcase entry first, then use it. Feature CSS (`team.css`) may only handle layout (flex, grid, gap, sizing), never color, weight, or font size.
19. **Navigation has two levels, never three.** The top bar (sections, with its menus) and, on screens with modes, one `ModeTabs` row under it. Pickers of an object (a storyboard, a render, a worker) live in the header of that object's panel or block, next to its title. Never add another bar of pills and tabs, and never show the same name twice. One entry may lead the product: `NavItem featured` (and `PresetCard featured` on All tools) draws a thin `--brand` yellow ring around it. It is the only use of `--brand` besides the app name; never feature more than one.
20. **Page spacing comes from layout components.** A screen is `Page` (side margin `--pad-page-x`, top/bottom `--pad-page-y`, gap `--gap-section`) containing `Split` (columns) and `Block` (column of blocks, gap `--gap-block`) with `Toolbar` rows (gap `--gap-stack`). Nothing may touch the window edge or its neighbour. Feature CSS never sets its own paddings or gaps in pixels.
21. **Buttons hug their text.** `Button` and links with `ds-btn` size to their label and stop at `--button-max-w`. The one primary `GenerateButton` fills the panel width. Never `width: 100%` on a button. Labels are one to three words ("Cancel render", not "Cancel storyboard render").
22. **Meta is quiet.** L3 text is `--text-2xs` at `--text-meta` (white 42 %). If it must be read as a control or heading, it is L2 or L1.
23. **The main action is the sparkle and one word.** `GenerateButton` shows the sparkle and "Generate" and nothing else: no amount, no frame count, no unit. While a run is starting the loader takes the sparkle's place.

24. **One component per function.** Before writing markup, look up the function here. Never build a second component for something that is already listed.

    | Function | Component |
    |---|---|
    | Upload a file | `UploadSlot` (`tile` inside `UploadPair` for two side by side) |
    | Many references for one run (people, products, clothes) | `ReferenceTray` (a `Thumb` per reference with `onRemove`); it carries the cap and the add tile |
    | Text input, any length | `PromptField` (`PromptGroup` for related fields) |
    | Optional section | `ToggleRow`, `Collapsible` |
    | Pick one of many | `Row` with options and `TeamChoice` both open `ChoiceDialog` (boxes: icon, name, one line, status); `ParamButton` only for tiny numbers like duration |
    | Button / download link | `Button`, `LinkButton` |
    | State of a thing | `StatusText` (dot and word), `Notice` for problems |
    | Facts about a thing | `Meta` |
    | A finished run | `HistoryItem`; a storyboard item: `Result`; a stored file: `MediaCard` in `ds-grid` |
    | Waiting for content | `ResultSlot`, `Skeleton`, `SparkleLoader` |
    | Long text | `ClampText`, or a `PromptField` that grows |
    | Page and spacing | `Page`, `Split`, `Block`, `Toolbar`; a `Rule` line between zones |
    | Navigation | `TopBar` (with `MegaMenu`), one `ContextBar`, `SegmentedTabs`, `UnderlineTabs` |

    If nothing fits, add the component to `src/ds/components.tsx`, show it in `Showcase.tsx`, and add a row here. The guard fails otherwise.
25. **Long text never breaks the layout.** Text fields grow with their content up to `--prompt-max-lines` lines, then scroll and show an expand button that opens the full text in a modal. Compact `PromptField`s stop at four scaled lines. Read-only long text is clamped to a few lines with `ClampText` and a "Show all" button. Single-line labels (file names, titles) cut off with an ellipsis and carry the full text in `title`. Nothing overlaps: labels sit in the flow above their text, never on top of it.
26. **Show only what works here.** A control, tab, menu entry or button exists only where it has an executable workflow in that context. Never render an unimplemented feature, missing backend, missing model, or missing node as a disabled control, "soon" entry, or placeholder. Put factual requirement text in the catalogue or capability detail without a button-shaped element. A locally fixable missing input keeps the real action visible using the rule 10 `aria-disabled` and hint pattern. Secondary object actions may reveal on hover and focus. When a prerequisite is missing and the app can do it for the user, the visible action is that prerequisite, labelled with its own verb (no project: "New project"; no images yet: "Add an image in Library"; only then "New character"). Show an action only when clicking it works right now, in this context: project chosen, prerequisite objects present, workflow qualified. If a prerequisite is missing and the app can perform that prerequisite, the button *is* the prerequisite, labelled with its own verb and taking the user there: no project → "New project"; a project without images → "Add an image in Library"; only then "New character". Resolve such chains in dependency order, and when the prerequisite is met, swap the action in the same place. An `EmptyState` carries exactly one action: that next step. Never show the target action as a dead button with an explanatory hint underneath ("Upload an image first") — a hint may explain a choice, it never substitutes for the missing step. Narrow exceptions: errors fixable inside the same form (typing, selecting) keep rule 26's `aria-disabled` plus inline hint; read-only or signed-out contexts show no action at all.
27. **Desktop studio only.** The supported floor is 1280×720 CSS pixels at the default `--ui-scale: .9`. The shell never changes into a phone layout. Below the width floor it preserves the desktop canvas and scrolls horizontally; do not add narrow stacking, touch-only behavior, or an unsupported-device banner.
28. **Forms, feedback and menus.** Inputs are `TextField` / `Checkbox` / `SearchField` (label above, hint or error below). Records in a settings list are `DataRow`. Every destructive action goes through `ConfirmDialog` with a clear verb. Success is a `useToast` message, never a Notice; problems are `Notice`. The avatar opens `UserMenu`, not a dialog. Choosing one look (camera move, style) is `PresetGrid`. On All tools a task is `PresetCard size="tool"`: the same card with its name one text step larger, clear of the picture, and its line clamped to four lines.

29. **A panel has one title.** Inside a control panel only the panel header is level 1. Groups of controls are `PanelSection` (small grey label, optional `Meta` on the right). Choosing a record with new or edit actions is `PickerRow` (a `Row` or `TeamChoice` row plus `IconButton`s); adding another item to a list is `AddButton` at the end of the list. `AddButton` is the one dashed ghost add action: label-width only, left-aligned, with about 44–48 px side padding; it never spans the container. Controls and buttons never go inside a `SectionHeader`. State that needs detail ("Renderer ready", fonts and versions, run ids, hashes) is one `StatusText` or `Meta`, with the detail on hover or in Details.

30. **Problems carry their actions.** A `Notice` is for a problem only. Its ways out go in the `actions` prop (below the text, left-aligned, same gap everywhere), never as buttons mixed into the sentence. "Nothing here yet" is an `EmptyState` (icon, title, one sentence, one action), never a Notice. An error or offline `EmptyState` never ends with instructions alone when the app has a safe recovery: its one action performs the next real step (`Start ComfyUI`, `Reconnect`, `Open worker settings`, `Try again`). Never label a button with a recovery the app cannot actually perform. The view switch of a screen (Create / Edit / Storyboard) sits centered in the `ContextBar` (`center`), large, not tucked into the corner.

31. **Say it once, and only if it helps.** A caption next to a title, a count, a timestamp or a "where" label is the exception, not the default. Never repeat what is already visible (the project name, the model name, "Local ComfyUI" when everything is local, "Shared · admin", "Latest 200 runs · Updated 10:29"). Constants are not information. What remains (a date on a finished clip, a run id, a hash, a version) lives on the object it describes, in Details or in a hover title, never in a row of grey text under a heading. A screen shows at most one caption line per section.

32. **One place for scope, one for mode.** The project is chosen in the top bar (right, beside the workspace), never in a row of its own. A screen's modes (Storyboard, Create, Edit, Trim) are `ModeTabs`: large, centered under the top bar, active mode in white with a glowing underline. There is no second row of pills, tags or buttons above the content.
33. **Facts about a tool are on request.** Versions, contracts and limits (ffmpeg version, frame rate, "output is muted") live behind an `InfoButton` next to the page title. Stream indexes and other expert inputs are folded into a `Collapsible`. Long timelines (shots, scenes) scroll horizontally with edge fades and arrows (`ShotStrip`); text scenes are editable cards, not one big text box.

34. **An empty page is a page, not a card in a panel.** A screen with nothing to show yet is a centered column (`ds-page--narrow`): large `SectionHeader`, then one `EmptyState`. It is never wrapped in a `Panel`, and feature CSS never positions it with widths or `data-` flags. Lists with a detail view (characters, projects) use `Split`: list panel on the left, detail on the right, and only once there is something to list.

35. **One desktop scale and aligned work panels.** `--ui-scale` defaults to .9 at every desktop width. Production panels start underneath the WorkspaceBar tabs and keep that position when scale changes; their content remains capped by `--frame-w`, with the extra space after the work area. The WorkspaceBar's own content takes its page's inset through `--bar-inset`: on a page inside the frame, its end group (density, info) and a page `Toolbar`'s end control stand on the same right edge, and its tabs on the same left edge, at every width; a page whose content fills the work area declares that itself (`Page fill`; `Page workspace` for a canvas) and keeps the plain gutter, so the tabs still start above the panel they head — the bar reads only that declaration, never a list of screen names. Reading pages stay centered. Never stretch content to the window, never set a screen-specific width to fix it; add margin, not width. Empty areas use `EmptyState stage` so the message is centered, not stuck to the top. Native full-height editor surfaces use `Canvas workspace`: its body is a flex column with no reading-column cap, so the stage fills the remaining height. Canvas editing tools use `Page workspace`: compact token gutters and an uncapped work area give the canvas the available window space; reading and catalogue pages retain the centered frame.

36. **Problems have one place.** A screen never shows several problems in several spots. Every danger `Notice` outside a dialog or form flows into the single `ProblemBar` under the top bar: one row at a time (the most important, by `priority`), the rest behind "+N more". A problem that is only a result of another (no queue because the server is down, no runs because the request failed) is a `consequence` and stays hidden while its cause is shown. Give every `Notice` a `priority` and mark consequences. Use `inline` only for a problem that belongs to one field in a form. Success is a toast, "nothing here yet" is an `EmptyState`, neither is a problem. **Every problem carries its fix.** A problem `Notice` and every not-ready `EmptyState` (offline, missing worker, missing models, failed request) has exactly one action that solves it, labelled with its own verb: ComfyUI offline -> "Start ComfyUI"; no worker -> "Add a worker"; models missing -> "Set up"; request failed -> "Retry"; server unreachable -> "Retry connection". The text says what the action will do, not only what is wrong. Never state a failure on its own, and never send the person outside the app ("start it on the worker, then reload this page"). When the app cannot fix the cause itself, the action opens the exact place where the person can (worker settings, the setup guide), and the screen rechecks on its own once the cause clears, with no reload. A problem without a possible action is a bug to fix, not a state to design.
37. **Standard first, Advanced behind one row.** A panel shows only what most people set every time: inputs, the prompt, and at most three quick parameters. Everything else (seed, strength, negative prompt, model, worker when only one is ready, technical limits) lives in one "Advanced" row that opens a dialog and summarizes its current values in one line. A setting never appears both in the panel and in Advanced.
38. **Footer hints live behind an "i".** What is still missing sits in a `HintButton` above the main action, not as lines of text, and the footer has no divider line.
39. **No bookkeeping text.** Timestamps like "Last checked", counters, version strings, and internal ids are not shown unless the user can act on them. If a fact only matters when something is wrong, it belongs in the problem bar; if it matters on request, behind an `InfoButton`.
40. **Media stays clean.** Never overlay internal shot/scene/take codes, filenames, browser-storage notes, or provenance labels on user-facing image/video previews. Put actionable media tools on hover and keyboard focus; keep provenance available in Details or export only when the user asks for it.
40. **Every wait, empty, error and success state exists once per screen.** Loading is shimmer text or a sparkle, empty is an `EmptyState`, error is the problem bar, success is a toast. A new screen is not done until each of these is designed or consciously not needed.
41. **Long content always has a way out.** Text clamps with `ClampText` or grows to a limit and opens in a dialog; lists scroll inside their own region; names truncate with the full value on hover or in info. Nothing pushes the main action off screen.
42. **Disabled needs a reason, and only one.** A disabled control is hidden when it can never apply here, and otherwise states in the footer hint the single missing step. Never a disabled control plus a notice plus a hint for the same cause.
43. **Destructive and irreversible actions confirm; reversible ones undo.** Delete, overwrite, discard and send use `ConfirmDialog` with the named object. A failed confirmation uses its `error` prop so the short problem stays inside that same dialog with the retry action. Everything else applies immediately and offers Undo in the toast.
44. **Focus and keyboard.** Every interactive element is reachable and visibly focused; Enter submits the primary action in a dialog; Escape closes. Opening a dialog focuses its first field once and never steals focus while typing.
45. **One word per thing.** The same object has the same name on every screen (Project, Library, Asset, Worker, Run). Buttons are verbs ("Queue video"), tabs and nav items are nouns, and labels never repeat their section title.
46. **Editors use the editor parts.** Layers are `LayerList`/`LayerRow`, numbers on a range are `SliderField`, the picture sits on a `Stage`, colors come from `Swatches`. Tools sit in the canvas toolbar, tool options appear only while that tool is active, and only the selected layer shows its properties. Reorderable side panels use `DockStack` with named `DockPanel` grips: pointer preview, animated neighbors, Escape cancellation and Alt+Up/Down keyboard ordering. Persist only completed drops; respect reduced motion.
47. **Sections in the rail, modes in the bar.** The app's sections (Video, Image, Motion, Characters, Influencer, Marketing, Audio, Models, Library) are icons in the `AppRail` on the left, named by tooltip, the current one tinted with the accent. The `WorkspaceBar` above the content never repeats the section name: it holds only the mode tabs (accent underline on the active one) and the page's end slot. On every content page with a grid, the end also carries `DensityControl`: one grid icon at rest; the slider and value appear on hover or keyboard focus. The selected number is the actual column count for browse, tile, history, and result grids, capped by the number of visible items. Never restore a permanent "Per row" label or an always-visible slider. Main content screens including Models use the normal `Page` frame; `Page narrow` is reserved for focused forms and empty states. No second row of tabs and no section list in the header. Use `TileGrid` without overriding the shared density, and `ModelTile roomy` when its copy needs more air.
   Models has one header owner: `CapabilityCatalogue`. Its Models/Nodes/Workflows switch and single active-view search belong there. `ComfyLibraryPanel` supplies content and library actions, not another page title, search or view switch. Workflow execution/status filters appear only in Workflows.

48. **The side panel has one position.** Every left side panel hangs out to the left of the content frame by at most `--panel-pull` (rule at the end of `components.css`, selector `:is(.ds-split, .cf-production, .cf-marketing, .cf-influencer, .cf-character-list) > .ds-panel:first-child`); the content next to it does not move. The pull is bounded by the page side gutter (`--pad-page-x`) minus `--gap-block`, keeping a visible left inset inside scrolling ancestors. Never position a panel with a margin or padding in a feature's CSS. Right-hand `DockStack` panels fit the stack's available content width after scrollbar space is reserved; do not give them a fixed width wider than the scrolling viewport or allow horizontal scrolling.

49. **Ambient reels decorate, never persuade.** A decorative `AmbientReel` may sit behind the model card, a `Panel`, a full-page `EmptyState stage` and the `AppRail`. It is muted, looping, non-interactive, `aria-hidden`, plays only while visible, and hides its video under `prefers-reduced-motion`. Keep a scrim and enough contrast for text and controls. A reel is atmosphere, not evidence: never present it as model output or use it where it would compete with the main task.
50. **Keep forms and media free of bookkeeping.** Do not show character counters, maximum-line hints, empty section counts or internal scene/shot/take codes in the normal interface. Enforce limits silently while valid; when exceeded, show one clear, actionable validation message. Keep provenance in saved run data and expose it only in an explicit details view. Media labels describe the content or state in plain language.

51. **Extra info is on hover.** Secondary facts on a card or row (model, duration, address, type) are `Meta` that appears on hover or focus, with its space reserved so nothing jumps. Facts the user needs to choose (status, name) stay visible. No bookkeeping text (rule 39).
52. **Captions and breathing room.** Tab, pill and small-button labels use `--text-caption` (13 px), never wrap (`nowrap`, ellipsis) and keep at least `--space-4` of side padding. Copy followed by a call to action has `--space-4` between them. Boxes are never cramped: if it does not fit, cut text, do not shrink padding.
53. **Tile hierarchy.** A model or workflow title keeps the full copy-column width. Its status sits below the title so a state chip never truncates the thing the user needs to identify.
54. **A screen uses the design system; it never rebuilds it.** No raw `<button>`, `<input>`, `<select>` or `<textarea>` outside `src/ds`, no colour, font, radius, shadow or opacity in feature CSS, no inline styles beyond the listed layout exception. A thing that appears on more than one screen (the Choose from library button, the media box, a dropdown) exists once, as a component, and a test keeps it that way. `npm run audit:ds` prints the numbers; `test/ds-bypass.test.ts` fails on any new bypass and its allowance can only shrink.
55. **Hero over results.** A results pane may open with one `Hero`: an encouraging uppercase title (L1 display), one short sentence, and the tool's own clip on the right. Three slow accent-blue glows drift behind that clip; this is the only glow that is not an action, and it never uses another hue or a gradient fill on text or buttons. Words come from one table (`src/team/heroes.tsx`).
56. **Results show only what exists.** A result grid never shows a failed, cancelled or empty attempt, and never a card for a file that was removed. A failure is said once, in the panel that started it, through `Notice` (rule 36).
57. **While it works, only the word shimmers.** The busy Generate button says "Generating" and that word shimmers. No step text, status line or copy of the prompt sits above or below the button while it runs.
58. **A result explains itself with one strip.** What a tool was given and what it made first (your picture, the frame the model saw, its masks, the first frame) is one `FrameStrip`, in the result's details and in a preview, never a custom gallery.

## Guard (enforced by `npm test`)
`test/ds-guard.test.ts` fails when feature CSS (`src/team`, `src/ui`) sets color, font, background, border, radius, shadow, opacity or pixel spacing; when feature code uses `style={}`, raw `<details>`, or a raw `<h1-3>` without a `ds-` class; when more than one `ContextBar` is used in `src/team`; when a native file input, raw `<textarea>`, button-styled `<a>` or custom card is used instead of the DS component; when a design-system component is missing from the showcase; or when navigation/tab definitions contain dead disabled entries. Fix the screen by using or adding a DS component, never by loosening the test.

## Tokens

| Group | Tokens |
|---|---|
| Surfaces | `--surface-page` #0f1113, `--surface-panel` #131517, `--surface-control` #1c1e20, `--surface-control-hover` #232528, `--surface-subtle`, `--surface-hover`, `--surface-glass` |
| Text | `--text-primary` #f7f7f8, `--text-secondary` #898a8b, `--text-tertiary`, `--text-muted`, `--text-placeholder` (30 %), `--text-on-accent` #0b1520 |
| Accent | `--accent` #2fa8ff, `--accent-soft`, `--accent-ring`, `--accent-glow`, `--accent-glow-strong` |
| Buttons | `--button-primary-bg` #171b21, `--button-primary-bg-hover` #1b2028, `--button-primary-text` |
| Status | `--status-danger` #e8b46a amber (+ soft and line), `--status-ok` #a9c7b5 sage |
| Type | Inter 11/12/14/16, Space Grotesk 700 at 20 and 40 |
| Radius | xs 8 (tags), sm 12 (params, rows), md 12 (buttons, tabs), lg 14 (menus), xl 18 (generate, nodes), 2xl 22 (cards, fields, canvas), full (pills) |
| Sizes | top bar 36, panel 318, control 40, row 48, tab 36, pill 24 |
| Node graph | `--node-bg`, `--node-header`, `--node-border`, `--node-w` 240, `--port-size` 10, `--wire-width` 2.5, `--type-image`, `--type-latent`, `--type-model`, `--type-clip`, `--type-vae`, `--type-conditioning`, `--type-video`, `--type-int`, `--type-string` |
| Motion | `--ease`, `--ease-spring`, `--dur-fast` 140 ms, `--dur-med` 220 ms, `--dur-slow` 1.6 s |

## Components

| Component | Use for |
|---|---|
| `TopBar`, `Badge`, `Pill`, `Avatar` | Global navigation and account area |
| `UnderlineTabs` | Modes at the top of the control panel |
| `SegmentedTabs` | Canvas views (History / How it works, List / Grid) |
| `Panel` | Left control column; `footer` holds the generate button |
| `ModelCard`, `GlassButton` | Current model with artwork; buttons over media |
| `AmbientReel`, `AmbientReelProvider` | Decorative muted video behind model cards, panels, empty stages and the rail; reduced-motion safe |
| `ContactSheet` | Clean canvas contact sheet for a batch with optional human-readable shot labels and PNG download |
| `CompareWipe` | Original/final image comparison with keyboard slider; matching raster dimensions required |
| `MaskOverlay`, `DriftOverlay` | Accent-tinted effective mask with dashed edge, or measured changed pixels outside it; overlays are never exported into media |
| `Corkboard` | Pinned, slightly rotated grid of planned shot cards (use `ShotCard` inside); one accent pin per card, no glow |
| `InbetweenRail` | First/last stills with frame-count slots; ghost slots before a run, real extracted frames after; `imageFrameIndices` labels actual sampled positions |
| `Flashlight` | Browser-only relight guide: draggable light circle, direction and temperature readout; keyboard arrows and Page Up/Down; never a fake render |
| `GestureStage` | Camera move recorder: drag across the frame to snap to a pan, wheel or Page Up/Down for zoom; shows the chosen move, replays the path and downloads it as JSON. Never a fake render |
| `CastCard` | Portrait, name, reference/shot counts; optional activate and drag source. Real counts only |
| `DropTarget` | Scene drop zone for a cast card or other text payload; dashed quiet border, accent while a valid card is over it; nested drops are handled only by the inner target |
| `ScoutReel` | Scroll-snap destination rail with frame thumbnails; wheel and arrow keys cycle, selected tile gets the accent ring |
| `TrackSticker` | Mask/box overlay with a tracked-object pin; used on a real video frame only |
| `Teleprompter` | Current spoken line emphasized; no word-level karaoke without a real alignment |
| `WordWave` | Actual PCM peaks and source-bound speech-engine word onsets; words and waveform seek, punctuation/repeated source spans preserved. Showcase uses a measured local engine fixture; no estimated alignment |
| `VisemeStrip` | Source-bound SAPI en-US mouth-form events; schematic glyphs, seek and arrow/Home/End navigation, active event follows the shared media clock. Hidden without validated timing; not analysis of generated lips |
| `PoseStrip` | Actual OpenPose/SDPose body and hand points, no interpolated joints; measured sample selection and arrow/Home/End controls. Showcase currently uses one real extracted reference-image pose, not a video sequence |
| `LevelMeter` | 16-bar microphone level with a live percentage; fed by the local analyser, never a decorative animation |
| `UploadSlot` | Media inputs, with drag-and-drop and preview. `compact` makes a shorter slot. `previewKind="video"` previews a silent loop; `previewKind="audio"` provides explicit audio playback controls. Image previews show the whole image, never a crop. Audio quick-pick `Thumb` uses `audio` for a sound glyph |
| `ReferenceTray` | Many references for one run, up to a cap (`max`): a scrolling row of `Thumb`s with a remove action each, the count ("3 of 30") and an add tile that is gone at the cap. Use it instead of a grid of one-file uploads when a run takes several pictures |
| `Rule` | The one hairline between two zones of a screen or panel; screens never draw their own divider |
| `PromptField` (`compact`), `ToolChip` | Text fields with inline tools |
| `Row` (default and `subtle`) | Full-width selects (model, seed) |
| `Params` + `ParamButton` | Three compact selects in a row (duration, ratio, resolution) |
| `GenerateButton` | The one primary action; `cost` says what the run makes (`81 fr`, `1 img`, `4 s`), `disabledReason` says what is missing, and `busy` swaps the sparkle for the loader |
| `Button`, `IconButton` | Secondary actions |
| `Canvas`, `Slider` | Right workspace and its toolbar |
| `HistoryItem`, `Tag` | A result at full width. Its details (prompt, start image, meta chips, Reuse, Download) are hidden until the Details button on the media is pressed; they open over the media and close with Escape |
| `SparkleLoader`, `ShimmerText`, `Skeleton` | Loading states |
| `Progress`, `Notice` | Job state, errors, and hints |
| `HowItWorks` | Three-step empty state |
| `Tooltip` | Viewport-clamped hover facts and keyboard-accessible disabled-action reasons |
| `MediaEditProvider`, `MediaViewer` | Shared click/full-view, alpha-preserving crop copies and links to the existing AI/full editors |
| `PerformanceMirror` | Driving/result videos linked by elapsed time. Full comparison view supports play/pause/seek together, unlink/relink and result-editor entry; shorter clips define the shared duration |
| `Dialog` | Modal with a title, body, and footer. Shares topmost-modal focus trapping with `MediaViewer`; Escape and close restore the trigger's focus |
| `ModelOption` | Selectable model card with a status (ready, not installed, needs update, offline, checking) and an optional detail area |
| `CodeLine` | A shell command with a Copy button, for notices that tell the user what to run |
| `Graph`, `Node`, `Socket`, `Widget`, `Wire`, `socketY` | ComfyUI-style node view: typed, color-coded sockets, widgets, and animated wires for running links |

Crop edge controls use CropHandles (Showcase): fixed screen targets outside the image, pointer capture and keyboard nudges; crop geometry remains in the editor.

TransformHandles (Showcase) provides fixed-size corner, move and rotation targets for proportional layer transforms; pointer capture, arrow-key nudges, Enter/Apply and Escape/Cancel. DockStack can be inert while a canvas transaction owns editing.

`JobQueueMenu`: shared header Jobs dropdown with circular progress, two-line titles, keyboard dismissal/focus return and scoped retry. Data updates live in the application monitor; Showcase includes active and queued jobs.

AnnotationEditor: shared numbered region editor with attached instructions, pointer drawing, keyboard movement/resizing and removal. Showcase before screen usage. Quick preview hands the regions to Image Edit; generation remains an explicit Modify action.
