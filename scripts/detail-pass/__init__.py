"""CreativeField Detail Pass (2026-11-22,).

Video models draw a face in a group shot with 40-60 pixels, a chest logo with 30; refining the whole frame cannot add
detail the draft never drew. The detail pass gives those areas more pixels: Detail Box takes the tracked face/logo mask
of the finished clip, cuts the box around it (with margin) out of every frame and out of the start picture, enlarged to
about one megapixel; the H3 graph re-samples that crop partly with the start-picture crop as reference; Detail Paste
scales the result back into the box through a feathered edge. Every pixel outside the box stays the clip's own.
Detail Atlas (the one the graph uses) merges areas of one person (face + chest logo) and follows each piece: pieces are tight boxes that move with their object (tracked
from the mask frames, interpolated to every video frame), so lettering gets 2.4x or more instead of the ~1.9x a
fixed box around the whole motion path allows.
Only torch, numpy, cv2 and standard ComfyUI types; no files, network or processes.
"""
import json
import math
import torch
import torch.nn.functional as F


def _resize(images, w, h):
    # images [N, H, W, C] -> [N, h, w, C]
    x = images.movedim(-1, 1)
    x = F.interpolate(x, size=(h, w), mode="bicubic", align_corners=False, antialias=True)
    return x.movedim(1, -1).clamp(0, 1)


def plan_box(union, width, height, megapixels, max_scale, margin, min_scale):
    """Box (x, y, w, h) around the mask's pixels with `margin` of its size added on every side, and the sampling size
    (tw, th) on H3's 32 px grid at about `megapixels`, enlarged at most `max_scale`. None when the mask is empty or
    the box would be enlarged less than `min_scale` (nothing to gain)."""
    ys, xs = torch.nonzero(union, as_tuple=True)
    if xs.numel() == 0:
        return None
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    mx, my = round((x1 - x0) * margin), round((y1 - y0) * margin)
    x0, x1 = max(0, x0 - mx), min(width, x1 + mx)
    y0, y1 = max(0, y0 - my), min(height, y1 + my)
    bw, bh = x1 - x0, y1 - y0
    scale = min(max_scale, math.sqrt(megapixels * 1_000_000 / float(bw * bh)))
    if scale < min_scale:
        return None
    tw, th = max(256, round(bw * scale / 32) * 32), max(256, round(bh * scale / 32) * 32)
    return (x0, y0, bw, bh), (tw, th)


class CreativeFieldDetailBox:
    CATEGORY = "CreativeField"
    DESCRIPTION = ("Cut the box around a tracked mask (faces, logos) out of a clip and out of its start picture, "
                   "enlarged to about one megapixel, for a detail re-sample. Wire Detail Paste after the decode.")
    RETURN_TYPES = ("IMAGE", "IMAGE", "STRING")
    RETURN_NAMES = ("frames", "reference", "box")
    FUNCTION = "cut"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",), "mask": ("MASK",), "reference": ("IMAGE",),
            "megapixels": ("FLOAT", {"default": 1.0, "min": 0.25, "max": 2.0, "step": 0.05}),
            "max_scale": ("FLOAT", {"default": 4.0, "min": 1.0, "max": 6.0, "step": 0.1}),
            "margin": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 2.0, "step": 0.05,
                                 "tooltip": "Added on every side, as a share of the mask box's size."}),
            "min_scale": ("FLOAT", {"default": 1.3, "min": 1.0, "max": 4.0, "step": 0.1,
                                    "tooltip": "Skip when the box would be enlarged less than this."}),
        }}

    def cut(self, images, mask, reference, megapixels=1.0, max_scale=4.0, margin=0.35, min_scale=1.3):
        n, h, w = images.shape[0], images.shape[1], images.shape[2]
        m = mask.reshape(-1, mask.shape[-2], mask.shape[-1]).float()
        union = (m.max(dim=0).values > 0.5).float()[None, None]
        union = F.interpolate(union, size=(h, w), mode="nearest")[0, 0] > 0.5
        plan = plan_box(union, w, h, megapixels, max_scale, margin, min_scale)
        if plan is None:
            # Nothing to refine: a small dummy crop keeps the graph valid and cheap; Detail Paste ignores it.
            box, (tw, th) = (0, 0, min(w, 256), min(h, 256)), (256, 256)
            skip = True
        else:
            box, (tw, th) = plan
            skip = False
        x, y, bw, bh = box
        frames = _resize(images[:, y:y + bh, x:x + bw], tw, th)
        rh, rw = reference.shape[1], reference.shape[2]
        kx, ky = rw / w, rh / h
        rx, ry, rbw, rbh = round(x * kx), round(y * ky), max(1, round(bw * kx)), max(1, round(bh * ky))
        ref = reference[:1, ry:ry + rbh, rx:rx + rbw]
        print(f"[CreativeFieldDetailBox] {'skip: no mask worth refining' if skip else f'box {bw}x{bh} at ({x},{y}) of {w}x{h} -> {tw}x{th} ({tw / bw:.1f}x)'}, {n} frames")
        return (frames, ref, json.dumps({"x": x, "y": y, "w": bw, "h": bh, "width": w, "height": h, "skip": skip}))


