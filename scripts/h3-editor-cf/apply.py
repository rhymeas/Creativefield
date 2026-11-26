"""Applies CreativeField's additions to an installed H3 Editor. Idempotent; refuses when the upstream text has moved.

    python scripts/h3-editor-cf/apply.py <editor folder>      (the worker's custom_nodes/comfyui-h3-editor)

Copies the cf_*.py modules beside the editor and adds small hooks to its Python files. Each hook is a literal
replacement of upstream text; a hook already present is skipped, and upstream text that no longer matches stops
the run with the name of the hook, so an editor update never gets a half-applied patch.
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MARK = "CreativeField:"     # "# CreativeField: ..." in Python, "// CreativeField: ..." in JavaScript

# (file, name, upstream text, replacement). The replacement carries MARK so a second run sees it.
# Earlier versions of a hook's marked line, swapped for the current one on an editor that already has them.
UPGRADES = {
    "grain": ["    video = cf_grade.finish_video(project, chains, video)  # CreativeField: grain\n"],
    # The standard draft samples at 1024 and is refined to 1472x832. A straight 1024 render (63 s instead of 100 s,
    # A/B 2026-11-25) was tried and turned down by the user: the sharper refined draft is worth the seconds. Editors
    # carrying either earlier form get the current one.
    "standard draft size": ['    if name == cf_studio.STANDARD:  # CreativeField: standard draft, sampled at about 1024 px and refined\n'
                            '        return cf_studio.STANDARD_SIZES[shape][0] + (True,)\n',
                            '    if name == cf_studio.STANDARD: return cf_studio.STANDARD_SIZES[shape][0] + (False,)  # CreativeField: standard draft, drawn straight at about 1024 px\n'],
    # Encode reuse went from Standard drafts to every refined render (finals 244 -> 204 s, same look; user 2026-11-26).
    # Finals still redraw 3 steps from 0.675 (profile refine_from 3). A 2-step redraw from 0.385 (SplitSigmas step 4)
    # saves 10-30 s and matches on still shots, but on a walking shot the moving face turned harder (LATER-2619,
    # 2026-11-26); the 1-step redraw from 0.42 came out darker. Keep 3.
    "standard draft reuses its encode": ['        if quality == "draft":  # CreativeField: a take that holds nothing redraws on its first encode\n'
                                         '            cf_studio.reuse_first_encode(graph)\n'],
    "standard draft hint": ['    + (table.draft.some((row) => row.id === "standard") ? " Standard drafts are sampled at about 1024 px and redrawn larger, like the app\'s video route; Small and Medium are quicker previews." : "")  // CreativeField: standard draft\n',
                            '    + (table.draft.some((row) => row.id === "standard") ? " Standard drafts are drawn at about 1024 px, where faces, eyes and lettering hold; Small and Medium are quicker previews." : "")  // CreativeField: standard draft (1024 straight)\n'],
}

HOOKS = [
    ("project.py", "import cf_studio",
     "    from .prompting import compose_prompt, compose_reference_prompt\nexcept ImportError:\n"
     "    import holds\n    import patches as patching\n    from prompting import compose_prompt, compose_reference_prompt\n",
     "    from .prompting import compose_prompt, compose_reference_prompt\n    from . import cf_studio  # CreativeField: sound fades\n"
     "except ImportError:\n    import holds\n    import patches as patching\n    from prompting import compose_prompt, compose_reference_prompt\n"
     "    import cf_studio  # CreativeField: sound fades\n"),
    ("project.py", "sound fields",
     'SOUND_FIELDS = ("name", "start", "offset", "frames", "gain", "lane")\n',
     'SOUND_FIELDS = ("name", "start", "offset", "frames", "gain", "lane") + cf_studio.FADE_FIELDS  # CreativeField: fades\n'),
    ("project.py", "clean fades",
     '        out["frames"] = int(frames)\n    return out\n\n\ndef fit_sound',
     '        out["frames"] = int(frames)\n    out.update(cf_studio.clean_fades(fields, seconds))  # CreativeField: fades\n    return out\n\n\ndef fit_sound'),
    ("project.py", "export fades",
     'volume=%.3f,%s,adelay=%d:all=1[s%s]" % (\n            number, offset, offset + row["frames"] / float(FPS), float(row.get("gain", 1.0)), SOUND_FORMAT,',
     'volume=%.3f%s,%s,adelay=%d:all=1[s%s]" % (  # CreativeField: fades\n            number, offset, offset + row["frames"] / float(FPS), float(row.get("gain", 1.0)),\n'
     '            cf_studio.fade_chain(row, FPS), SOUND_FORMAT,'),
    ("project.py", "summary fades",
     '               "offset": s.get("offset", 0.0), "gain": s.get("gain", 1.0)}\n',
     '               "offset": s.get("offset", 0.0), "gain": s.get("gain", 1.0), **cf_studio.fade_summary(s)}  # CreativeField: fades\n'),
    # Grading: project look, clip corrections, match LUTs, grain (cf_grade.py, cf_api.py).
    ("project.py", "import cf_grade",
     "    from . import cf_studio  # CreativeField: sound fades\n",
     "    from . import cf_studio  # CreativeField: sound fades\n    from . import cf_grade  # CreativeField: grading\n"),
    ("project.py", "import cf_grade (flat)",
     "    import cf_studio  # CreativeField: sound fades\n",
     "    import cf_studio  # CreativeField: sound fades\n    import cf_grade  # CreativeField: grading\n"),
    ("project.py", "grade ops",
     '    else:\n        raise ValueError("unknown op %s" % kind)\n    if op.get("as"):',
     '    elif kind in cf_grade.OPS:  # CreativeField: grading\n        result = cf_grade.apply_op(project, op, lambda value, what: _resolve(value, names, what))\n'
     '    else:\n        raise ValueError("unknown op %s" % kind)\n    if op.get("as"):'),
    ("project.py", "grade per clip",
     'setpts=(PTS-STARTPTS)/%.5f,%s[v%s]" % (index, first, last, speed, finish, index))',
     'setpts=(PTS-STARTPTS)/%.5f%s,%s[v%s]" % (index, first, last, speed,  # CreativeField: grading\n'
     '                                                                              cf_grade.item_filters(project, clips[item["clip"]]), finish, index))'),
    ("project.py", "grain",
     '    args += ["-filter_complex", ";".join(chains), "-map", "[%s]" % video,',
     '    video = cf_grade.finish_video(project, chains, video, width, height)  # CreativeField: grain (sized)\n'
     '    args += ["-filter_complex", ";".join(chains), "-map", "[%s]" % video,'),
    ("editor_api.py", "routes",
     '    ("POST", "/h3take/api/sheet", "sheet"),\n)\n',
     '    ("POST", "/h3take/api/sheet", "sheet"),\n)\n'
     'from . import cf_api  # CreativeField: LUT upload, match grade, NLE export\n'
     'ROUTES = ROUTES + cf_api.ROUTES\n'
     'for _cf_handler in cf_api.HANDLERS:\n    globals()[_cf_handler] = getattr(cf_api, _cf_handler)\n'),
    # The sound panel gets fade in / fade out sliders, and the preview plays the fades.
    ("editor/editor.js", "fade sliders",
     "    lane,\n    hint,\n  ]));\n}\n",
     '    ...["fade_in", "fade_out"].flatMap((key) => {  // CreativeField: fades\n'
     '      const title = document.createElement("label");\n'
     '      title.className = "field";\n'
     '      const text = document.createElement("span");\n'
     '      text.textContent = key === "fade_in" ? "Fade in, seconds" : "Fade out, seconds";\n'
     '      title.append(text);\n'
     '      return [title, strengthSlider("Sound " + key, sound.name + (key === "fade_in" ? " fade in" : " fade out"),\n'
     '        typeof sound[key] === "number" ? sound[key] : 0, [0, Math.min(10, sound.frames / FPS)], 0, (v) => (live()[key] = v))];\n'
     '    }),\n'
     "    lane,\n    hint,\n  ]));\n}\n"),
    # Bridges (user 2026-11-25): a new bridge goes from the previous clip's last frames into the next clip's first
    # frame (arrive "pin"), and starts with a description so Render draft / final work at once. Imported footage
    # cannot render: its Render items are greyed with the reason instead of failing on click.
    ("editor/editor.js", "bridge helpers",
     "function addLinked(mode, arrive = \"short\") {\n",
     "// CreativeField: a new bridge says what it does, so it renders at once; footage cannot render at all.\n"
     "function cfBridgeAction(mode, source, next) {\n"
     "  if (mode !== \"bridge\" || !next) return \"\";\n"
     "  const target = clipOf(next.clip);\n"
     "  const from = String(source.action || \"\").trim(), to = String(target?.action || \"\").trim();\n"
     "  return \"One continuous shot that moves naturally from the last frame of \" + source.name + \" into the first frame of \" +\n"
     "    (target?.name || \"the next clip\") + \".\" + (from && to ? \" It begins: \" + from.slice(0, 300) + \" It ends: \" + to.slice(0, 300) : \"\");\n"
     "}\n"
     "const cfRenderOff = (clip, busy) => busy ? clip.name + \" is rendering\" : clip.kind === \"footage\" ? \"Imported footage does not render: bridge or extend it\" : \"\";\n"
     "function addLinked(mode, arrive = \"pin\") {  // CreativeField: bridges arrive on the next clip's first frame\n"),
    ("editor/editor.js", "bridge action",
     "    id: uid(\"c\"), name: titles[mode] + source.name, action: \"\", camera: \"\", speaker: \"\", dialogue: \"\",\n",
     "    id: uid(\"c\"), name: titles[mode] + source.name, action: cfBridgeAction(mode, source, next), camera: \"\", speaker: \"\", dialogue: \"\",  // CreativeField: bridge text\n"),
    ("editor/editor.js", "render off in item menu",
     "  const inside = state.playhead > item.start && state.playhead < itemEnd(item);\n  return [\n"
     "    act(\"Render draft\", () => renderClip(clip, \"draft\"), { off: busy ? clip.name + \" is rendering\" : \"\" }),\n"
     "    act(\"Render final\", () => renderClip(clip, \"final\"), { off: busy ? clip.name + \" is rendering\" : \"\" }),\n",
     "  const inside = state.playhead > item.start && state.playhead < itemEnd(item);\n  return [\n"
     "    act(\"Render draft\", () => renderClip(clip, \"draft\"), { off: cfRenderOff(clip, busy) }),  // CreativeField: footage\n"
     "    act(\"Render final\", () => renderClip(clip, \"final\"), { off: cfRenderOff(clip, busy) }),\n"),
    ("editor/editor.js", "render off in clip menu",
     "function clipActions(clip) {\n  const busy = Boolean(jobFor(clip.id));\n  return [\n"
     "    act(\"Render draft\", () => renderClip(clip, \"draft\"), { off: busy ? clip.name + \" is rendering\" : \"\" }),\n"
     "    act(\"Render final\", () => renderClip(clip, \"final\"), { off: busy ? clip.name + \" is rendering\" : \"\" }),\n",
     "function clipActions(clip) {\n  const busy = Boolean(jobFor(clip.id));\n  return [\n"
     "    act(\"Render draft\", () => renderClip(clip, \"draft\"), { off: cfRenderOff(clip, busy) }),  // CreativeField: footage (clip menu)\n"
     "    act(\"Render final\", () => renderClip(clip, \"final\"), { off: cfRenderOff(clip, busy) }),\n"),
    ("project.py", "bridge default arrival",
     '    if mode == "bridge" and arrive == "pin":\n        link["arrive"] = "pin"\n',
     '    if mode == "bridge" and arrive in ("pin", None, ""):  # CreativeField: a bridge lands on the next clip\'s first frame\n        link["arrive"] = "pin"\n'),
    ("project.py", "bridge default action",
     '    default = "One continuous shot that moves naturally from the opening frames into the closing frames." if mode == "merge" else ""\n',
     '    default = "One continuous shot that moves naturally from the opening frames into the closing frames." if mode == "merge" else ""\n'
     '    if mode == "bridge" and nxt:  # CreativeField: a bridge says what it does, so it renders at once\n'
     '        default = "One continuous shot that moves naturally from the last frame of %s into the first frame of %s." % (\n'
     '            source["name"], find_clip(project, nxt["clip"])["name"])\n'),
    # Reference kinds (user 2026-11-25; cf_refs.py): a cast member is a person, an item, a location, a style (look and
    # light) or an outfit. A clip with any kind but person gets cf_refs' prompt; a clip of people keeps the editor's.
    ("prompting.py", "reference kinds prompt",
     "    subjects = list(subjects)\n    picture = 0\n",
     "    subjects = list(subjects)\n"
     "    if any((s.get(\"kind\") or \"person\") != \"person\" for s in subjects):  # CreativeField: reference kinds\n"
     "        try:\n            from . import cf_refs\n        except ImportError:\n            import cf_refs\n"
     "        return cf_refs.compose_reference_prompt(style, action, subjects, first_frame, last_frame, camera, speaker,\n"
     "                                                dialogue, sound, music, language, voice)\n"
     "    picture = 0\n"),
    ("project.py", "import cf_refs",
     "    from . import cf_grade  # CreativeField: grading\n",
     "    from . import cf_grade  # CreativeField: grading\n    from . import cf_refs  # CreativeField: reference kinds\n"),
    ("project.py", "import cf_refs (flat)",
     "    import cf_grade  # CreativeField: grading\n",
     "    import cf_grade  # CreativeField: grading\n    import cf_refs  # CreativeField: reference kinds\n"),
    ("project.py", "cast kind field",
     'CAST_FIELDS = ("name", "description", "voice", "pictures", "refmod")\n',
     'CAST_FIELDS = ("name", "description", "voice", "pictures", "refmod", "kind")  # CreativeField: reference kinds\n'),
    ("project.py", "cast kind on add",
     '              "description": str(fields.get("description") or "")}\n    if asset:\n',
     '              "description": str(fields.get("description") or "")}\n'
     '    person["kind"] = cf_refs.clean_kind(fields.get("kind"))  # CreativeField: reference kinds\n    if asset:\n'),
    ("project.py", "cast kind on update",
     '        if key == "pictures":\n            person["pictures"] = clean_pictures(value or [], person)\n            continue\n',
     '        if key == "kind":  # CreativeField: reference kinds\n            person["kind"] = cf_refs.clean_kind(value)\n            continue\n'
     '        if key == "pictures":\n            person["pictures"] = clean_pictures(value or [], person)\n            continue\n'),
    ("project.py", "cast kind in catalog",
     'CATALOG_KEEP = ("name", "description", "file", "subfolder", "pictures", "voice", "refmod")\n',
     'CATALOG_KEEP = ("name", "description", "file", "subfolder", "pictures", "voice", "refmod", "kind")  # CreativeField: reference kinds\n'),
    ("project.py", "cast kind in summary",
     '        "cast": [{"id": p["id"], "name": p["name"], "description": p.get("description", ""),\n',
     '        "cast": [{"id": p["id"], "name": p["name"], "description": p.get("description", ""), "kind": cf_refs.kind_of(p),  # CreativeField: reference kinds\n'),
    ("editor/editor.js", "cast kind in catalog",
     'const CATALOG_KEEP = ["name", "description", "file", "subfolder", "pictures", "voice", "refmod"];\n',
     'const CATALOG_KEEP = ["name", "description", "file", "subfolder", "pictures", "voice", "refmod", "kind"];  // CreativeField: reference kinds\n'),
    ("editor/editor.js", "cast kind choice",
     '      person.file || person.refmod\n        ? field("What they look like", person.description, (v) => (person.description = v), { big: true })\n',
     '      ...(person.file ? [choice("Used as", [["person", "Person"], ["item", "Prop or item"], ["location", "Location"],  // CreativeField: reference kinds\n'
     '        ["style", "Look and light"], ["outfit", "Outfit"]], person.kind || "person", (v) => { person.kind = v; renderCast(); })] : []),\n'
     '      person.file || person.refmod\n        ? field(person.kind && person.kind !== "person" ? "What it shows" : "What they look like", person.description, (v) => (person.description = v), { big: true })\n'),
    # 2K finals: the editor asks for the bf16 latent upscaler and skipped the refine when the install holds the same
    # model as fp16, so finals stayed at 1344x768 (found 2026-11-25). Either copy is used now.
    ("project.py", "latent upscaler in status",
     '    if not installed(MODELS["latent_upscaler"], available):\n',
     '    if not cf_studio.latent_upscaler(MODELS["latent_upscaler"], available):  # CreativeField: bf16 or fp16 upscaler\n'),
    ("project.py", "latent upscaler in refine",
     '    if size.get("refine") and models.get("latent_upscaler") and installed(models["latent_upscaler"], available):\n'
     '        # Without the latent upscaler a final stays at H3\'s own size.\n'
     '        tail = profile.get("refine_sigmas") or profile["refine_from"]\n'
     '        add_refine(graph, refine_size(project), tail, models["latent_upscaler"])\n',
     '    upscaler = cf_studio.latent_upscaler(models.get("latent_upscaler"), available)  # CreativeField: bf16 or fp16 upscaler\n'
     '    if size.get("refine") and upscaler:\n'
     '        # Without the latent upscaler a final stays at H3\'s own size.\n'
     '        tail = profile.get("refine_sigmas") or profile["refine_from"]\n'
     '        add_refine(graph, refine_size(project), tail, upscaler)\n'),
    # RefPacks (user 2026-11-25; cf_refpacks.py): a blind benchmark picked BExplains H3 RefPacks in 10 of 12 cuts.
    # A clip RefPacks can carry (pictures with a role, no pinned frame, link, voice, dialogue, music or track)
    # renders through it; every other clip keeps H3 Take.
    ("project.py", "import cf_refpacks",
     "    from . import cf_refs  # CreativeField: reference kinds\n",
     "    from . import cf_refs  # CreativeField: reference kinds\n    from . import cf_refpacks  # CreativeField: RefPacks\n"),
    ("project.py", "import cf_refpacks (flat)",
     "    import cf_refs  # CreativeField: reference kinds\n",
     "    import cf_refs  # CreativeField: reference kinds\n    import cf_refpacks  # CreativeField: RefPacks\n"),
    ("project.py", "refpacks route",
     '            graph[key]["inputs"]["conditioning"] = [node, 0]\n    return graph\n\n\ndef add_refine',
     '            graph[key]["inputs"]["conditioning"] = [node, 0]\n'
     '    return cf_refpacks.route(graph, project, clip, sys.modules[__name__])  # CreativeField: RefPacks\n\n\ndef add_refine'),
    ("project.py", "import sys",
     "import re\nimport time\nimport uuid\n",
     "import re\nimport sys  # CreativeField: RefPacks route needs this module\nimport time\nimport uuid\n"),
    ("editor/editor.js", "fade preview",
     "    player.volume = Math.min(1, sound.gain);\n",
     "    const fadeIn = sound.fade_in || 0, fadeOut = sound.fade_out || 0, playing = sound.frames / FPS;  // CreativeField: fades\n"
     "    player.volume = Math.min(1, sound.gain) * Math.max(0, Math.min(1, fadeIn > 0 ? at / fadeIn : 1, fadeOut > 0 ? (playing - at) / fadeOut : 1));\n"),
    # Film Studio editor fixes (user, 2026-11-25): the clip status without "of N", one short Project line with the
    # resolution, preview volume and mute, Replace with the latest draft or final take, the export's loader, success
    # and Open folder (cf_api.open_exports), and the mouse wheel filling the viewer (theme: .screen.cf-fill).
    ("editor/editor.js", "clip status without of N",
     '  return { kind: "", text: clip.takes.length > 1 ? quality + ", take " + (clip.takes.indexOf(take) + 1) + " of " + clip.takes.length : quality };\n',
     '  return { kind: "", text: clip.takes.length > 1 ? quality + ", take " + (clip.takes.indexOf(take) + 1) : quality };  // CreativeField: no "of N"\n'),
    ("editor/editor.js", "final size helper",
     '\nfunction renderScene(panel, selected = false) {\n',
     '\n// CreativeField: the final size, "1920 × 1088", for the one line under Project.\n'
     'function cfFinalSize() {\n'
     '  const table = state.sizes?.[state.project.format || "16:9"];\n'
     '  const chosen = state.project.sizes?.final;\n'
     '  const own = typeof chosen === "string" ? /^(\\d+)x(\\d+)$/.exec(chosen) : null;\n'
     '  if (own) return own[1] + " × " + own[2];\n'
     '  const row = table?.final?.find((r) => r.id === chosen) || table?.final?.[0];\n'
     '  return row ? row.out[0] + " × " + row.out[1] : "";\n'
     '}\n\n'
     'function renderScene(panel, selected = false) {\n'),
    ("editor/editor.js", "short project line",
     '    clips ? rendered + " of " + clips + " rendered" : "",\n'
     '    cast ? (cast === 1 ? "1 in the cast" : cast + " in the cast") : "",\n'
     '  ].filter(Boolean).join(", ");\n'
     '  const about = document.createElement("p");\n'
     '  about.className = "status";\n'
     '  about.textContent = selected ? "Settings for every clip in this project." : "Select a clip to edit it. Press ? for shortcuts.";\n'
     '  head.append(title, line, about);\n',
     '    cfFinalSize(),  // CreativeField: one short line with the resolution, no wall of text\n'
     '  ].filter(Boolean).join(" · ");\n'
     '  head.append(title, line);\n'),
    ("editor/editor.js", "preview volume level",
     '// Seconds the next clip runs, silent, before its cut.\nconst PREROLL = 0.4;\n',
     '// CreativeField: preview volume and mute from the timeline bar; the export keeps its own levels.\n'
     'var cfLevel = 1;\n'
     'function cfReadVolume() {\n'
     '  try {\n'
     '    const level = Number(localStorage.getItem("h3take.cf.volume") ?? 1);\n'
     '    cfLevel = localStorage.getItem("h3take.cf.muted") === "yes" ? 0 : Math.max(0, Math.min(1, Number.isFinite(level) ? level : 1));\n'
     '  } catch (_) { cfLevel = 1; }\n'
     '}\n'
     'cfReadVolume();\n\n'
     '// Seconds the next clip runs, silent, before its cut.\nconst PREROLL = 0.4;\n'),
    ("editor/editor.js", "preview volume clear",
     '    video.volume = 1;\n    video.muted = false;\n',
     '    video.volume = cfLevel;  // CreativeField: preview volume\n    video.muted = false;\n'),
    ("editor/editor.js", "preview volume mix",
     '  front.volume = 1 - progress;\n  back.volume = progress;\n',
     '  front.volume = (1 - progress) * cfLevel;  // CreativeField: preview volume\n  back.volume = progress * cfLevel;\n'),
    ("editor/editor.js", "preview volume sounds",
     '    player.volume = Math.min(1, sound.gain) * Math.max(0, Math.min(1, fadeIn > 0 ? at / fadeIn : 1, fadeOut > 0 ? (playing - at) / fadeOut : 1));\n',
     '    player.volume = cfLevel * Math.min(1, sound.gain) * Math.max(0, Math.min(1, fadeIn > 0 ? at / fadeIn : 1, fadeOut > 0 ? (playing - at) / fadeOut : 1));  // CreativeField: preview volume\n'),
    ("editor/editor.js", "replace take helper",
     '\nfunction itemActions(item) {\n',
     '\n// CreativeField: right-click a clip on the timeline to swap it to its latest draft or final take.\n'
     'function cfReplaceRows(clip) {\n'
     '  const current = activeTake(clip);\n'
     '  const latest = (final) => [...clip.takes].reverse().find((t) => (t.quality === "final") === final);\n'
     '  return [["draft", false], ["final", true]].map(([word, final]) => {\n'
     '    const take = latest(final);\n'
     '    return act("Replace with the latest " + word, () => chooseTake(clip, take),\n'
     '      { off: !take ? "There is no " + word + " take yet" : take === current ? "It already shows the latest " + word : "" });\n'
     '  });\n'
     '}\n\n'
     'function itemActions(item) {\n'),
    ("editor/editor.js", "replace take rows",
     '    act("Show its takes", () => { state.tab = "takes"; renderAll(); }, { off: clip.takes.length ? "" : "Not rendered yet" }),\n',
     '    act("Show its takes", () => { state.tab = "takes"; renderAll(); }, { off: clip.takes.length ? "" : "Not rendered yet" }),\n'
     '    ...cfReplaceRows(clip),  // CreativeField: replace with the latest draft or final take\n'),
    ("editor/editor.js", "export opens idle",
     '  result.classList.remove("bad");\n  $("exporterLink").hidden = true;\n',
     '  result.classList.remove("bad");\n'
     '  delete result.dataset.state;  // CreativeField: the export dialog opens idle, Open folder hidden\n'
     '  if ($("cfOpenFolder")) $("cfOpenFolder").hidden = true;\n'
     '  $("exporterLink").hidden = true;\n'),
    ("editor/editor.js", "export busy",
     '  result.textContent = "Joining the clips. A long cut can take a minute or two.";\n',
     '  result.textContent = "Joining the clips. A long cut can take a minute or two.";\n'
     '  result.dataset.state = "busy";  // CreativeField: a loader while it exports\n'
     '  if ($("cfOpenFolder")) $("cfOpenFolder").hidden = true;\n'),
    ("editor/editor.js", "export done",
     '    result.textContent = "Saved " + made.filename + ", " + megabytes(made.bytes) + ", in " + made.subfolder + " of ComfyUI\'s output folder.";\n',
     '    result.textContent = "Exported " + made.filename + ", " + megabytes(made.bytes) + ".";  // CreativeField: success, with Open folder\n'
     '    result.title = made.subfolder + " in ComfyUI\'s output folder";\n'
     '    result.dataset.state = "done";\n'
     '    if ($("cfOpenFolder")) $("cfOpenFolder").hidden = false;\n'),
    ("editor/editor.js", "export failed",
     '    result.classList.add("bad");\n    result.textContent = error.message;\n  }\n  go.disabled = false;\n  go.textContent = "Export again";\n',
     '    result.classList.add("bad");\n'
     '    result.dataset.state = "bad";  // CreativeField: the loader stops on a failure\n'
     '    result.textContent = error.message;\n  }\n  go.disabled = false;\n  go.textContent = "Export again";\n'),
    ("editor/editor.js", "studio controls",
     '$("exporterGo").addEventListener("click", runExport);\n',
     '$("exporterGo").addEventListener("click", runExport);\n'
     '// CreativeField: Open folder in the export dialog, preview volume and mute after Zoom, the wheel fills the viewer.\n'
     'function cfStudioControls() {\n'
     '  const foot = document.querySelector("#exporter .exporter-foot");\n'
     '  if (foot && !$("cfOpenFolder")) {\n'
     '    const open = document.createElement("button");\n'
     '    open.id = "cfOpenFolder";\n'
     '    open.type = "button";\n'
     '    open.className = "quiet";\n'
     '    open.textContent = "Open folder";\n'
     '    open.title = "Open the project\'s exports folder on this computer";\n'
     '    open.hidden = true;\n'
     '    open.addEventListener("click", async () => {\n'
     '      open.disabled = true;\n'
     '      try { await postJson("/project/" + state.folder + "/open_exports", {}); } catch (error) { toast(error.message, true); }\n'
     '      open.disabled = false;\n'
     '    });\n'
     '    foot.insertBefore(open, foot.querySelector(".spacer"));\n'
     '  }\n'
     '  const zoom = $("zoom")?.closest("label");\n'
     '  if (zoom && !$("cfVolume")) {\n'
     '    const read = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; } };\n'
     '    const write = (key, value) => { try { localStorage.setItem(key, value); } catch (_) {} };\n'
     '    const mute = document.createElement("button");\n'
     '    mute.type = "button";\n'
     '    mute.className = "quiet";\n'
     '    const level = document.createElement("input");\n'
     '    level.id = "cfVolume";\n'
     '    level.type = "range";\n'
     '    level.min = "0";\n'
     '    level.max = "1";\n'
     '    level.step = "0.05";\n'
     '    level.value = read("h3take.cf.volume", "1");\n'
     '    const label = document.createElement("label");\n'
     '    label.className = "zoom";\n'
     '    label.append("Volume ", level);\n'
     '    const show = () => {\n'
     '      const muted = read("h3take.cf.muted", "no") === "yes";\n'
     '      mute.textContent = muted ? "Unmute" : "Mute";\n'
     '      mute.setAttribute("aria-pressed", String(muted));\n'
     '      mute.title = muted ? "The preview is silent; the export keeps its sound" : "Silence the preview; the export keeps its sound";\n'
     '    };\n'
     '    const refresh = () => { cfReadVolume(); clearMix(); };\n'
     '    mute.addEventListener("click", () => { write("h3take.cf.muted", read("h3take.cf.muted", "no") === "yes" ? "no" : "yes"); show(); refresh(); });\n'
     '    level.addEventListener("input", () => {\n'
     '      write("h3take.cf.volume", level.value);\n'
     '      if (Number(level.value) > 0 && read("h3take.cf.muted", "no") === "yes") { write("h3take.cf.muted", "no"); show(); }\n'
     '      refresh();\n'
     '    });\n'
     '    show();\n'
     '    zoom.after(mute, label);\n'
     '  }\n'
     '  const screen = $("screen");\n'
     '  if (screen && !screen.dataset.cfWheel) {\n'
     '    screen.dataset.cfWheel = "1";\n'
     '    screen.addEventListener("wheel", (event) => {\n'
     '      if (event.ctrlKey || !state.project) return;\n'
     '      event.preventDefault();\n'
     '      screen.classList.toggle("cf-fill", event.deltaY < 0);\n'
     '    }, { passive: false });\n'
     '  }\n'
     '}\n'
     'cfStudioControls();\n'),
    # A clip's own sound off while the clip stays (user, 2026-11-25): no lock step as in Premiere. The item keeps
    # "muted"; the export gives its audio volume 0, the preview plays it silent and its wave is dimmed. The selected
    # clip also always shows its frames and the picture's size, read from the take's own video.
    ("project.py", "export a clip's sound off",
     '        chains.append("[%s:a]atrim=start=%.5f:end=%.5f,asetpts=PTS-STARTPTS,%s%s[a%s]" % (\n'
     '            index, first / float(FPS), last / float(FPS), tempo + "," if tempo else "", sound, index))\n',
     '        chains.append("[%s:a]atrim=start=%.5f:end=%.5f,asetpts=PTS-STARTPTS,%s%s%s[a%s]" % (  # CreativeField: a clip\'s sound removed\n'
     '            index, first / float(FPS), last / float(FPS), tempo + "," if tempo else "", "volume=0," if item.get("muted") else "", sound, index))\n'),
    ("editor/editor.js", "sound toggle and clip facts helpers",
     '\nfunction clipActions(clip) {\n',
     '\n// CreativeField: a clip\'s own sound off or back on, from the right-click menu; the clip and its picture stay.\n'
     'function cfToggleSound(item) {\n'
     '  checkpoint();\n'
     '  if (item.muted) delete item.muted;\n'
     '  else item.muted = true;\n'
     '  save();\n'
     '  renderAll();\n'
     '  toast(item.muted ? "Its sound is off. The clip stays on the timeline." : "Its sound is back.");\n'
     '}\n\n'
     '// The selected clip always says what it is: state, length, frames and the picture\'s size (from its video).\n'
     'function cfClipFacts(clip, line) {\n'
     '  const take = activeTake(clip);\n'
     '  if (!take) return;\n'
     '  const sizes = cfClipFacts.sizes || (cfClipFacts.sizes = new Map());\n'
     '  const base = line.textContent + (take.frames ? ", " + take.frames + " frames" : "");\n'
     '  line.textContent = base;\n'
     '  if (sizes.has(take.id)) { line.textContent = base + ", " + sizes.get(take.id); return; }\n'
     '  const probe = document.createElement("video");\n'
     '  probe.preload = "metadata";\n'
     '  probe.muted = true;\n'
     '  probe.addEventListener("loadedmetadata", () => {\n'
     '    if (probe.videoWidth) {\n'
     '      sizes.set(take.id, probe.videoWidth + " × " + probe.videoHeight);\n'
     '      if (line.isConnected && line.textContent === base) line.textContent = base + ", " + sizes.get(take.id);\n'
     '    }\n'
     '    probe.removeAttribute("src");\n'
     '    probe.load();\n'
     '  }, { once: true });\n'
     '  probe.src = viewUrl(take.file, take.subfolder);\n'
     '}\n\n'
     'function clipActions(clip) {\n'),
    ("editor/editor.js", "sound toggle row",
     '    act("Remove from the timeline", removeSelected, { key: "Delete" }),\n',
     '    act(item.muted ? "Restore its sound" : "Remove its sound", () => cfToggleSound(item)),  // CreativeField: the clip stays\n'
     '    act("Remove from the timeline", removeSelected, { key: "Delete" }),\n'),
    ("editor/editor.js", "sound wave menu",
     '  const row = target.closest("#clips .clip[data-clip]");\n',
     '  const wave = target.closest("#laneA .wave[data-item]");  // CreativeField: right-click a clip\'s sound\n'
     '  if (wave) {\n'
     '    const item = state.project.timeline.find((i) => i.id === wave.dataset.item);\n'
     '    if (!item) return null;\n'
     '    selectClip(item.clip, item.id);\n'
     '    return { title: clipOf(item.clip).name, rows: [act(item.muted ? "Restore its sound" : "Remove its sound", () => cfToggleSound(item))] };\n'
     '  }\n'
     '  const row = target.closest("#clips .clip[data-clip]");\n'),
    ("editor/editor.js", "sound wave dim",
     '    wave.className = "wave" + (take ? "" : " todo") + (item.id === state.item ? " on" : "");\n',
     '    wave.className = "wave" + (take ? "" : " todo") + (item.id === state.item ? " on" : "") + (item.muted ? " cf-muted" : "");  // CreativeField: sound off\n'),
    ("editor/editor.js", "sound off in preview",
     '  lastTick = now;\n  syncSounds();\n  previewEffect();\n\n  const coming = incoming(state.playhead);\n',
     '  lastTick = now;\n  syncSounds();\n  previewEffect();\n'
     '  front.muted = Boolean(item?.muted);  // CreativeField: a clip whose sound was removed plays silent\n\n'
     '  const coming = incoming(state.playhead);\n'),
    ("editor/editor.js", "sound off on every mix reset",
     '    video.volume = cfLevel;  // CreativeField: preview volume\n    video.muted = false;\n',
     '    video.volume = cfLevel;  // CreativeField: preview volume\n'
     '    video.muted = video === front && Boolean(leading(state.playhead)?.muted);  // CreativeField: no blip from a clip whose sound was removed\n'),
    # Standard draft (, user go 2026-11-25): the usual Film Studio draft takes the app's video route,
    # sampled at about 1024 px with the final's steps, then the latent upscaler and a redraw from sigma 0.42
    # (cf_studio.STANDARD_*). Small and medium stay as quick previews; finals are unchanged.
    ("project.py", "standard draft choice",
     'SIZE_CHOICES = {"draft": ("small", "medium"), "final": ("full", "sharp", "large", "medium", "small")}\n',
     'SIZE_CHOICES = {"draft": (cf_studio.STANDARD, "small", "medium"), "final": ("full", "sharp", "large", "medium", "small")}  # CreativeField: standard draft first\n'),
    ("project.py", "standard draft size",
     '    if name == SHARP:\n        return FORMATS[shape]["final"] + (False,)\n',
     '    if name == SHARP:\n        return FORMATS[shape]["final"] + (False,)\n'
     '    if name == cf_studio.STANDARD: return cf_studio.STANDARD_SIZES[shape][0] + (True,)  # CreativeField: standard draft, sampled at 1024 px, refined to 1472x832\n'),
    ("project.py", "standard draft out size",
     '                             "out": list(FORMATS[shape]["refine"] if refined or name == SHARP else (width, height))})\n',
     '                             "out": list(cf_studio.STANDARD_SIZES[shape][1] if name == cf_studio.STANDARD  # CreativeField: standard draft\n'
     '                                         else FORMATS[shape]["refine"] if refined or name == SHARP else (width, height))})\n'),
    ("project.py", "standard draft refine and steps",
     '    if not enlarged:\n        # The project asked for finals at the size they are sampled at.\n        size.pop("refine", None)\n',
     '    if not enlarged:\n        # The project asked for finals at the size they are sampled at.\n        size.pop("refine", None)\n'
     '    elif quality == "draft":  # CreativeField: a standard draft is refined and takes the final\'s steps (app route)\n'
     '        size.update(refine=True, steps=profile["steps"]["final"])\n'),
    ("project.py", "standard draft refine target",
     '        tail = profile.get("refine_sigmas") or profile["refine_from"]\n        add_refine(graph, refine_size(project), tail, upscaler)\n',
     '        tail = profile.get("refine_sigmas") or profile["refine_from"]\n'
     '        target = refine_size(project)\n'
     '        if quality == "draft":  # CreativeField: standard draft, the app\'s finish (latent upscale, redraw from 0.42)\n'
     '            tail, target = cf_studio.STANDARD_TAIL, cf_studio.standard_out(project)\n'
     '        add_refine(graph, target, tail, upscaler)\n'),
    ("project.py", "standard draft reuses its encode",
     '            tail, target = cf_studio.STANDARD_TAIL, cf_studio.standard_out(project)\n'
     '        add_refine(graph, target, tail, upscaler)\n',
     '            tail, target = cf_studio.STANDARD_TAIL, cf_studio.standard_out(project)\n'
     '        add_refine(graph, target, tail, upscaler)\n'
     '        cf_studio.reuse_first_encode(graph)  # CreativeField: a take that holds nothing redraws on its first encode (drafts, finals 2026-11-26)\n'),
    ("editor/editor.js", "standard draft name",
     '  const names = { small: "Small", medium: "Medium", large: "Large", full: "Full", sharp: "Sharp" };\n',
     '  const names = { standard: "Standard", small: "Small", medium: "Medium", large: "Large", full: "Full", sharp: "Sharp" };  // CreativeField: standard draft\n'),
    ("editor/editor.js", "standard draft hint",
     '    + " Steps are set per model, in Models and their settings.";\n',
     '    + (table.draft.some((row) => row.id === "standard") ? " Standard drafts are drawn at about 1024 px and refined to 1472 × 832, so faces, eyes and lettering hold; Small and Medium are quicker previews." : "")  // CreativeField: standard draft (refined)\n'
     '    + " Steps are set per model, in Models and their settings.";\n'),
    # Footage edits as a shot (user, 2026-11-25): any clip, imported ones too, gets a prompt, a cast and Render
    # draft / final. The first render turns it into a shot (op shot_from_footage, cf_studio) that starts on its own
    # first frame on the timeline (grab into "first"); the footage stays as a take to switch back to.
    ("project.py", "shot from footage op",
     '    elif kind == "update_clip":\n        update_clip(project, clip_id, op.get("fields") or {})\n        result = {"clip": clip_id}\n',
     '    elif kind == "shot_from_footage":  # CreativeField: imported footage becomes a shot that renders\n'
     '        result = cf_studio.shot_from_footage(project, clip_id)\n'
     '    elif kind == "update_clip":\n        update_clip(project, clip_id, op.get("fields") or {})\n        result = {"clip": clip_id}\n'),
    ("editor/editor.js", "footage renders",
     'const cfRenderOff = (clip, busy) => busy ? clip.name + " is rendering" : clip.kind === "footage" ? "Imported footage does not render: bridge or extend it" : "";\n',
     'const cfRenderOff = (clip, busy) => busy ? clip.name + " is rendering" : "";  // CreativeField: footage renders too, as a shot (cfShotFromFootage)\n'),
    ("editor/editor.js", "footage render becomes a shot",
     'async function renderClip(clip, quality, detail, upscaler) {\n  if (jobFor(clip.id)) return;\n',
     '// CreativeField: imported footage becomes a shot that renders like any clip. It starts on its own first frame on the\n'
     '// timeline, its prompt and cast are its own, and the footage stays as a take (Takes switches back to it).\n'
     'async function cfShotFromFootage(clip, quality) {\n'
     '  const take = activeTake(clip);\n'
     '  const item = state.project.timeline.find((i) => i.clip === clip.id);\n'
     '  try {\n'
     '    await flush();\n'
     '    checkpoint();\n'
     '    const ops = [{ op: "shot_from_footage", clip: clip.id }];\n'
     '    if (take) {\n'
     '      const frame = Math.max(0, Math.min(take.frames - 1, item ? item.in : 0));\n'
     '      const still = await postJson("/project/" + state.folder + "/grab", { file: take.file, subfolder: take.subfolder, frame });\n'
     '      ops.push({ op: "update_clip", clip: clip.id, fields: { first: still } });\n'
     '    }\n'
     '    await postJson("/project/" + state.folder + "/ops", { ops, client: clientId });\n'
     '    adopt(await api("/project/" + state.folder));\n'
     '    state.tab = "shot";\n'
     '    selectClip(clip.id);\n'
     '    renderAll();\n'
     '    const shot = clipOf(clip.id);\n'
     '    if (quality && shot && String(shot.action || "").trim()) return renderClip(shot, quality);\n'
     '    toast("It is a shot now and starts on its own first frame. Write what happens and add its cast, then render it.");\n'
     '  } catch (error) {\n'
     '    toast(error.message, true);\n'
     '  }\n'
     '}\n\n'
     'async function renderClip(clip, quality, detail, upscaler) {\n'
     '  if (clip.kind === "footage") return cfShotFromFootage(clip, quality);  // CreativeField: footage renders as a shot\n'
     '  if (jobFor(clip.id)) return;\n'),
    ("editor/editor.js", "footage panel edits as a shot",
     '    else parts.push(section("Footage", [about]));\n',
     '    else {  // CreativeField: footage edits as a shot: prompt, cast, Render draft / final\n'
     '      about.textContent = "Imported from " + (take?.source || "a file") + ". It plays as it is until you render it as a shot: "\n'
     '        + "write what happens, add its cast and render a draft or final. It starts on its own first frame, and the footage stays as a take.";\n'
     '      const edit = document.createElement("button");\n'
     '      edit.type = "button";\n'
     '      edit.className = "primary";\n'
     '      edit.textContent = "Edit as a shot";\n'
     '      edit.addEventListener("click", () => cfShotFromFootage(clip, null));\n'
     '      parts.push(section("Footage", [about, edit]));\n'
     '    }\n'),
    ("editor/editor.js", "footage take status",
     '  if (clip.kind === "footage") return { kind: "", text: "Footage" };\n',
     '  if (clip.kind === "footage" || activeTake(clip)?.footage) return { kind: "", text: "Footage" };  // CreativeField: a shot still playing its footage\n'),
    ("editor/editor.js", "clip facts line",
     '  line.textContent = status.text + ", " + clipSeconds(clip);\n',
     '  line.textContent = status.text + ", " + clipSeconds(clip);\n'
     '  cfClipFacts(clip, line);  // CreativeField: frames and the picture\'s size on the selected clip, always\n'),
    # Render status (user, 2026-11-25: "the audio decoder seems slow"): the sound decodes in 0.4 s, but the line
    # kept saying "Decoding the sound" through the enlarge, the full-size redraw and the picture decode after it.
    ("editor/editor.js", "refine stage names",
     'const STAGES = { 10: "Reading the prompt", 15: "Sampling", 16: "Decoding the picture", 17: "Decoding the sound", 18: "Assembling", 19: "Saving" };\n',
     'const STAGES = { 10: "Reading the prompt", 15: "Sampling", 16: "Decoding the picture", 17: "Decoding the sound", 18: "Assembling", 19: "Saving",\n'
     '  80: "Reading the prompt at full size", 82: "Enlarging", 90: "Refining at full size", 91: "Decoding the picture" };  // CreativeField: the refine\'s stages\n'),
    ("editor/editor.js", "refine steps in the status",
     '    if (data.node !== "15") job.max = 0;\n    showFrame();\n'
     '  } else if (type === "progress" && String(data.node) === "15") {\n'
     '    job.step = data.value;\n    job.max = data.max;\n    job.stage = STAGES[15];\n',
     '    if (data.node !== "15" && data.node !== "90") job.max = 0;  // CreativeField: the refine counts its own steps\n'
     '    showFrame();\n'
     '  } else if (type === "progress" && (String(data.node) === "15" || String(data.node) === "90")) {\n'
     '    job.step = data.value;\n    job.max = data.max;\n    job.stage = STAGES[data.node];\n'),
    # No sound before a render (user, 2026-11-25): the same switch as Remove its sound (item.muted), beside the
    # render buttons, so a clip can be set silent before its first take.
    ("editor/editor.js", "no sound before a render",
     '  } else {\n'
     '    for (const [quality, label, style] of [["draft", "Render draft", "quiet"], ["final", "Render final", "primary"]]) {\n',
     '  } else {\n'
     '    const cfItems = state.project.timeline.filter((i) => i.clip === clip.id);  // CreativeField: no sound, set before a render\n'
     '    if (cfItems.length) {\n'
     '      const quiet = document.createElement("label");\n'
     '      quiet.className = "check cf-nosound";\n'
     '      const box = document.createElement("input");\n'
     '      box.type = "checkbox";\n'
     '      box.checked = cfItems.every((i) => i.muted);\n'
     '      box.addEventListener("change", () => {\n'
     '        checkpoint();\n'
     '        for (const i of cfItems) { if (box.checked) i.muted = true; else delete i.muted; }\n'
     '        save();\n'
     '        renderAll();\n'
     '      });\n'
     '      const word = document.createElement("span");\n'
     '      word.textContent = "No sound";\n'
     '      quiet.append(box, word);\n'
     '      actions.append(quiet);\n'
     '    }\n'
     '    for (const [quality, label, style] of [["draft", "Render draft", "quiet"], ["final", "Render final", "primary"]]) {\n'),
]

# The references panel's hooks live in their own file.
sys.path.insert(0, HERE)
from hooks_refs import HOOKS as REFERENCE_HOOKS  # noqa: E402
HOOKS += REFERENCE_HOOKS


def signs():
    """The marked line each hook is recognised by. Two hooks with one sign would hide each other, so it refuses."""
    seen = {}
    for file, hook, old, new in HOOKS:
        sign = next(line for line in new.splitlines() if MARK in line and line not in old.splitlines())
        if (file, sign) in seen:
            raise SystemExit("hooks '%s' and '%s' share the marked line %r; make one unique" % (seen[(file, sign)], hook, sign))
        seen[(file, sign)] = hook
    return seen


def apply(editor):
    signs()
    for name in sorted(os.listdir(HERE)):
        if name.startswith("cf_") and name.endswith(".py"):
            shutil.copyfile(os.path.join(HERE, name), os.path.join(editor, name))
    for name in sorted(os.listdir(os.path.join(HERE, "editor"))):   # the editor's own CreativeField modules
        if name.startswith("cf-") and name.endswith(".js"):
            shutil.copyfile(os.path.join(HERE, "editor", name), os.path.join(editor, "editor", name))
    texts = {}
    for file, hook, old, new in HOOKS:
        path = os.path.join(editor, file)
        text = texts.get(file) or open(path, encoding="utf-8").read()
        # A hook is in when its first marked line is: a later hook may add lines inside an earlier one's text.
        # The sign is the first marked line the hook adds (its anchor may itself be an earlier hook's line).
        sign = next(line for line in new.splitlines() if MARK in line and line not in old.splitlines())
        older = [o for o in UPGRADES.get(hook, []) if o in text]
        if older:
            text = text.replace(older[0], sign + "\n")
            print("  %s: %s upgraded" % (file, hook))
        elif sign in text:
            print("  %s: %s already applied" % (file, hook))
        elif text.count(old) == 1:
            text = text.replace(old, new)
            print("  %s: %s applied" % (file, hook))
        else:
            raise SystemExit("%s: the upstream text for '%s' does not match (found %d times); update scripts/h3-editor-cf/apply.py"
                             % (file, hook, text.count(old)))
        texts[file] = text
    for file, text in texts.items():
        with open(os.path.join(editor, file), "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
    stamp_modules(editor)


def stamp_modules(editor):
    """editor.js imports each CreativeField module with its content hash (./cf-refs.js?v=1a2b3c4d), so a browser
    takes a changed module at once instead of a cached one."""
    import hashlib
    import re
    path = os.path.join(editor, "editor", "editor.js")
    text = open(path, encoding="utf-8").read()

    def stamped(match):
        module = os.path.join(editor, "editor", "cf-%s.js" % match.group(1))
        if not os.path.isfile(module):
            return match.group(0)
        return '"./cf-%s.js?v=%s"' % (match.group(1), hashlib.sha1(open(module, "rb").read()).hexdigest()[:8])
    new = re.sub(r'"\./cf-([\w-]+)\.js(?:\?v=[0-9a-f]+)?"', stamped, text)
    if new != text:
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(new)
    # index.html (served without cache) loads editor.js and editor.css by the editor's version only: add their hashes.
    page = os.path.join(editor, "editor", "index.html")
    html = open(page, encoding="utf-8").read()

    def hashed(match):
        data = open(os.path.join(editor, "editor", match.group(1)), "rb").read()
        return "/h3take/editor-files/%s?v=__VERSION__&cf=%s" % (match.group(1), hashlib.sha1(data).hexdigest()[:8])
    stamped_html = re.sub(r"/h3take/editor-files/(editor\.(?:js|css))\?v=__VERSION__(?:&cf=[0-9a-f]+)?", hashed, html)
    if stamped_html != html:
        with open(page, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(stamped_html)


if __name__ == "__main__":
    if len(sys.argv) != 2 or not os.path.isfile(os.path.join(sys.argv[1], "project.py")):
        raise SystemExit("usage: apply.py <the installed comfyui-h3-editor folder>")
    apply(sys.argv[1])
    print("CreativeField additions applied to", sys.argv[1])
