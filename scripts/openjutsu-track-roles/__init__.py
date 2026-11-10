"""Resolve colliding or missing OpenJutsu roles from stable left-to-right masks."""

import json


class CreativeFieldOpenJutsuResolveRoles:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "track_data": ("SAM3_TRACK_DATA",),
            "segments": ("STRING", {"forceInput": True}),
            "labels": ("STRING", {"forceInput": True}),
            "left_to_right": ("STRING",),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("labels",)
    FUNCTION = "resolve"
    CATEGORY = "conditioning/minimax/experiments"

    def resolve(self, track_data, segments, labels, left_to_right):
        try:
            order = json.loads(left_to_right)
            data = json.loads(segments)
            assignments = json.loads(labels)
        except (TypeError, ValueError):
            return (labels,)
        if not isinstance(order, list) or any(type(role) is not int for role in order) or sorted(order) != [1, 2, 3]:
            return (labels,)
        if not isinstance(assignments, list) or len(assignments) != 3:
            return (labels,)
        if any(not isinstance(a, dict) or type(a.get("role")) is not int or a["role"] not in [0, *order] for a in assignments):
            return (labels,)
        observed = {a["role"] for a in assignments}
        missing = 0 in observed
        if missing and len(observed) != 3:
            return (labels,)
        collision = not missing and len(observed) != 3

        packed = track_data.get("packed_masks")
        if packed is None or packed.ndim != 4 or packed.shape[1] != 3 or not packed.shape[-1]:
            return (labels,)
        frame_count = packed.shape[0]
        tracks = [a.get("track") for a in assignments]
        if any(type(t) is not int for t in tracks) or sorted(tracks) != [0, 1, 2]:
            return (labels,)
        if any(a.get("start") != 0 or a.get("end") != frame_count for a in assignments):
            return (labels,)
        if not isinstance(data, dict) or data.get("shots") != [[0, frame_count]]:
            return (labels,)
        appearances = data.get("segments")
        if not isinstance(appearances, list) or len(appearances) != 3 or not all(
            isinstance(s, dict) and s.get("track") in tracks
            and type(s.get("first")) is int and type(s.get("last")) is int
            and 0 <= s["first"] < s["last"] <= frame_count
            for s in appearances
        ):
            return (labels,)
        if {s["track"] for s in appearances} != set(tracks) or frame_count == 0:
            return (labels,)
        if any(not isinstance(s.get("with"), list) or set(s["with"]) != {j for j in range(3) if j != i}
               for i, s in enumerate(appearances)):
            return (labels,)
        spans = {s["track"]: (s["first"], s["last"]) for s in appearances}
        full_span = (0, frame_count)
        if any(spans[a["track"]] != full_span for a in assignments if collision or not a["role"]):
            return (labels,)

        ranked = stable_track_order(packed, tracks, spans)
        if ranked is None:
            return (labels,)
        roles = dict(zip(ranked, order))
        # An unassigned track can be filled when the two existing assignments
        # confirm the explicit order. A conflict leaves the native result intact.
        if missing and any(a["role"] and roles[a["track"]] != a["role"] for a in assignments):
            return (labels,)
        if all(a["role"] == roles[a["track"]] for a in assignments):
            return (labels,)
        return (json.dumps([{**a, "role": roles[a["track"]]} for a in assignments]),)


def stable_track_order(packed, tracks, spans):
    """Require substantial shared visibility and the same order whenever two tracks are visible."""
    import torch
    from comfy.ldm.sam3.tracker import unpack_masks

    frames = packed.shape[0]
    first, last = zip(*(spans[t] for t in tracks))
    overlap_start, overlap_end = max(first), min(last)
    if (overlap_end - overlap_start) * 4 < frames * 3:
        return None
    time = torch.arange(frames)[:, None]
    visible = (time >= torch.tensor(first)) & (time < torch.tensor(last))
    width = packed.shape[-1] * 8
    x = torch.arange(width)
    centers = []
    block_size = 16
    for start in range(0, frames, block_size):
        chunk = packed[start:start + block_size]
        masks = unpack_masks(chunk[:, tracks].cpu())
        columns = masks.any(dim=-2)
        expected = visible[start:start + len(chunk)]
        if not (columns.any(dim=-1) | ~expected).all():
            return None
        left = torch.where(columns, x, width).amin(dim=-1)
        right = torch.where(columns, x, 0).amax(dim=-1)
        centers.append((left + right) / 2)
    centers = torch.cat(centers)
    rank = centers[overlap_start].argsort().tolist()
    ordered, present = centers[:, rank], visible[:, rank]
    # Test every visible pair, including when the middle track is off-screen.
    separated = ordered[:, None, :] - ordered[:, :, None] >= width * 0.04
    pairs = (present[:, :, None] & present[:, None, :]).triu(diagonal=1)
    if not (separated | ~pairs).all():
        return None
    return [tracks[i] for i in rank]


NODE_CLASS_MAPPINGS = {"CreativeFieldOpenJutsuResolveRoles": CreativeFieldOpenJutsuResolveRoles}