class CreativeFieldDetailPaste:
    CATEGORY = "CreativeField"
    DESCRIPTION = "Scale the re-sampled detail crop back into its box through a feathered edge; other pixels stay the clip's own."
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "paste"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",), "detail": ("IMAGE",), "box": ("STRING", {"forceInput": True}),
            "feather": ("INT", {"default": 24, "min": 0, "max": 128, "step": 1}),
        }}

    def paste(self, images, detail, box, feather=24):
        b = json.loads(box)
        if b.get("skip") or images.shape[1] != b["height"] or images.shape[2] != b["width"]:
            if not b.get("skip"):
                print("[CreativeFieldDetailPaste] frame size differs from the box plan; frames passed through")
            return (images,)
        x, y, bw, bh = b["x"], b["y"], b["w"], b["h"]
        n = min(images.shape[0], detail.shape[0])
        yy = torch.arange(bh, dtype=torch.float32)[:, None]
        xx = torch.arange(bw, dtype=torch.float32)[None, :]
        edge = torch.minimum(torch.minimum(xx, bw - 1 - xx), torch.minimum(yy, bh - 1 - yy))
        alpha = (edge / feather).clamp(0, 1) if feather else torch.ones((bh, bw))
        alpha = alpha[None, :, :, None]
        out = images.clone()
        for i in range(0, n, 16):
            j = min(n, i + 16)
            crop = _resize(detail[i:j].float(), bw, bh)
            region = out[i:j, y:y + bh, x:x + bw]
            out[i:j, y:y + bh, x:x + bw] = alpha * crop + (1 - alpha) * region
        print(f"[CreativeFieldDetailPaste] {n} of {images.shape[0]} frames refined in the {bw}x{bh} box at ({x},{y})")
        return (out,)


def _iou(a, b):
    iw, ih = min(a[2], b[2]) - max(a[0], b[0]), min(a[3], b[3]) - max(a[1], b[1])
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def _center(b):
    return (b[0] + b[2]) / 2, (b[1] + b[3]) / 2


def _diag(b):
    return math.hypot(b[2] - b[0], b[3] - b[1])


def _grown(b, margin, min_pad):
    px, py = max(min_pad, (b[2] - b[0]) * margin), max(min_pad, (b[3] - b[1]) * margin)
    return (b[0] - px, b[1] - py, b[2] + px, b[3] + py)


def mask_components(mask_k, sx, sy, min_area=16):
    """Boxes (x0, y0, x1, y1) of the separate areas of one mask frame, scaled to frame size. Specks below `min_area`
    mask pixels are detector noise and would only make tracks that flicker."""
    import cv2
    import numpy as np
    count, _labels, stats, _ = cv2.connectedComponentsWithStats((mask_k > 0.5).astype(np.uint8), connectivity=8)
    boxes = []
    for i in range(1, count):
        x, y, w, h, area = (int(v) for v in stats[i])
        if area >= min_area:
            boxes.append((x * sx, y * sy, (x + w) * sx, (y + h) * sy))
    return boxes


