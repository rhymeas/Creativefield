"""CreativeField: Film Studio reference takes through BExplains H3 RefPacks (user 2026-11-25).

A blind benchmark (Pad..2587: 2 scenes, 2 seeds, 12 sheets) picked the RefPacks pipeline in 10 of 12
cuts over the editor's own reference prompt. So a clip whose references RefPacks can carry renders through it:
each cast member is encoded once as a pack with its role, and RefPacks compiles the prompt from the shot text.

A pinned first or last frame goes in as H3 Take sends it: as the first pictures (<Picture 1>, then the last frame)
and as a guide at frame 0 or the last frame (MiniMaxH3AddGuide), on both passes of a final. Cast descriptions stay
out of the text: with an item's description added, blind round 3 ranked the take last (Pad, round 3 verdict).

A clip keeps the editor's H3 Take when it extends or bridges another clip, speaks with a cast voice, has dialogue,
music or a sound track, or shows a cast member of a kind RefPacks has no role for (style). The same clip renders
the same way on every run.

RefPacks: MIT, github.com/BExplains/ComfyUI-MiniMax-H3-RefPacks (installed as custom_nodes/BExplains_H3_RefPacks).
"""
import re

try:
    from .cf_refs import kind_of
    from . import cf_region as region
except ImportError:
    from cf_refs import kind_of
    import cf_region as region

NODES = ("BExplainsH3EncodeImages", "BExplainsAddRefPack", "BExplainsRefPackToH3")
ROLES = {"person": "character", "item": "item", "location": "location", "outfit": "outfit"}
TAGS = {"character": "Character", "item": "Item", "location": "Location", "outfit": "Outfit"}
BATCH, ENCODE, ADD = 200, 300, 320   # node ids: picture batches, one encoder and one role per member
FRAME_ENCODE, FRAME_ADD, GUIDE = 340, 345, 350   # pinned frames: their packs, and their guides per pass
FRAMES = (("first", "40", "first frame"), ("last", "41", "last frame"))   # the editor's still nodes for them


def installed():
    try:
        import nodes
    except ImportError:
        return False
    return all(name in nodes.NODE_CLASS_MAPPINGS for name in NODES)


def carries(project, clip, shown, editor):
    """Can RefPacks render this clip with everything the editor would give it."""
    if not shown:
        return False
    if clip.get("link") or clip.get("track"):
        return False
    if editor.clip_voice(project, clip) or str(clip.get("dialogue", "")).strip() or str(clip.get("music", "")).strip():
        return False
    return all(kind_of(member) in ROLES for member, _ in shown)


def roles(shown):
    """Each member with its role and its tag, <Character 1>, <Item 1>, ... counted per role in cast order."""
    counts, rows = {}, []
    for member, pictures in shown:
        role = ROLES[kind_of(member)]
        counts[role] = counts.get(role, 0) + 1
        rows.append({"member": member, "pictures": pictures, "role": role, "tag": "<%s %s>" % (TAGS[role], counts[role])})
    return rows


def tagged(text, rows):
    """@Name to its role tag, longest names first, so @Old Tom wins over @Old."""
    for row in sorted(rows, key=lambda r: -len(r["member"]["name"])):
        text = re.sub("@" + re.escape(row["member"]["name"]), row["tag"], text, flags=re.IGNORECASE)
    return text


def shot_text(project, clip, rows, editor, first=None, last=None):
    """The plain shot instruction RefPacks compiles: action, then camera, sound and look, cast as role tags.

    first and last are the <Picture n> tags of pinned frames, or None.
    """
    chosen = clip.get("cast") or []
    unpictured = [m for m in project.get("cast", []) if m["id"] in chosen and m.get("refmod") and not m.get("file")]
    body = tagged(editor.name_unpictured(str(clip.get("action", "")).strip(), unpictured), rows)
    lead = []
    for row in rows:
        if row["tag"] in body or row["role"] == "outfit":
            continue
        # Every chosen picture is used: RefPacks only binds the ones the text names.
        lead.append("The shot takes place in %s." % row["tag"] if row["role"] == "location" else "%s appears in the shot." % row["tag"])
    parts = (["The shot begins exactly on %s." % first] if first else []) + lead + [body]
    for extra in (clip.get("camera", ""), clip.get("sound", "")):
        if str(extra).strip():
            parts.append(tagged(str(extra).strip(), rows))
    look = str(project.get("style", "")).strip().rstrip(".,")
    if look:
        parts.append("The look is %s." % look)
    if last:
        parts.append("The shot ends exactly on %s." % last)
    return " ".join(p if p.endswith((".", "!", "?")) else p + "." for p in parts)


def _swap(graph, node, outputs):
    """Point every input that reads node's outputs at the new numbers, outputs {old: new}."""
    for key, other in graph.items():
        if key == node:
            continue
        for name, value in other["inputs"].items():
            if isinstance(value, list) and len(value) == 2 and value[0] == node and value[1] in outputs:
                other["inputs"][name] = [node, outputs[value[1]]]


