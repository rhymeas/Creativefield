"""CreativeField routes for the H3 Editor: upload a .cube LUT, and match every clip to a reference shot.

Registered beside the editor's own routes by a hook in editor_api.py (scripts/h3-editor-cf/apply.py).
The editor module is imported when a request comes in, not at load time: editor_api imports this module.
"""
import copy
import json
import os

from aiohttp import web

from . import cf_grade
from . import cf_nle
from . import cf_packs
from . import cf_region

ROUTES = (
    ("POST", "/h3take/api/project/{name}/lut", "upload_lut"),
    ("POST", "/h3take/api/project/{name}/match_grade", "match_grade"),
    ("POST", "/h3take/api/project/{name}/export_nle", "export_nle"),
    ("POST", "/h3take/api/project/{name}/grade_preview", "grade_preview"),
    ("POST", "/h3take/api/project/{name}/open_exports", "open_exports"),
    ("GET", "/h3take/api/ref-packs", "ref_packs"),
    ("POST", "/h3take/api/ref-packs/save", "save_ref_pack"),
    ("POST", "/h3take/api/ref-packs/remove", "remove_ref_pack"),
    ("POST", "/h3take/api/project/{name}/render_notes", "render_notes"),
)
HANDLERS = ("upload_lut", "match_grade", "export_nle", "grade_preview", "open_exports",
            "ref_packs", "save_ref_pack", "remove_ref_pack", "render_notes")
SAMPLES = (0.2, 0.5, 0.8)    # where in each clip's part on the timeline its colours are measured
SAMPLE_WIDTH = 96


def _api():
    from . import editor_api
    return editor_api


async def upload_lut(request):
    """Keep a 3D .cube LUT with the project. Returns the asset, as set_grade's look takes it, and its size."""
    api = _api()
    form = await request.post()
    part = form.get("file")
    if part is None or not hasattr(part, "file"):
        return api.refused("choose a .cube LUT to upload")
    if os.path.splitext(part.filename or "")[1].lower() != ".cube":
        return api.refused("use a 3D LUT in the .cube format")
    text = part.file.read().decode("utf-8", errors="replace")
    try:
        size, _ = cf_grade.read_cube(text)
    except ValueError as error:
        return api.refused(str(error))
    target, asset = api.asset_target(request.match_info["name"], ".cube")
    with open(target, "w", encoding="utf-8") as f:
        f.write(text)
    return web.json_response(dict(asset, size=size, name=os.path.splitext(os.path.basename(part.filename))[0][:60]))