def link_tracks(frame_boxes):
    """Follow each area from one mask frame to the next. Candidate pairs are ranked by overlap, then by distance, and
    a track takes at most one area per frame, so two close faces never collapse into one track. Returns tracks as
    {mask frame index: box}. A pair links when the boxes overlap (IoU > 0.1) or the centres are closer than half the
    larger box's diagonal and the sizes are alike (people move several pixels per mask frame, so overlap alone breaks)."""
    tracks = []  # each {"obs": {k: box}, "last": box}
    for k, boxes in enumerate(frame_boxes):
        cands = []
        for ci, b in enumerate(boxes):
            for ti, t in enumerate(tracks):
                last = t["last"]
                iou = _iou(b, last)
                (cx, cy), (lx, ly) = _center(b), _center(last)
                dist = math.hypot(cx - lx, cy - ly)
                area_b, area_l = (b[2] - b[0]) * (b[3] - b[1]), (last[2] - last[0]) * (last[3] - last[1])
                alike = 0.25 <= area_b / max(area_l, 1e-6) <= 4.0
                if iou > 0.1 or (alike and dist < 0.5 * max(_diag(b), _diag(last))):
                    cands.append((-iou, dist, ci, ti))
        cands.sort()
        used_c, used_t = set(), set()
        for _iou_neg, _dist, ci, ti in cands:
            if ci in used_c or ti in used_t:
                continue
            used_c.add(ci)
            used_t.add(ti)
            tracks[ti]["obs"][k] = boxes[ci]
            tracks[ti]["last"] = boxes[ci]
        for ci, b in enumerate(boxes):
            if ci not in used_c:
                tracks.append({"obs": {k: b}, "last": b})
    return [t["obs"] for t in tracks]


def _gaps(a, b):
    """Horizontal and vertical gap between two boxes (0 where they overlap on that axis)."""
    return max(b[0] - a[2], a[0] - b[2], 0.0), max(b[1] - a[3], a[1] - b[3], 0.0)


def _near(a, b, margin, min_pad):
    """Two boxes belong to one person or object: they sit side by side or one above the other (a face above its chest
    logo) with a small gap, or their margin-grown boxes overlap."""
    gx, gy = _gaps(a, b)
    wa, wb, ha, hb = a[2] - a[0], b[2] - b[0], a[3] - a[1], b[3] - b[1]
    # Horizontal gap up to 0.3 of the smaller width (a face and the chest logo below it line up to a few pixels); vertical
    # gap up to 0.8 of the larger height (a small logo is far from a face compared with its own size, not the face's).
    if gx <= 0.3 * min(wa, wb) and gy <= 0.8 * max(ha, hb):
        return True
    return _iou(_grown(a, margin, min_pad), _grown(b, margin, min_pad)) > 0


def _union(a, b):
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def merge_tracks(tracks, margin, min_pad, share=0.5, width=None, height=None, max_w=0.45, max_h=0.6):
    """Join tracks that belong to one person or object. Tracks are taken in rank order (present in the most mask frames,
    then the largest); each one joins the first-ranked earlier piece it is near (see _near) in more than `share` of the
    mask frames they have in common, otherwise it starts a piece of its own. Nearness is tested against the piece's
    main track, not its grown union, so a person's face collects its chest logo and lettering without a chain of
    fragments pulling in the next person. A join that would make a piece wider than `max_w` of the frame or taller than
    `max_h` of it is not made (when width/height are given). Returns the pieces ranked the same way."""
    def area(t):
        return sum((b[2] - b[0]) * (b[3] - b[1]) for b in t.values()) / len(t)

    ranked = sorted((dict(t) for t in tracks), key=lambda t: (-len(t), -area(t)))
    pieces = []  # each {"core": main track, "all": union track}
    for t in ranked:
        best = None
        for pc in pieces:
            shared = set(t) & set(pc["core"])
            if not shared:
                continue
            ratio = sum(1 for k in shared if _near(pc["core"][k], t[k], margin, min_pad)) / len(shared)
            if ratio <= share or (best is not None and ratio <= best[0]):
                continue
            combo = dict(pc["all"])
            for k, box in t.items():
                combo[k] = box if k not in combo else _union(combo[k], box)
            if width and height:
                boxes = list(combo.values())
                if max(b[2] - b[0] for b in boxes) > max_w * width or max(b[3] - b[1] for b in boxes) > max_h * height:
                    continue
            best = (ratio, pc, combo)
        if best is None:
            pieces.append({"core": t, "all": t})
        else:
            best[1]["all"] = best[2]
    return [pc["all"] for pc in pieces]