def route(graph, project, clip, editor):
    """The finished take graph, with its H3 Take nodes replaced by RefPacks when RefPacks carries the clip.

    editor is the editor's project module (cast_pictures, frame_of, clip_voice, name_unpictured).
    """
    if clip.get("cf_region"):
        # A clip rendered again from its notes holds its own take and regenerates only the marked areas (cf_region).
        return region.route(graph, project, clip, editor)
    if graph.get("10", {}).get("class_type") != "H3Take" or not installed():
        return graph
    shown = editor.cast_pictures(project, clip)
    if not carries(project, clip, shown, editor):
        return graph
    rows = roles(shown)
    take = graph["10"]["inputs"]
    area = round(take["width"] * take["height"] / 1e6, 4)   # references at the output's pixel area, as "match" does
    index, references = 0, None
    # Pinned frames first, so they are <Picture 1> and <Picture 2> as with H3 Take. RefPacks numbers in the order added.
    pinned = [(side, still, name) for side, still, name in FRAMES if editor.frame_of(clip, side) and still in graph]
    tags = {}
    for number, (side, still, name) in enumerate(pinned):
        graph[str(FRAME_ENCODE + number)] = {"class_type": "BExplainsH3EncodeImages", "inputs": {
            "vae": ["3", 0], "images": [still, 0], "name": name, "reference_megapixels": area}}
        add = {"refpack": [str(FRAME_ENCODE + number), 0], "role": "reference"}
        if references:
            add["references"] = references
        graph[str(FRAME_ADD + number)] = {"class_type": "BExplainsAddRefPack", "inputs": add}
        references = [str(FRAME_ADD + number), 0]
        tags[side] = "<Picture %s>" % (number + 1)
    for number, row in enumerate(rows):
        stills = [str(50 + index + i) for i in range(len(row["pictures"]))]
        index += len(stills)
        image = [stills[0], 0]
        for extra, still in enumerate(stills[1:]):
            # One member's pictures go in as one pack; ImageBatch fits each to the first picture's size.
            node = str(BATCH + 10 * number + extra)
            graph[node] = {"class_type": "ImageBatch", "inputs": {"image1": image, "image2": [still, 0]}}
            image = [node, 0]
        graph[str(ENCODE + number)] = {"class_type": "BExplainsH3EncodeImages", "inputs": {
            "vae": ["3", 0], "images": image, "name": row["member"]["name"], "reference_megapixels": area}}
        add = {"refpack": [str(ENCODE + number), 0], "role": row["role"]}
        if references:
            add["references"] = references
        graph[str(ADD + number)] = {"class_type": "BExplainsAddRefPack", "inputs": add}
        references = [str(ADD + number), 0]
    prompt = shot_text(project, clip, rows, editor, tags.get("first"), tags.get("last"))
    for number, node in enumerate(("10", "80")):
        if graph.get(node, {}).get("class_type") != "H3Take":
            continue
        # H3 Take gives conditioning 0 and latent 1; RefPacks gives model 0, positive 1, negative 2, latent 3.
        _swap(graph, node, {0: 1, 1: 3})
        size = graph[node]["inputs"]
        positive = [node, 1]
        for extra, (side, still, _) in enumerate(pinned):
            # The frame is held where H3 Take holds it: the first frame at 0, the last at the take's last frame.
            guide = str(GUIDE + 5 * number + extra)
            graph[guide] = {"class_type": "MiniMaxH3AddGuide", "inputs": {
                "positive": positive, "latent": [node, 3], "vae": ["3", 0], "image": [still, 0],
                "frame_idx": 0 if side == "first" else int(size["length"]) - 1}}
            positive = [guide, 0]
        if pinned:
            for key, other in graph.items():
                if other["class_type"] == "MiniMaxH3AddGuide":
                    continue
                for name, value in other["inputs"].items():
                    if value == [node, 1]:
                        other["inputs"][name] = positive
        graph[node] = {"class_type": "BExplainsRefPackToH3", "inputs": {
            "model": ["5", 0], "clip": ["2", 0], "references": references, "prompt": prompt, "negative_prompt": "",
            "width": size["width"], "height": size["height"], "length": size["length"], "auto_outfit": True,
            "vae": ["3", 0], "log_performance": False, "compress_motion": False, "allow_raw_prompt": False,
            "generation_mode": "Video",
            # Not an input of the node; ComfyUI passes only the ones it declares. The take's record reads it.
            "checkpoint": size["checkpoint"]}}
    # The model RefPacks returns is the one the first pass samples and previews with.
    for key, other in graph.items():
        if key in ("10", "80"):
            continue
        for name, value in other["inputs"].items():
            if value == ["5", 0]:
                other["inputs"][name] = ["10", 0]
    return graph
