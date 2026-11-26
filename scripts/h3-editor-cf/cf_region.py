"""CreativeField: edit a rendered clip like a picture (user 2026-11-26, Pad IDEA-2616).

The user pauses on a frame, draws boxes and says what changes in each. The clip renders again as a new take through
the editor's own H3 Take, draft or final: the source take is held as video to video (v2v, keep 0, every frame) and
only the boxes are regenerated (H3 Take's region mask, 1 = regenerate), so the rest of the picture, the motion and
the sound stay. The notes become the shot text. Building blocks, not a new graph: H3 Take v2v + region (the editor),
the same idea as the app's "Swap a thing (HyperFlow, area only)" and the MiniMax H3 inpaint packs.

clip["cf_region"] = {"source": {"file", "subfolder"}, "frames": n, "boxes": [{"x", "y", "w", "h", "instruction"}],
                     "feather": 0..0.2}
Boxes are fractions of the picture. A clip with cf_region keeps H3 Take (RefPacks has no held video).
"""

MASK, BOX, ADD, SOFT = 900, 910, 930, 950   # node ids: the empty mask, one white box and one merge per box, the soft edge
MAX_BOXES = 8


def editing(clip):
    edit = clip.get("cf_region")
    return bool(edit and edit.get("source") and edit.get("boxes"))


def shot_text(edit, look=""):
    """What the regenerated boxes should show, numbered as the user drew them."""
    rows = [b for b in edit["boxes"][:MAX_BOXES] if str(b.get("instruction", "")).strip()]
    lines = ["Region %d: %s." % (i + 1, str(b["instruction"]).strip().rstrip(".")) for i, b in enumerate(rows)]
    text = ("The video stays exactly as it is: same shot, camera, motion, people, light and sound. "
            "Change only the marked regions. " + " ".join(lines))
    look = str(look or "").strip().rstrip(".")
    return text + (" The look is %s." % look if look else "")


def mask_nodes(graph, edit, width, height):
    """A white box per region on black, at the take's size, with a soft edge. Returns the mask's output."""
    graph[str(MASK)] = {"class_type": "SolidMask", "inputs": {"value": 0.0, "width": width, "height": height}}
    out = [str(MASK), 0]
    for i, b in enumerate(edit["boxes"][:MAX_BOXES]):
        x, y = max(0, round(float(b["x"]) * width)), max(0, round(float(b["y"]) * height))
        w = max(8, min(width - x, round(float(b["w"]) * width)))
        h = max(8, min(height - y, round(float(b["h"]) * height)))
        graph[str(BOX + i)] = {"class_type": "SolidMask", "inputs": {"value": 1.0, "width": w, "height": h}}
        graph[str(ADD + i)] = {"class_type": "MaskComposite", "inputs": {
            "destination": out, "source": [str(BOX + i), 0], "x": x, "y": y, "operation": "add"}}
        out = [str(ADD + i), 0]
    feather = round(min(width, height) * float(edit.get("feather", 0.04)))
    if feather > 0:
        graph[str(SOFT)] = {"class_type": "GrowMaskWithBlur", "inputs": {
            "mask": out, "expand": feather // 2, "incremental_expandrate": 0, "tapered_corners": True, "flip_input": False,
            "blur_radius": float(feather), "lerp_alpha": 1, "decay_factor": 1, "fill_holes": False}}
        out = [str(SOFT), 0]
    return out


KLEIN = {"unet": "flux3-image-klein-int8-convrot.safetensors", "clip": "qwen3vl_4b_int8_convrot.safetensors",
         "vae": "flux2-vae.safetensors"}
ANCHOR = 960   # node ids of the edited anchor frame