def track_path(track, n, k_count, width, height, margin, min_pad, smooth=9):
    """Fixed piece size and one top-left position per video frame for a track. The size is the largest box the object
    ever had plus margin, so it is as tight as a hand-set box around the object itself, not around its whole walk. The
    centre follows the detections (linear between mask frames, held before the first and after the last), smoothed so
    the piece does not jitter, and clamped to stay inside the frame."""
    import numpy as np
    ks = sorted(track)
    boxes = [track[k] for k in ks]
    bw = max(b[2] - b[0] for b in boxes)
    bh = max(b[3] - b[1] for b in boxes)
    pw = min(width, int(round(bw + 2 * max(min_pad, bw * margin))))
    ph = min(height, int(round(bh + 2 * max(min_pad, bh * margin))))
    tks = [round(k * (n - 1) / (k_count - 1)) if k_count > 1 else 0 for k in ks]
    frames = np.arange(n)
    cx = np.interp(frames, tks, [_center(b)[0] for b in boxes])
    cy = np.interp(frames, tks, [_center(b)[1] for b in boxes])
    if smooth > 1 and n > 1:
        half = smooth // 2
        kernel = np.ones(smooth) / smooth
        cx = np.convolve(np.pad(cx, half, mode="edge"), kernel, mode="valid")
        cy = np.convolve(np.pad(cy, half, mode="edge"), kernel, mode="valid")
    xs = np.clip(np.round(cx - pw / 2), 0, width - pw).astype(int)
    ys = np.clip(np.round(cy - ph / 2), 0, height - ph).astype(int)
    return pw, ph, [[int(x), int(y)] for x, y in zip(xs, ys)]


def pack_shelves(sizes, gutter):
    """Shelf-pack piece sizes [(w, h)] into one canvas of about 16:9; returns positions and the canvas size on the
    32 px grid."""
    total = sum((w + gutter) * (h + gutter) for w, h in sizes)
    target = max(max(w for w, _ in sizes) + gutter, math.sqrt(total * 16 / 9))
    order = sorted(range(len(sizes)), key=lambda i: -sizes[i][1])
    pos = [None] * len(sizes)
    x = y = shelf = 0
    canvas_w = 0
    for i in order:
        w, h = sizes[i]
        if x and x + w > target:
            y += shelf + gutter
            x = shelf = 0
        pos[i] = (x, y)
        x += w + gutter
        shelf = max(shelf, h)
        canvas_w = max(canvas_w, x - gutter)
    canvas_h = y + shelf
    return pos, 32 * math.ceil(canvas_w / 32), 32 * math.ceil(canvas_h / 32)


def _layout(src_sizes, scale, gutter):
    sizes = [(max(16, round(w * scale / 16) * 16), max(16, round(h * scale / 16) * 16)) for w, h in src_sizes]
    pos, cw, ch = pack_shelves(sizes, gutter)
    return sizes, pos, cw, ch


def choose_scale(src_sizes, megapixels, max_scale, target_scale, gutter, priority=None):
    """Pick which pieces to keep (indices into src_sizes, largest first) and one enlargement for all of them. Aim for
    `target_scale` (readable lettering needs about 2x or more) and use any room left up to `max_scale`; when the canvas
    would exceed the budget at the target, give up the last pieces of `priority` one by one (best first; default
    largest first); a single piece that still does not fit gets the largest scale that does."""
    budget = megapixels * 1_000_000 * 1.05
    keep = list(priority) if priority is not None else sorted(range(len(src_sizes)), key=lambda i: -src_sizes[i][0] * src_sizes[i][1])

    def fits(idx, s):
        _sizes, _pos, cw, ch = _layout([src_sizes[i] for i in idx], s, gutter)
        return cw * ch <= budget

    def largest_fit(idx, lo, hi):
        if fits(idx, hi):
            return hi
        for _ in range(14):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if fits(idx, mid) else (lo, mid)
        return lo

    while True:
        if fits(keep, target_scale):
            return keep, largest_fit(keep, target_scale, max_scale)
        if len(keep) == 1:
            return keep, largest_fit(keep, 0.25, target_scale)
        keep.pop()


