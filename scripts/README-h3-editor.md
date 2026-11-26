# H3 Editor in CreativeField

The Film Studio embeds [H3 Editor](https://github.com/igorls/comfyui-h3-editor) by Igor LS,
pinned at commit `60c1784` (release 0.9.1). H3 Editor is licensed under **GPL-3.0**; its `LICENSE`
and `NOTICE` are copied with the installed pack, and CreativeField itself is GPL-3.0-only.

## Install

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-h3-editor.ps1 -WorkerRoot <worker ComfyUI folder> -PythonExe <worker venv python.exe>
```

Instead of the two arguments you can set `CREATIVEFIELD_H3_WORKER` and `CREATIVEFIELD_H3_PYTHON` once.

The script clones the pinned release into the HyperFlow worker's `custom_nodes/comfyui-h3-editor`,
copies it without `.git`/tests, applies the two CreativeField adaptations, and checks the worker
venv dependencies (`imageio-ffmpeg`, `gguf`). It does not edit any ComfyUI workflow graph.

Restart the HyperFlow worker afterwards and verify `http://127.0.0.1:8309/h3take/editor`.

## CreativeField adaptations

- **Project mapping:** the editor's `start()` reads `?project=cf-<projectId>` and creates that
  project once, then reopens it on every load. `H3FilmStudio` passes the CreativeField project id.
- **Same-origin hosting:** the page is embedded at
  `/h3-editor/<workspaceId>/h3take/editor`; its assets, `/view` media and `/ws` socket are proxied
  by `server/h3-proxy.ts` with workspace membership on every request. No direct worker iframe URL
  is exposed to the browser.
- **Theme:** `scripts/h3-editor-theme.css` maps the editor's variables to the `#ds` tokens
  (`#2fa8ff` accent, `#0f1113`/`#131517` surfaces, Inter, 14 px radius) and the installer also maps
  the canvas waveform, note ink and room fill to the same tokens.
- **Film Studio additions** (`scripts/h3-editor-cf/`, applied by `apply.py` on every install run):
  - sound fade in / fade out on extra sounds (sliders in the sound panel, heard in the preview and the export);
  - grading: a project look (`.cube` LUT with a strength, exposure, contrast, saturation, warmth, grain, soft finish), per-clip
    corrections, and **match grade** (every clip gets a LUT that moves its Lab colour statistics onto one reference
    shot; `skip_match` keeps a clip's own colours);
  - **soft finish** (Grade, on by default at 0.10, 0 to 0.3, 0 is off): over the whole cut before grain, a super subtle
    denoise, a faint mist (a blurred copy screened over the picture at that strength: shadows lift, skin softens) and a
    subtle sharpen, so edges and lettering stay crisp (`cf_grade.soft_graph`). Chosen by eye on three finals (LATER-2620);
    about 1.4 s per 6 s of cut. Turn it down for dark, low-key shots, which it flattens a little.
  - an editable export for DaVinci Resolve and Premiere Pro (FCP 7 XML with its media, sounds and LUTs, as a zip);
  - editor fixes (`editor.js` hooks, theme rules, `cf_api.open_exports`): the clip status reads "Final, take 9" without
    "of N"; the Project line is one short line with the final resolution; Mute and Volume after Zoom set the preview
    level (the export keeps its own levels); right-clicking a timeline clip offers Replace with the latest draft or
    final take; the export dialog shows a loader, then a check and **Open folder**, which opens the project's exports
    folder on the worker's computer; the mouse wheel over the viewer fills the box and scrolls back to the format;
    Rewrite sits at the right end of the What happens label. Python changes need a worker restart.
  - a clip's own sound off while the clip stays (right-click the clip or its wave: Remove its sound / Restore its
    sound; no lock step): the item keeps `muted`, the export gives its audio `volume=0`, the preview plays it silent
    and its wave is dimmed. The selected clip always shows its state, length, frames and the picture's size.
    The same switch sits beside Render draft / Render final as **No sound**, so a clip can be set silent before
    its first take.
  - the render status names the refine's stages (Reading the prompt at full size, Enlarging, Refining at full size
    with its own step count, Decoding the picture). It used to stay on "Decoding the sound" (0.4 s) through all of them.
  - **Standard draft**: the usual draft takes the app's video route (/2500) instead of the
    editor's 640x352 sketch: sampled at 1024x576 (16:9) with the final's steps, then the latent upscaler and a redraw
    from sigma 0.42 to 1472x832 (`cf_studio.STANDARD_*`). Small and Medium stay as quicker previews; finals unchanged.
    A draft whose take holds nothing (no pinned frames, held video or sound, no carry) redraws on the first pass's
    conditioning (`cf_studio.reuse_first_encode`) instead of a second take: no second text encode and no second
    video-model reload, the same picture 30-40 s sooner (,). Extensions, bridges and pinned clips keep it.
    Finals do the same (244 -> 204 s, same picture) and keep their 3-step redraw from 0.675 for now. A 1-step redraw
    from 0.42 (148 s) brought back the darker, harder face; a 2-step redraw from 0.385 (180 s) looked the same as 3
    steps on still shots but turned a moving face harder on a walking shot, so finals keep 3 (LATER-2619).
  - **Footage edits as a shot**: an imported clip (also every clip the app sends to the Film Studio) gets "Edit as a
    shot", and Render draft / final work on it directly. The op `shot_from_footage` (`cf_studio`) drops its footage
    kind and marks its video take `footage`, so it keeps playing until a render replaces it and Takes switches back;
    the clip's own first frame on the timeline becomes its start picture (`first`, via `/grab`). Prompt and cast are
    written like any shot's. Not yet: the app's import does not bring the run's prompt and references along.
  - reference kinds for the cast (`cf_refs.py`): a cast picture is used as a person, a prop or item, a location, a
    look and light, or an outfit ("Used as" in the cast member's dialog). People and items become `<Subject n>`;
    a location keeps its place and layout with the camera free; a look gives light, colours and grade without its
    content; an outfit is worn by the one person in the shot. A clip of people only keeps the editor's own prompt.
    Role wording adapted from BExplains MiniMax H3 RefPacks (MIT).
  The code lives in its own modules (`cf_studio.py`, `cf_grade.py`, `cf_api.py`, `cf_nle.py`, `cf_refs.py`) copied
  beside the editor; `project.py`, `prompting.py`, `editor_api.py` and `editor.js` get small hooks, each a literal replacement marked
  `CreativeField:`. A hook whose upstream text has moved stops the install with its name instead of half-applying.
  The UI is `scripts/h3-editor-grade.js` (Grade in the project menu, "For Resolve / Premiere" in the export dialog),
  inserted after the embed script and built from the editor's own markup. Checks:
  `python scripts/h3-editor-cf/test_cf_studio.py`. The grade shows in the export and in the dialog's before/after
  still, not in the live preview.
- The renderer and upstream ComfyUI nodes are **not** modified. No workflow graphs are authored by CreativeField;
  the editor builds and submits its own upstream graphs.

## Analysis bridge

`server/h3-editor.ts` exposes authenticated workspace routes for project read, clip bytes and note
writes through the local H3 worker. `H3FilmStudio` uses them for the analysis dialog (shot brief,
blocking, measurements) and writes the brief back as an H3 note.