async def _clip_stats(api, store, clip, item):
    """Lab mean and spread of a clip, from three small frames inside the part the timeline shows."""
    take = store.active_take(clip)
    source = api.output_path(take.get("subfolder"), take["file"])
    first, last = int(item["in"]), int(item["out"])
    rows = []
    for share in SAMPLES:
        second = (first + (last - first) * share) / float(store.FPS)
        raw = await api.run_bytes(["ffmpeg", "-v", "error", "-ss", "%.3f" % second, "-i", source, "-frames:v", "1",
                                   "-vf", "scale=%d:-2" % SAMPLE_WIDTH, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        rows.append(cf_grade.np.frombuffer(raw, dtype=cf_grade.np.uint8).reshape(-1, 3))
    return cf_grade.stats(cf_grade.np.concatenate(rows))


async def match_grade(request):
    """{reference: clip, strength: 0..1}: give every other clip on the timeline a LUT that matches the reference's
    colours and values. One revision; set_grade with match null turns it off again."""
    api, store = _api(), _api().store
    if cf_grade.np is None:
        return api.refused("matching needs numpy in the worker")
    folder = store.slug(request.match_info["name"])
    body = await request.json()
    data = api.read_project(folder)
    clips = {c["id"]: c for c in data.get("clips", [])}
    reference = body.get("reference")
    if reference not in clips:
        return api.refused("reference is a clip of this project")
    strength = body.get("strength", 0.8)
    if isinstance(strength, bool) or not isinstance(strength, (int, float)) or not 0 <= strength <= 1:
        return api.refused("strength is a number from 0 to 1")
    shown = {}
    for item in sorted(data.get("timeline", []), key=lambda i: i["start"]):
        own = clips[item["clip"]].get("grade") or {}
        if item["clip"] not in shown and store.active_take(clips[item["clip"]]) and (not own.get("skip_match") or item["clip"] == reference):
            shown[item["clip"]] = item
    if reference not in shown:
        return api.refused("the reference clip has to be on the timeline with a take")
    measured = {}
    for clip_id, item in shown.items():
        try:
            measured[clip_id] = await _clip_stats(api, store, clips[clip_id], item)
        except (web.HTTPException, ValueError):
            continue        # a clip whose file cannot be read keeps its colours
    directory = os.path.join(api.root(), folder, "assets")
    os.makedirs(directory, exist_ok=True)
    luts = {}
    for clip_id, values in measured.items():
        if clip_id == reference:
            continue
        name = cf_grade.cube_name(clip_id, reference, strength, store.active_take(clips[clip_id])["id"])
        path = os.path.join(directory, name)
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as f:
                f.write(cf_grade.match_cube(values, measured[reference], float(strength)))
        luts[clip_id] = {"file": name, "subfolder": "%s/%s/assets" % (store.ROOT, folder)}
    async with api.lock(folder):
        fresh = api.read_project(folder)
        work = copy.deepcopy(fresh)
        cf_grade.apply_op(work, {"op": "set_grade", "fields": {"match": {"reference": reference, "strength": strength}}}, None)
        for clip in work.get("clips", []):
            if clip["id"] in luts or clip["id"] == reference:
                grade = dict(clip.get("grade") or {})
                grade.pop("match_lut", None)
                if clip["id"] in luts:
                    grade["match_lut"] = luts[clip["id"]]
                clip["grade"] = grade
        api.commit(folder, work, "match grade", body.get("client"))
    return web.json_response({"reference": reference, "strength": strength, "matched": len(luts),
                              "skipped": len(shown) - len(measured), "revision": work.get("revision", 0)})


async def export_nle(request):
    """An editable copy of the cut for DaVinci Resolve and Premiere Pro: FCP 7 XML, the media it uses and the clips'
    grading LUTs in one folder under the project's exports, and the same folder as a zip. {name?, copy_media?: true}"""
    import shutil
    import zipfile
    api, store = _api(), _api().store
    folder = store.slug(request.match_info["name"])
    try:
        body = await request.json()
    except ValueError:
        body = {}
    body = body if isinstance(body, dict) else {}
    data = api.read_project(folder)
    clips = {c["id"]: c for c in data.get("clips", [])}
    stem = store.slug(body["name"]) if str(body.get("name") or "").strip() else folder
    exports = os.path.join(api.root(), folder, "exports")
    number = 1
    while os.path.exists(os.path.join(exports, "%s_nle_%03d" % (stem, number))):
        number += 1
    out = os.path.join(exports, "%s_nle_%03d" % (stem, number))
    media = os.path.join(out, "media")
    os.makedirs(media)
    copy = body.get("copy_media", True) is not False

    def place(path):
        if not copy:
            return path
        target = os.path.join(media, os.path.basename(path))
        if not os.path.exists(target):
            shutil.copy2(path, target)
        return target

    rows, luts, sound_of = [], {}, {}
    for item in sorted(data.get("timeline", []), key=lambda i: i["start"]):
        clip = clips.get(item["clip"])
        take = store.active_take(clip) if clip else None
        if not take:
            continue
        path = api.output_path(take.get("subfolder"), take["file"])
        if not os.path.exists(path):
            continue
        notes = []
        s = cf_grade.settings(data, clip)
        for label, asset in (("match", s["match_lut"]), ("look", s["look"])):
            if asset:
                source = cf_grade.output_file(asset)
                if os.path.exists(source):
                    os.makedirs(os.path.join(out, "luts"), exist_ok=True)
                    shutil.copy2(source, os.path.join(out, "luts", os.path.basename(source)))
                    notes.append("%s LUT: luts/%s" % (label, os.path.basename(source)))
        if path not in sound_of:      # an imported clip may have no sound; its A1 clip would be offline in the NLE
            try:
                await api.run_bytes(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-t", "0.05", "-f", "null", "-"])
                sound_of[path] = True
            except web.HTTPException:
                sound_of[path] = False
        rows.append({"name": clip.get("name") or clip["id"], "path": place(path), "frames": int(take.get("frames") or item["out"]),
                     "start": int(item["start"]), "in": int(item["in"]), "out": int(item["out"]),
                     "speed": float(item.get("speed") or 1.0), "has_audio": sound_of[path], "note": "; ".join(notes)})
    if not rows:
        shutil.rmtree(out, ignore_errors=True)
        return api.refused("there are no rendered clips on the timeline to export")
    sounds = []
    for row in data.get("sounds") or []:
        try:
            path = api.output_path(row.get("subfolder"), row["file"])
        except web.HTTPException:
            continue
        if os.path.exists(path):
            sounds.append({"name": row.get("name") or "Sound", "path": place(path), "frames": int(round(row["seconds"] * store.FPS)),
                           "start": int(row.get("start", 0)), "offset": float(row.get("offset") or 0.0), "length": int(row["frames"]),
                           "gain": float(row.get("gain", 1.0)), "lane": int(row.get("lane", 0)),
                           "fade_in": float(row.get("fade_in") or 0.0), "fade_out": float(row.get("fade_out") or 0.0)})
    effects = []
    for effect in data.get("effects") or []:
        take = store.active_take(effect)
        if not take:
            continue
        path = api.output_path(take.get("subfolder"), take["file"])
        if os.path.exists(path):
            frames = int(take.get("frames") or effect["frames"])
            effects.append({"name": effect.get("name") or "VFX", "path": place(path), "frames": frames, "start": int(effect["start"]),
                            "length": min(int(effect["frames"]), frames - int(effect.get("skip") or 0))})
    xml = cf_nle.build(data, data.get("name") or stem, rows, sounds, effects)
    with open(os.path.join(out, stem + ".xml"), "w", encoding="utf-8") as f:
        f.write(xml)
    with open(os.path.join(out, "README.txt"), "w", encoding="utf-8") as f:
        f.write("Open %s.xml in DaVinci Resolve (File > Import > Timeline) or Premiere Pro (File > Import).\n"
                "The media is in media/. Each clip's notes name its grading LUTs in luts/; apply them in the colour page.\n" % stem)
    archive = out + ".zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_STORED) as zf:
        for base, _, names in os.walk(out):
            for name in names:
                full = os.path.join(base, name)
                zf.write(full, os.path.join(os.path.basename(out), os.path.relpath(full, out)))
    sub = "%s/%s/exports" % (store.ROOT, folder)
    return web.json_response({"xml": {"file": stem + ".xml", "subfolder": "%s/%s" % (sub, os.path.basename(out))},
                              "zip": {"file": os.path.basename(archive), "subfolder": sub}, "folder": out,
                              "clips": len(rows), "sounds": len(sounds), "effects": len(effects)})


async def grade_preview(request):
    """{frame, grade?}: the timeline frame as it is and as the export will grade it, two JPEG assets side by side.
    grade, when sent, is set_grade fields tried on a copy of the project, so a change can be seen before it is applied."""
    api, store = _api(), _api().store
    folder = store.slug(request.match_info["name"])
    body = await request.json()
    data = copy.deepcopy(api.read_project(folder))
    if isinstance(body.get("grade"), dict):
        try:
            cf_grade.apply_op(data, {"op": "set_grade", "fields": body["grade"]}, None)
        except (ValueError, KeyError) as error:
            return api.refused(str(error))
    frame = int(body.get("frame") or 0)
    clips = {c["id"]: c for c in data.get("clips", [])}
    item = next((i for i in sorted(data.get("timeline", []), key=lambda i: i["start"])
                 if i["start"] <= frame < i["start"] + int(round((i["out"] - i["in"]) / float(i.get("speed") or 1)))), None)
    clip = clips.get(item["clip"]) if item else None
    take = store.active_take(clip) if clip else None
    if not take:
        return api.refused("there is no rendered clip at that frame")
    source = api.output_path(take.get("subfolder"), take["file"])
    second = (item["in"] + (frame - item["start"]) * float(item.get("speed") or 1)) / float(store.FPS)
    directory = os.path.join(api.root(), folder, "assets")
    os.makedirs(directory, exist_ok=True)
    out = {}
    for label, filters in (("before", ""), ("after", cf_grade.item_filters(data, clip))):
        grain = float((data.get("grade") or {}).get("grain") or 0.0) if label == "after" else 0.0
        soft = cf_grade.soft_graph("g", "s", 960, cf_grade.soft_amount(data)) if label == "after" else []
        # The same soft finish and grain as the export, at the still's size.
        graph = ";".join(["[0:v]scale=960:544%s[g]" % filters] + soft
                         + (cf_grade.grain_graph("s" if soft else "g", "o", 960, 544, grain) or ["[%s]null[o]" % ("s" if soft else "g")]))
        name = "cf-preview-%s.jpg" % label
        await api.run_bytes(["ffmpeg", "-y", "-v", "error", "-ss", "%.3f" % second, "-i", source, "-frames:v", "1",
                             "-filter_complex", graph, "-map", "[o]", "-q:v", "3", os.path.join(directory, name)])
        out[label] = {"file": name, "subfolder": "%s/%s/assets" % (store.ROOT, folder)}
    return web.json_response(dict(out, clip=clip["id"], name=clip.get("name") or ""))


async def open_exports(request):
    """Open the project's exports folder in the file manager of the computer that runs the worker.

    The editor's worker is a local one (ComfyField finds it among the workspace's local workers), so this is the
    person's own machine. Only the project's own exports folder is opened; the client names no path."""
    import subprocess
    import sys
    api, store = _api(), _api().store
    folder = store.slug(request.match_info["name"])
    exports = os.path.join(api.root(), folder, "exports")
    if not os.path.isdir(exports):
        return api.refused("nothing has been exported for this project yet")
    if sys.platform.startswith("win"):
        os.startfile(exports)  # noqa: S606 - a fixed folder under the editor's own output root
    elif sys.platform == "darwin":
        subprocess.Popen(["open", exports])
    else:
        subprocess.Popen(["xdg-open", exports])
    return web.json_response({"folder": exports})


# Reference packs: named sets of catalog entries in _cast/packs.json, beside the catalog.
def _packs_file(api):
    return os.path.join(api.catalog_folder(), "packs.json")


def _read_packs(api):
    try:
        with open(_packs_file(api), encoding="utf-8") as f:
            rows = json.load(f).get("packs", [])
        return rows if isinstance(rows, list) else []
    except (OSError, ValueError):
        return []


async def ref_packs(request):
    api = _api()
    return web.json_response({"packs": cf_packs.view(_read_packs(api), api.read_catalog())})


async def save_ref_pack(request):
    """Body: name, members (catalog ids), and for a pack that exists its id and mode overwrite, extend or rename."""
    api = _api()
    body = await request.json()
    async with api.lock(api.CATALOG):
        catalog = api.read_catalog()
        try:
            packs, pack = cf_packs.save_pack(_read_packs(api), catalog, body.get("name"), body.get("members"),
                                             body.get("id"), body.get("mode") or ("overwrite" if body.get("id") else "new"))
        except KeyError as error:
            return api.refused(api.plain(error), 404)
        except ValueError as error:
            return api.refused(str(error))
        api.write_json(_packs_file(api), {"packs": packs})
    return web.json_response({"pack": pack["id"], "packs": cf_packs.view(packs, catalog)})


async def remove_ref_pack(request):
    """Take a pack out. Its members stay in the catalog and in every project that took them."""
    api = _api()
    body = await request.json()
    async with api.lock(api.CATALOG):
        try:
            packs = cf_packs.remove_pack(_read_packs(api), body.get("id"))
        except KeyError as error:
            return api.refused(api.plain(error), 404)
        api.write_json(_packs_file(api), {"packs": packs})
    return web.json_response({"packs": cf_packs.view(packs, api.read_catalog())})


# Render a clip again from its notes (IDEA-2616): the open notes with a box, pin or drawing on the clip's shown take
# become cf_region for this one render only, so the clip itself never carries it.
async def render_notes(request):
    api = _api()
    store = api.store
    folder = store.slug(request.match_info["name"])
    body = await request.json()
    async with api.lock(folder):
        data = api.read_project(folder)
        try:
            clip = store.find_clip(data, body.get("clip"))
            take = store.active_take(clip)
            if take is None:
                raise ValueError("%s has no render yet" % clip["name"])
            edit = cf_region.from_notes(data, clip, take)
            if edit is None:
                raise ValueError("%s has no open note with a box, pin or drawing on its shown take" % clip["name"])
            seconds = clip.get("seconds")
            clip["cf_region"] = edit
            clip["seconds"] = edit["frames"] / 24.0     # the same length as the take it holds
            try:
                job = await api.start_render(data, folder, clip["id"], body.get("quality") or "draft", None, body.get("client_id"))
            finally:
                clip.pop("cf_region", None)
                clip["seconds"] = seconds
        except (ValueError, KeyError) as error:
            return api.refused(api.plain(error))
        except api.Refused as error:
            return api.refused(api.plain(error), 502)
        api.commit(folder, data, "render", body.get("client_id"))
    return web.json_response({"job": job, "notes": edit["notes"], "revision": data["revision"], "project": data})