class CreativeFieldDetailAtlas:
    CATEGORY = "CreativeField"
    DESCRIPTION = ("Follow every separate masked area (faces, logos, signs) through a clip, cut a tight piece around each "
                   "out of every frame and out of the start picture, enlarge all pieces by one factor and pack them into "
                   "one canvas of about the given megapixels, so a single re-sample sharpens all of them. Wire Detail "
                   "Atlas Paste after the decode.")
    RETURN_TYPES = ("IMAGE", "IMAGE", "STRING")
    RETURN_NAMES = ("frames", "reference", "plan")
    FUNCTION = "cut"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",), "mask": ("MASK",), "reference": ("IMAGE",),
            "megapixels": ("FLOAT", {"default": 1.6, "min": 0.25, "max": 2.0, "step": 0.05}),
            "max_scale": ("FLOAT", {"default": 4.0, "min": 1.0, "max": 6.0, "step": 0.1}),
            "margin": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 2.0, "step": 0.05,
                                 "tooltip": "Added on every side of an area, as a share of its largest size in the clip."}),
            "min_pad": ("INT", {"default": 12, "min": 0, "max": 256}),
            "max_pieces": ("INT", {"default": 10, "min": 1, "max": 16}),
            "gutter": ("INT", {"default": 32, "min": 0, "max": 128, "step": 16}),
            "min_scale": ("FLOAT", {"default": 1.25, "min": 1.0, "max": 4.0, "step": 0.05}),
            "target_scale": ("FLOAT", {"default": 2.4, "min": 1.0, "max": 6.0, "step": 0.1,
                                       "tooltip": "Enlargement to aim for; the smallest pieces are dropped when the canvas would not fit the megapixels."}),
        }}

    def cut(self, images, mask, reference, megapixels=1.6, max_scale=4.0, margin=0.15, min_pad=12, max_pieces=10,
            gutter=32, min_scale=1.25, target_scale=2.4):
        n, h, w = images.shape[0], images.shape[1], images.shape[2]
        m = mask.reshape(-1, mask.shape[-2], mask.shape[-1]).float().cpu().numpy()
        k_count = m.shape[0]
        sx, sy = w / m.shape[2], h / m.shape[1]
        tracks = link_tracks([mask_components(m[k], sx, sy) for k in range(k_count)])
        if k_count >= 3:
            tracks = [t for t in tracks if len(t) >= 2]
        before = len(tracks)
        tracks = merge_tracks(tracks, margin, min_pad, width=w, height=h)
        paths = [track_path(t, n, k_count, w, h, margin, min_pad) for t in tracks]
        present = [len(t) for t in tracks]
        found = len(paths)
        keep, scale = [], 0.0
        if paths:
            # Rank: present in the most mask frames first (flicker is junk), then the largest.
            keep = sorted(range(found), key=lambda i: (-present[i], -paths[i][0] * paths[i][1]))[:max_pieces]
            order, scale = choose_scale([(paths[i][0], paths[i][1]) for i in keep], megapixels, max_scale, target_scale, gutter,
                                        priority=list(range(len(keep))))
            keep = [keep[i] for i in order]
        if not keep or scale < min_scale:
            print(f"[CreativeFieldDetailAtlas] skip: {found} track(s), enlargement {scale:.2f}x below {min_scale}x")
            dummy = images[:, :256, :256]
            return (_resize(dummy, 256, 256), reference[:1, :256, :256], json.dumps({"skip": True, "pieces": []}))
        sizes, pos, cw, ch = _layout([(paths[i][0], paths[i][1]) for i in keep], scale, gutter)
        canvas = images.new_zeros((n, ch, cw, 3)) + images.mean(dim=(0, 1, 2), keepdim=True)
        rh, rw = reference.shape[1], reference.shape[2]
        ref_canvas = reference.new_zeros((1, ch, cw, 3)) + reference[:1].mean(dim=(0, 1, 2), keepdim=True)
        kx, ky = rw / w, rh / h
        pieces = []
        for i, (pw_a, ph_a), (ax, ay) in zip(keep, sizes, pos):
            pw, ph, path = paths[i]
            for t0 in range(0, n, 16):
                t1 = min(n, t0 + 16)
                crops = torch.stack([images[t, path[t][1]:path[t][1] + ph, path[t][0]:path[t][0] + pw] for t in range(t0, t1)])
                canvas[t0:t1, ay:ay + ph_a, ax:ax + pw_a] = _resize(crops, pw_a, ph_a)
            x0, y0 = path[0]
            rx0, ry0 = min(rw - 1, round(x0 * kx)), min(rh - 1, round(y0 * ky))
            rx1, ry1 = max(rx0 + 1, round((x0 + pw) * kx)), max(ry0 + 1, round((y0 + ph) * ky))
            ref_canvas[:, ay:ay + ph_a, ax:ax + pw_a] = _resize(reference[:1, ry0:ry1, rx0:rx1], pw_a, ph_a)
            pieces.append({"w": pw, "h": ph, "ax": ax, "ay": ay, "aw": pw_a, "ah": ph_a, "path": path})
        print(f"[CreativeFieldDetailAtlas] {before} track(s), {found} after merge, {len(pieces)} piece(s) kept, {found - len(pieces)} dropped, "
              f"{[(p['w'], p['h']) for p in pieces]} at {scale:.2f}x into {cw}x{ch} ({cw * ch / 1e6:.2f} MP), {n} frames")
        return (canvas, ref_canvas, json.dumps({"skip": False, "width": w, "height": h, "pieces": pieces}))