def anchor_nodes(graph, edit, file, frame, region):
    """The note's frame, edited with FLUX 3 Klein from the notes, and pasted back only inside the boxes.

    Without it H3 eases the change in over the first half second (prototype 2026-11-26); with the edited frame
    pinned where the note is, the change is there from that frame on. Returns the picture's output."""
    n = lambda i: str(ANCHOR + i)
    prompt = ("Change only the marked areas: " + " ".join(
        str(b["instruction"]).strip().rstrip(".") + "." for b in edit["boxes"][:MAX_BOXES] if str(b.get("instruction", "")).strip())
        + " Keep the framing, size, perspective, light and everything else exactly as it is.")
    graph.update({
        n(0): {"class_type": "H3LoadClip", "inputs": {"file": file, "first": frame, "last": frame + 1}},
        n(1): {"class_type": "ImageScaleToTotalPixels", "inputs": {"upscale_method": "lanczos", "megapixels": 1, "resolution_steps": 16, "image": [n(0), 0]}},
        n(2): {"class_type": "GetImageSize", "inputs": {"image": [n(1), 0]}},
        n(3): {"class_type": "UNETLoader", "inputs": {"unet_name": KLEIN["unet"], "weight_dtype": "default"}},
        n(4): {"class_type": "CLIPLoader", "inputs": {"clip_name": KLEIN["clip"], "type": "flux3", "device": "default"}},
        n(5): {"class_type": "VAELoader", "inputs": {"vae_name": KLEIN["vae"]}},
        n(6): {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": [n(4), 0]}},
        n(7): {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": [n(4), 0]}},
        n(8): {"class_type": "ModelSamplingFlux", "inputs": {"max_shift": 2.7725887, "base_shift": 2.7725887, "width": 1024, "height": 1024, "model": [n(3), 0]}},
        n(9): {"class_type": "ReferenceMultiLatent", "inputs": {"resolution": "resize", "resolution.megapixels": 1, "positive": [n(6), 0],
                                                               "negative": [n(7), 0], "vae": [n(5), 0], "images.image0": [n(1), 0]}},
        n(10): {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": [n(2), 0], "height": [n(2), 1], "batch_size": 1}},
        n(11): {"class_type": "KSampler", "inputs": {"seed": int(edit.get("seed", 7)), "steps": 16, "cfg": 1, "sampler_name": "euler", "scheduler": "simple",
                                                   "denoise": 1, "model": [n(8), 0], "positive": [n(9), 0], "negative": [n(9), 1], "latent_image": [n(10), 0]}},
        n(12): {"class_type": "VAEDecode", "inputs": {"samples": [n(11), 0], "vae": [n(5), 0]}},
        # back to the frame's own size, then only the boxes taken from the edit
        n(13): {"class_type": "GetImageSize", "inputs": {"image": [n(0), 0]}},
        n(14): {"class_type": "ImageScale", "inputs": {"image": [n(12), 0], "upscale_method": "lanczos", "width": [n(13), 0], "height": [n(13), 1], "crop": "disabled"}},
        n(15): {"class_type": "MaskToImage", "inputs": {"mask": region}},
        n(16): {"class_type": "ImageScale", "inputs": {"image": [n(15), 0], "upscale_method": "bilinear", "width": [n(13), 0], "height": [n(13), 1], "crop": "disabled"}},
        n(17): {"class_type": "ImageToMask", "inputs": {"image": [n(16), 0], "channel": "red"}},
        n(18): {"class_type": "ImageCompositeMasked", "inputs": {"destination": [n(0), 0], "source": [n(14), 0], "x": 0, "y": 0,
                                                               "resize_source": False, "mask": [n(17), 0]}},
    })
    return [n(18), 0]


def route(graph, project, clip, editor=None):
    """The take graph with the source held and only the boxes regenerated, on both passes of a final."""
    if not editing(clip) or graph.get("10", {}).get("class_type") != "H3Take":
        return graph
    edit = clip["cf_region"]
    take = graph["10"]["inputs"]
    source = edit["source"]
    file = "%s/%s" % (source["subfolder"], source["file"]) if source.get("subfolder") else source["file"]
    length = int(take["length"])
    graph["6"] = {"class_type": "H3LoadClip", "inputs": {"file": file, "first": 0, "last": length}}
    region = mask_nodes(graph, edit, int(take["width"]), int(take["height"]))
    text = shot_text(edit, project.get("style", ""))
    frame = int(edit.get("frame", 0))
    anchor = anchor_nodes(graph, edit, file, frame, region) if edit.get("anchor", True) else None
    for node in ("10", "80"):
        if graph.get(node, {}).get("class_type") != "H3Take":
            continue
        graph[node]["inputs"].update({
            "prompt": text, "video_mode": "v2v", "hold_frames": length, "strength": "hold", "keep": 0.0,
            "source_video": ["6", 0], "source_audio": ["6", 1], "audio_hold": "full", "region": region,
            "anchor": "none",
        })
        for pin in ("start_image", "end_image"):
            graph[node]["inputs"].pop(pin, None)
        if anchor:
            # The edited frame is pinned where the note is: frame 0 as the start, any other frame as a mid frame,
            # at this pass's own size (a picture of another size gives H3 a guide of the wrong token count).
            fitted = str(ANCHOR + 30 + (node == "80"))
            size = graph[node]["inputs"]
            graph[fitted] = {"class_type": "ImageScale", "inputs": {"image": anchor, "upscale_method": "lanczos",
                                                                   "width": int(size["width"]), "height": int(size["height"]), "crop": "center"}}
            if frame == 0:
                graph[node]["inputs"].update({"start_image": [fitted, 0], "anchor": "start"})
            else:
                graph[node]["inputs"].update({"mid_images.mid_image_0": [fitted, 0], "mid_frames": str(frame)})
    paste_back(graph, region)
    return graph


REFINE_CHAIN = [str(n) for n in range(80, 92)]   # the standard draft's latent upscale and redraw (cf_studio)
PASTE = 995


def paste_back(graph, region):
    """A draft's regenerated boxes go back into the source take at its own size; every other pixel is the source.

    A standard draft redraws its 1024 px latent larger with the first pass's conditioning (nodes 80 to 91). With a
    pinned anchor frame that conditioning carries a guide of the small size, which does not fit the larger latent
    (shape mismatch, 2026-11-26). Here it is not needed: outside the boxes the source is kept as it was, so only the
    boxes are scaled up and pasted, as the app's area swap does. A final keeps its own refine (its H3 Take at the
    final size holds the source and the boxes itself)."""
    if graph.get("80", {}).get("class_type") != "EmptyMiniMaxH3LatentAV":
        return
    out = next((n for n in ("91", "90") if n in graph and graph[n]["class_type"] == "VAEDecode"), "91")
    n = lambda i: str(PASTE + i)
    graph.update({
        n(0): {"class_type": "GetImageSize", "inputs": {"image": ["6", 0]}},
        n(1): {"class_type": "ImageScale", "inputs": {"image": ["16", 0], "upscale_method": "lanczos", "width": [n(0), 0], "height": [n(0), 1], "crop": "disabled"}},
        n(2): {"class_type": "MaskToImage", "inputs": {"mask": region}},
        n(3): {"class_type": "ImageScale", "inputs": {"image": [n(2), 0], "upscale_method": "bilinear", "width": [n(0), 0], "height": [n(0), 1], "crop": "disabled"}},
        n(4): {"class_type": "ImageToMask", "inputs": {"image": [n(3), 0], "channel": "red"}},
        n(5): {"class_type": "ImageCompositeMasked", "inputs": {"destination": ["6", 0], "source": [n(1), 0], "x": 0, "y": 0,
                                                              "resize_source": False, "mask": [n(4), 0]}},
    })
    for key, other in list(graph.items()):
        if key in REFINE_CHAIN:
            continue
        for name, value in list(other["inputs"].items()):
            if value == [out, 0]:
                other["inputs"][name] = [n(5), 0]
            elif isinstance(value, list) and len(value) == 2 and value[0] in REFINE_CHAIN:
                # The hold of the redrawn latent (H3 Save Hold "final"): there is none, the first pass's hold is kept.
                other["inputs"].pop(name)
    for key in REFINE_CHAIN:
        graph.pop(key, None)


def box_of(shape, pin_size=0.18, margin=0.03):
    """A note's shape as a box: a box as it is, a pin as a box around it, strokes as the box around them."""
    kind = (shape or {}).get("type")
    if kind == "rect":
        return {k: float(shape[k]) for k in ("x", "y", "w", "h")}
    if kind == "pin":
        x, y = float(shape["x"]), float(shape["y"])
        x0, y0 = max(0.0, x - pin_size / 2), max(0.0, y - pin_size / 2)
        return {"x": x0, "y": y0, "w": min(pin_size, 1 - x0), "h": min(pin_size, 1 - y0)}
    if kind == "stroke":
        points = [p for path in shape.get("paths") or [] for p in path]
        if not points:
            return None
        x0, y0 = max(0.0, min(p[0] for p in points) - margin), max(0.0, min(p[1] for p in points) - margin)
        x1, y1 = min(1.0, max(p[0] for p in points) + margin), min(1.0, max(p[1] for p in points) + margin)
        return {"x": x0, "y": y0, "w": max(0.02, x1 - x0), "h": max(0.02, y1 - y0)}
    return None


def from_notes(project, clip, take):
    """The edit the clip's open notes on its shown take ask for, or None when they mark nothing on the picture."""
    rows = [n for n in project.get("notes") or [] if isinstance(n, dict) and n.get("clip") == clip["id"]
            and n.get("take") == take["id"] and n.get("status") != "resolved" and box_of(n.get("shape"))]
    if not rows or not take.get("file"):
        return None
    rows.sort(key=lambda n: int(n.get("frame") or 0))
    boxes = [dict(box_of(n["shape"]), instruction=str(n.get("text") or "").strip()) for n in rows[:MAX_BOXES]]
    return {"source": {"file": take["file"], "subfolder": take.get("subfolder", "")}, "frames": int(take.get("frames") or 0),
            "frame": int(rows[0].get("frame") or 0), "boxes": boxes, "notes": [n["id"] for n in rows[:MAX_BOXES]],
            "feather": 0.04, "anchor": True, "seed": int(clip.get("seed") or 7)}
