"""Hooks for the Film Studio references panel (user 2026-11-25, Pad); apply.py adds them to its HOOKS.

The cast panel becomes References: one section per kind (People, Places, Props, Look, Outfits), one or many
pictures dropped on it or picked at once, each sorted into its kind by a local text model (editor/cf-refs.js). A clip's
references are grouped the same way and take pictures dropped on them. Kept in its own file so the hooks of other
work in apply.py stay apart.
"""

HOOKS = [
    ("editor/editor.js", "references panel import",
     'import * as writer from "./writer.js";\n',
     'import * as writer from "./writer.js";\n// CreativeField: references panel, packs and quick edits (apply.py stamps each module with its content hash)\n'
     'import * as cfRefs from "./cf-refs.js";\nimport * as cfPacks from "./cf-packs.js";\nimport * as cfQuick from "./cf-quickedit.js";\n'),
    ("editor/editor.js", "references panel empty",
     "    list.innerHTML = '<p class=\"empty\">Add a picture of a person or place to keep them the same across clips, or a voice for a narrator.</p>';\n",
     "    list.innerHTML = '<p class=\"empty\">Drop pictures here: people, places, props, a look or an outfit. Each is sorted into its kind and stays the same across clips.</p>';  // CreativeField: references panel\n"),
    ("editor/editor.js", "references panel groups",
     "  list.style.display = \"\";\n  list.replaceChildren(...cast.map((person) => {\n",
     "  list.style.display = \"\";\n  cfRefs.group(list, cast, cast.map((person) => {  // CreativeField: references panel\n"),
    ("editor/editor.js", "references panel add",
     'async function addCastMember() {\n  const file = await pickFile($("castFile"));\n  if (!file) return;\n',
     'function cfTools() {  // CreativeField: references panel and packs\n'
     '  return { project: () => state.project, upload: uploadPicture, save, render: renderAll, renderAll, toast, uid, checkpoint,\n'
     '    clipOf, remove: removePerson, undoAction, state, api, postJson, catalogOps, catalogState, assetUrl,\n'
     '    openPanelDialog, drawPanelDialog, quick: cfQuick, flush, adopt, updateQueue, clientId, activeTake, clipOfNote: clipOf, select: (id) => { state.person = id; state.clip = null; state.item = null; } };\n}\n\n'
     'async function addCastMember() {\n  const files = await cfRefs.pickMany($("castFile"));  // CreativeField: references panel, several at once\n'
     '  if (files.length) checkpoint();\n  if (files.length) return cfRefs.addPictures(files, cfTools());\n  const file = null;\n  if (!file) return;\n'),
    ("editor/editor.js", "references panel drop",
     '$("addCast").addEventListener("click", addCastMember);\n',
     '$("addCast").addEventListener("click", addCastMember);\n'
     'cfRefs.dropMany($("cast"), (files) => { checkpoint(); cfRefs.addPictures(files, cfTools()); });  // CreativeField: references panel\n'
     'cfRefs.bind(cfTools);\ncfPacks.bind(cfTools);\n'
     '$("cfPacks").addEventListener("click", () => { $("castMenu").hidePopover?.(); cfPacks.open(); });\n'),
    ("editor/editor.js", "references in a clip title",
     '  title.textContent = "Cast in this clip";\n',
     '  title.textContent = "References in this clip";  // CreativeField: references panel\n'),
    ("editor/editor.js", "references in a clip groups",
     '  const hint = document.createElement("p");\n  hint.className = "hint";\n'
     '  hint.textContent = "Write @" + pictured[0].name + " in What happens to place them in the shot.";\n  return [title, picks, hint];\n',
     '  cfRefs.groupPicks(picks, state.project.cast);  // CreativeField: references panel\n'
     '  cfRefs.dropMany(picks, (files) => { checkpoint(); cfRefs.addPictures(files, cfTools(), clip); });\n'
     '  const hint = document.createElement("p");\n  hint.className = "hint";\n'
     '  hint.textContent = pictured.length ? "Write @" + pictured[0].name + " in What happens to place them in the shot. Drop pictures here to add them to this clip."\n'
     '    : "Drop pictures here: people, places, props, a look or an outfit. They are sorted and added to this clip.";\n  return [title, picks, hint];\n'),
    ("editor/editor.js", "references in every clip",
     '    ...(state.project.cast?.some((p) => p.file || p.refmod) ? castPicker(clip) : []),\n',
     '    ...(state.project.cast ||= [], castPicker(clip)),  // CreativeField: references panel, a drop place even before the first reference\n'),
    ("editor/index.html", "references panel title",
     '<div class="panel-head cast-head"><h2>Cast</h2>',
     '<!-- CreativeField: references panel -->\n      <div class="panel-head cast-head"><h2>References</h2>'),
    ("editor/index.html", "references panel menu",
     '<button id="addCast" role="menuitem"><b>Add reference</b><span>A picture of a person, a product or a place to keep the same in every clip</span></button>',
     '<button id="addCast" role="menuitem"><b>Add pictures</b><span>People, places, props, a look or an outfit; pick several, each is sorted into its kind</span></button><!-- CreativeField: references panel -->'),
    ("editor/index.html", "reference packs menu",
     '<button id="addFromCatalog" role="menuitem"><b>From the catalog</b><span>Someone you saved in another project, with their pictures and voice</span></button>',
     '<button id="addFromCatalog" role="menuitem"><b>From the catalog</b><span>Someone you saved in another project, with their pictures and voice</span></button>\n'
     '        <button id="cfPacks" role="menuitem"><b>RefPacks</b><span>Save these references as a pack, or use a pack in this project or clip</span></button><!-- CreativeField: reference packs -->'),
    ("editor/editor.js", "replace a reference picture",
     '  card.append(words);\n',
     '  card.append(words);\n  if (person.file) cfRefs.dressPortrait(card, person);  // CreativeField: references panel, picture opens the viewer, Replace\n'),
    ("editor/editor.js", "render notes",
     '  return section("Notes" + (open.length ? ", " + open.length + " open" : ""), [...rows, hint], "note");\n',
     '  return section("Notes" + (open.length ? ", " + open.length + " open" : ""), [...cfRefs.notesActions(notes, cfTools()), ...rows, hint], "note");  // CreativeField: render notes\n'),
    ("editor/editor.js", "notes at their mark",
     '    line.addEventListener("click", () => showNoteInList(note.id));\n    return line;\n  }));\n}\n',
     '    line.addEventListener("click", () => showNoteInList(note.id));\n    return line;\n  }));\n'
     '  cfRefs.placeNotes(tag, box, here, rect, noting.active);  // CreativeField: a note sits at its box\n}\n'),
    ("editor/editor.css", "references panel styles",
     '.person { position: relative; }\n',
     '.person { position: relative; }\n'
     '.cf-ref-head { grid-column: 1 / -1; margin: 0; font-size: 11px; font-weight: 600; color: var(--muted); }  /* CreativeField: references panel */\n'
     '.cast { grid-auto-flow: row dense; }\n'
     '.cf-ref-group { grid-column: span var(--n); display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 6px 8px; align-content: start; }\n'
     '.picks { column-gap: 20px; row-gap: 10px; }\n'
     '.cf-pick-group { display: flex; flex-direction: column; gap: 6px; }\n'
     '.cf-pick-row { display: flex; flex-wrap: wrap; gap: 8px; }\n'
     '.menu button > b + span { display: none; }\n'
     '.menu[role="menu"] { width: max-content; min-width: 150px; max-width: 320px; }\n'
     '.person > .cf-tile-x { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; padding: 0; font-size: 15px; line-height: 1; }\n'
     '.person.cf-sorting { opacity: 0.45; animation: cf-sorting 1.2s ease-in-out infinite alternate; }\n'
     '@keyframes cf-sorting { to { opacity: 0.8; } }\n'
     '.cast.drop-hot, .picks.drop-hot { outline: 1px dashed var(--tungsten); outline-offset: 2px; }\n'
     '.person.drop-hot { border-color: var(--tungsten); }\n'
     '.person:hover .cf-tile-x, .cf-tile-x:focus-visible { opacity: 1; display: grid; place-items: center; }\n'
     '.cf-ref-head { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n'
     '.cf-pack-card { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px; border: 1px solid var(--line); border-radius: var(--radius); }\n'
     '.cf-pack-text { display: grid; gap: 6px; min-width: 0; }\n'
     '.catalog-grid:has(.cf-pack-card) { gap: 16px; }\n'
     '#panelDialog:has(.cf-pack-card) { width: min(92vw, 820px); }\n'
     '.cf-pack-card .cf-pack-strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; margin-top: 6px; }\n'
     '.cf-pack-strip figure { margin: 0; display: grid; gap: 6px; min-width: 0; }\n'
     '.cf-pack-strip figcaption { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n'
     '.cf-pack-card .cf-pack-strip img { width: 100%; height: auto; aspect-ratio: 1; object-fit: cover; border-radius: 6px; }\n'
     '.cf-pack-tools { display: flex; flex-wrap: wrap; gap: 6px; }\n'
     '.cf-pack-tools button, .cf-pack-new button { white-space: nowrap; }\n'
     '.field.cf-pack-new { display: flex; gap: 8px; align-items: center; margin: 8px 0 12px; }\n'
     '.cf-pack-new input { flex: 1; min-width: 0; }\n'
     '.cf-portrait { cursor: zoom-in; }\n'
     '.cf-portrait-text { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; min-width: 0; }\n'
     '.cf-replace { white-space: nowrap; padding: 6px 14px; }\n'
     '.cf-viewer { width: min(92vw, 1400px); height: min(90vh, 1000px); padding: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--room); color: var(--text); overflow: hidden; }\n'
     '.cf-viewer[open] { display: flex; flex-direction: column; }\n'
     '.cf-viewer::backdrop { background: rgba(0, 0, 0, 0.7); }\n'
     '.cf-viewer-stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; cursor: grab; touch-action: none; }\n'
     '.cf-viewer-stage img { display: block; max-width: 100%; max-height: 100%; min-width: 0; min-height: 0; object-fit: contain; transform-origin: center; user-select: none; }\n'
     '.cf-viewer-bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); }\n'
     '.cf-viewer-bar b { flex: 1; font-weight: 600; }\n'
     '.cf-viewer-stage { position: relative; }\n'
     '.cf-viewer-stage.annotating { cursor: crosshair; }\n'
     '.cf-annot-layer { position: absolute; }\n'
     '.cf-annot-box { position: absolute; border: 2px solid var(--tungsten); background: rgba(255, 255, 255, 0.06); border-radius: 2px; }\n'
     '.cf-annot-box[data-n]::before { content: attr(data-n); position: absolute; top: -22px; left: -2px; padding: 1px 6px; font-size: 12px; font-weight: 600; color: var(--room); background: var(--tungsten); border-radius: 4px; }\n'
     '.cf-annot-list { display: grid; gap: 6px; padding: 0 14px; }\n'
     '.cf-annot-list:not(:empty) { padding-top: 10px; }\n'
     '.cf-annot-row { display: flex; align-items: center; gap: 8px; }\n'
     '.cf-annot-row input { flex: 1; min-width: 0; max-width: 640px; padding: 6px 10px; color: var(--text); background: var(--room); border: 1px solid var(--line); border-radius: var(--radius); }\n'
     '.cf-annot-row > b { flex: none; width: 22px; text-align: center; color: var(--tungsten); }\n'
     '.cf-annot-row > button { flex: none; }\n'
     '.cf-notes-render { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; }\n'
     '.cf-notes-render span { flex: 1; min-width: 0; font-weight: 600; }\n'
     '.cf-annot-layer { overflow: visible; }\n'
     '.cf-annot-note { position: absolute; z-index: 1; display: flex; align-items: center; gap: 6px; width: min(340px, 90%); margin: 8px 0; cursor: auto; }\n'
     '.cf-annot-note input { flex: 1; min-width: 0; padding: 8px 14px; color: var(--text); background: rgba(20, 22, 26, 0.92); border: 1px solid var(--line); border-radius: 999px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4); }\n'
     '.cf-annot-note input:focus { border-color: var(--tungsten); outline: none; }\n'
     '.cf-annot-remove { flex: none; width: 28px; height: 28px; padding: 0; border-radius: 50%; background: rgba(20, 22, 26, 0.92); }\n'
     '.cf-annot-box[data-n]::before { border-radius: 999px; min-width: 20px; text-align: center; }\n'
     '.cf-annot-box.note-above[data-n]::before { top: auto; bottom: -22px; }\n'
     '.cf-viewer { position: relative; }\n'
     '.cf-viewer-close { position: absolute; top: 10px; right: 10px; width: 34px; height: 34px; padding: 0; font-size: 20px; line-height: 1; border-radius: 50%; background: rgba(0, 0, 0, 0.55); z-index: 2; }\n'
     '.cf-viewer-stage img { max-width: none; max-height: none; }\n'
     '.person:hover .cf-tile-open, .cf-tile-open:focus-visible { opacity: 1; display: grid; place-items: center; }\n'
     '.person > .cf-tile-open { position: absolute; top: 4px; left: 4px; right: auto; width: 22px; height: 22px; padding: 0; font-size: 13px; line-height: 1; }\n'
     '.cf-tile-open:hover { background: var(--tungsten); color: var(--room); }\n'),
]