class CreativeFieldDetailAtlasPaste:
    CATEGORY = "CreativeField"
    DESCRIPTION = "Put every re-sampled piece of a Detail Atlas back where its object was in each frame, through a feathered edge."
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "paste"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",), "detail": ("IMAGE",), "plan": ("STRING", {"forceInput": True}),
            "feather": ("INT", {"default": 16, "min": 0, "max": 128, "step": 1}),
        }}

    def paste(self, images, detail, plan, feather=16):
        p = json.loads(plan)
        if p.get("skip"):
            return (images,)
        if images.shape[1] != p["height"] or images.shape[2] != p["width"]:
            print("[CreativeFieldDetailAtlasPaste] frame size differs from the plan; frames passed through")
            return (images,)
        n = min(images.shape[0], detail.shape[0])
        out = images.clone()
        for piece in p["pieces"]:
            bw, bh, path = piece["w"], piece["h"], piece["path"]
            ax, ay, aw, ah = piece["ax"], piece["ay"], piece["aw"], piece["ah"]
            count = min(n, len(path))
            f = min(feather, bw // 4, bh // 4)
            yy = torch.arange(bh, dtype=torch.float32)[:, None]
            xx = torch.arange(bw, dtype=torch.float32)[None, :]
            edge = torch.minimum(torch.minimum(xx, bw - 1 - xx), torch.minimum(yy, bh - 1 - yy))
            alpha = ((edge / f).clamp(0, 1) if f else torch.ones((bh, bw)))[:, :, None]
            for i in range(0, count, 16):
                j = min(count, i + 16)
                crops = _resize(detail[i:j, ay:ay + ah, ax:ax + aw].float(), bw, bh)
                for t in range(i, j):
                    x, y = path[t]
                    region = out[t, y:y + bh, x:x + bw]
                    out[t, y:y + bh, x:x + bw] = alpha * crops[t - i] + (1 - alpha) * region
        print(f"[CreativeFieldDetailAtlasPaste] {len(p['pieces'])} piece(s) put back on {n} of {images.shape[0]} frames")
        return (out,)


NODE_CLASS_MAPPINGS = {"CreativeFieldDetailBox": CreativeFieldDetailBox, "CreativeFieldDetailPaste": CreativeFieldDetailPaste,
                       "CreativeFieldDetailAtlas": CreativeFieldDetailAtlas, "CreativeFieldDetailAtlasPaste": CreativeFieldDetailAtlasPaste}
NODE_DISPLAY_NAME_MAPPINGS = {"CreativeFieldDetailBox": "CreativeField Detail Box", "CreativeFieldDetailPaste": "CreativeField Detail Paste",
                              "CreativeFieldDetailAtlas": "CreativeField Detail Atlas", "CreativeFieldDetailAtlasPaste": "CreativeField Detail Atlas Paste"}
