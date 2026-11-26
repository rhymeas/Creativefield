"""CreativeField grading for the H3 Editor: a project look (a .cube LUT with a strength, exposure, contrast,
saturation, warmth, grain, a soft finish), per-clip corrections, and matching every clip to a reference shot.

State lives in the project file, so every change is an editor operation with a revision:
  project["grade"] = {"look": asset or None, "look_strength", "exposure", "contrast", "saturation", "warmth", "grain", "soft",
                      "match": {"reference": clip id, "strength"} or None}
  clip["grade"]    = {"match_lut": asset or None, "exposure", "contrast", "saturation", "warmth", "skip_look": bool,
                      "skip_match": bool (the clip keeps its own colours when matching)}
A clip value is added to the project's (exposure, warmth) or multiplies it (contrast, saturation).
Applied at export, per clip in this order: match LUT, look LUT, exposure, contrast and saturation, warmth; then over
the whole cut the soft finish (on by default) and grain last. Installed beside the editor by scripts/h3-editor-cf/apply.py (GPL-3.0, like the editor).
"""
import hashlib
import os

try:
    import numpy as np
except ImportError:      # the export works without numpy; only matching needs it
    np = None

OPS = ("set_grade", "update_clip_grade")
LIMITS = {"look_strength": (0.0, 1.0), "exposure": (-1.5, 1.5), "contrast": (0.5, 1.5), "saturation": (0.0, 2.0),
          "warmth": (-1.0, 1.0), "grain": (0.0, 1.0), "soft": (0.0, 0.3)}
NEUTRAL = {"look_strength": 1.0, "exposure": 0.0, "contrast": 1.0, "saturation": 1.0, "warmth": 0.0, "grain": 0.0}
PROJECT_FIELDS = ("look", "match") + tuple(LIMITS)
# The soft finish (user, 2026-11-26): a super subtle denoise, a faint mist (a blurred copy screened over the picture,
# which lifts the shadows and softens skin) and a subtle sharpen after it, so edges and lettering stay crisp. Chosen by
# eye over "as is" and over a plain blur on three finals; clearly better on faces, a little flatter on dark low-key
# shots, where it can be turned down or off (0). A project that never set it gets SOFT_DEFAULT.
SOFT_DEFAULT = 0.10
CLIP_FIELDS = ("match_lut", "exposure", "contrast", "saturation", "warmth", "skip_look", "skip_match")
LUT_SIZE = 33
CUBE_LIMIT = 65


# ---- cleaning -------------------------------------------------------------------------------------------------------

def _number(fields, key, limits):
    value = fields[key]
    low, high = limits
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise ValueError("%s is a number from %g to %g" % (key, low, high))
    return round(float(value), 3)


def _asset(value, what):
    if value is None:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("file"), str) or not value["file"].lower().endswith(".cube"):
        raise ValueError("%s is a .cube LUT uploaded to the project: {file, subfolder}" % what)
    out = {"file": os.path.basename(value["file"])}
    if isinstance(value.get("subfolder"), str) and value["subfolder"]:
        out["subfolder"] = value["subfolder"].replace("\\", "/")
    if isinstance(value.get("name"), str) and value["name"].strip():
        out["name"] = value["name"].strip()[:60]    # the file name the user uploaded, to show
    return out


def _unknown(fields, allowed):
    extra = sorted(set(fields) - set(allowed))
    if extra:
        raise ValueError("unknown grade fields: %s (use %s)" % (", ".join(extra), ", ".join(allowed)))


def clean_project_grade(fields, clip_ids):
    _unknown(fields, PROJECT_FIELDS)
    out = {}
    for key in LIMITS:
        if key in fields:
            out[key] = _number(fields, key, LIMITS[key])
    if "look" in fields:
        out["look"] = _asset(fields["look"], "look")
    if "match" in fields:
        match = fields["match"]
        if match is None:
            out["match"] = None
        else:
            if not isinstance(match, dict) or match.get("reference") not in clip_ids:
                raise ValueError("match is {reference: a clip of this project, strength: 0 to 1}")
            out["match"] = {"reference": match["reference"],
                            "strength": _number({"strength": match.get("strength", 0.8)}, "strength", (0.0, 1.0))}
    return out


def clean_clip_grade(fields):
    _unknown(fields, CLIP_FIELDS)
    out = {}
    for key in ("exposure", "warmth"):
        if key in fields:
            out[key] = _number(fields, key, LIMITS[key])
    for key in ("contrast", "saturation"):
        if key in fields:
            out[key] = _number(fields, key, LIMITS[key])
    for key in ("skip_look", "skip_match"):
        if key in fields:
            if not isinstance(fields[key], bool):
                raise ValueError("%s is true or false" % key)
            out[key] = fields[key]
    if "match_lut" in fields:
        out["match_lut"] = _asset(fields["match_lut"], "match_lut")
    return out


def apply_op(project, op, resolve):
    """set_grade {fields} changes the project look; update_clip_grade {clip, fields} one clip's corrections."""
    fields = op.get("fields")
    if not isinstance(fields, dict):
        raise ValueError("%s needs fields" % op["op"])
    clips = {c["id"]: c for c in project.get("clips", [])}
    if op["op"] == "set_grade":
        grade = {**NEUTRAL, "look": None, "match": None, **(project.get("grade") or {})}
        grade.update(clean_project_grade(fields, clips))
        project["grade"] = grade
        return {"grade": grade}
    clip_id = resolve(op.get("clip"), "clip")
    if clip_id not in clips:
        raise KeyError("no clip %s" % clip_id)
    grade = dict(clips[clip_id].get("grade") or {})
    grade.update(clean_clip_grade(fields))
    clips[clip_id]["grade"] = {k: v for k, v in grade.items() if v is not None}
    return {"clip": clip_id}


# ---- export ---------------------------------------------------------------------------------------------------------

def output_file(asset):
    import folder_paths   # ComfyUI's; only present inside the worker
    base = os.path.realpath(folder_paths.get_output_directory())
    path = os.path.realpath(os.path.join(base, asset.get("subfolder") or "", os.path.basename(asset["file"])))
    if not path.startswith(base + os.sep):
        raise ValueError("that LUT is outside the output folder")
    return path


def graph_path(path):
    """A file path as an ffmpeg filter graph reads it inside quotes (checked with ffmpeg 7.1 on Windows)."""
    return path.replace("\\", "/").replace(":", "\\:").replace("'", "")


def read_cube(text):
    """(size, rows) of a 3D .cube LUT; rows are [r, g, b] with red changing fastest. Raises on anything else."""
    size, rows = None, []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.split()[0] in ("TITLE", "DOMAIN_MIN", "DOMAIN_MAX"):
            continue
        if line.startswith("LUT_1D_SIZE"):
            raise ValueError("that is a 1D LUT; use a 3D .cube LUT")
        if line.startswith("LUT_3D_SIZE"):
            size = int(line.split()[1])
            continue
        parts = line.split()
        if len(parts) == 3:
            rows.append([float(v) for v in parts])
    if not size or not 2 <= size <= CUBE_LIMIT:
        raise ValueError("a .cube LUT names LUT_3D_SIZE from 2 to %d" % CUBE_LIMIT)
    if len(rows) != size ** 3:
        raise ValueError("the LUT has %d rows; LUT_3D_SIZE %d needs %d" % (len(rows), size, size ** 3))
    return size, rows


def write_cube(size, rows, title="CreativeField"):
    lines = ['TITLE "%s"' % title, "LUT_3D_SIZE %d" % size]
    lines += ["%.6f %.6f %.6f" % tuple(min(1.0, max(0.0, v)) for v in row) for row in rows]
    return "\n".join(lines) + "\n"


def blended(path, strength):
    """The LUT at path mixed with no change by strength, cached beside it. strength 1 is the file itself."""
    if strength >= 0.999:
        return path
    target = "%s.cf%03d.cube" % (os.path.splitext(path)[0], int(round(strength * 100)))
    if not os.path.exists(target) or os.path.getmtime(target) < os.path.getmtime(path):
        with open(path, encoding="utf-8", errors="replace") as f:
            size, rows = read_cube(f.read())
        out = []
        for index, row in enumerate(rows):
            r, g, b = index % size, (index // size) % size, index // (size * size)
            ident = (r / (size - 1.0), g / (size - 1.0), b / (size - 1.0))
            out.append([ident[c] + (row[c] - ident[c]) * strength for c in range(3)])
        with open(target, "w", encoding="utf-8") as f:
            f.write(write_cube(size, out, "blend %d%%" % int(round(strength * 100))))
    return target


def settings(project, clip):
    """The grade one clip gets: the project's values with the clip's corrections on top."""
    base = dict(NEUTRAL, **{k: v for k, v in (project.get("grade") or {}).items() if k in NEUTRAL})
    own = clip.get("grade") or {}
    return {
        "exposure": base["exposure"] + own.get("exposure", 0.0),
        "contrast": base["contrast"] * own.get("contrast", 1.0),
        "saturation": base["saturation"] * own.get("saturation", 1.0),
        "warmth": max(-1.0, min(1.0, base["warmth"] + own.get("warmth", 0.0))),
        "look": None if own.get("skip_look") else (project.get("grade") or {}).get("look"),
        "look_strength": base["look_strength"],
        "match_lut": own.get("match_lut") if (project.get("grade") or {}).get("match") and not own.get("skip_match") else None,
    }


def item_filters(project, clip, locate=output_file):
    """ffmpeg filters for one clip, to follow its trim and speed; empty when it has no grade."""
    if not project.get("grade") and not clip.get("grade"):
        return ""
    s, chain = settings(project, clip), []
    for asset, strength in ((s["match_lut"], 1.0), (s["look"], s["look_strength"])):
        if asset and strength > 0:
            path = locate(asset)
            if os.path.exists(path):
                chain.append("lut3d=file='%s':interp=tetrahedral" % graph_path(blended(path, strength)))
    if abs(s["exposure"]) > 0.001:
        chain.append("exposure=exposure=%.3f" % s["exposure"])
    if abs(s["contrast"] - 1) > 0.001 or abs(s["saturation"] - 1) > 0.001:
        chain.append("eq=contrast=%.3f:saturation=%.3f" % (s["contrast"], s["saturation"]))
    if abs(s["warmth"]) > 0.001:
        # 6500 K leaves the picture as it is; lower is warmer (checked: 3500 K turns grey orange).
        chain.append("colortemperature=temperature=%d" % int(round(6500 - 3000 * s["warmth"])))
    return "".join("," + f for f in chain)


def grain_graph(source, target, width, height, grain, fps=24):
    """Filter-graph pieces that lay film grain over [source] as [target]. The grain is a grey plate with noise, drawn at
    a third of the size and changed every second frame, laid on with overlay so the colours stay: it looks like film
    grain and keeps the file about two times its size instead of six to eight (measured on the heist cut, crf 16)."""
    if grain <= 0:
        return []
    plate = max(2, int(width) // 3 // 2 * 2)
    return ["[%s]split[%sa][%sb]" % (source, target, target),
            "[%sb]fps=%d,scale=%d:-2,lutyuv=y=128:u=128:v=128,noise=c0s=24:c0f=t,fps=%d,scale=%d:%d:flags=bicubic[%sn]"
            % (target, max(1, fps // 2), plate, fps, width, height, target),
            "[%sa][%sn]blend=c0_mode=overlay:c0_opacity=%.3f:c1_expr=A:c2_expr=A[%s]" % (target, target, 0.5 * grain, target)]


def soft_amount(project):
    """The project's soft finish, SOFT_DEFAULT when it never set one."""
    value = (project.get("grade") or {}).get("soft")
    return SOFT_DEFAULT if value is None else float(value)


def soft_graph(source, target, width, soft):
    """Filter-graph pieces for the soft finish over [source] as [target]: denoise, mist at strength soft, sharpen.
    The mist's blur follows the picture's width (sigma 18 at 1920), so a still or a smaller export looks the same."""
    if soft <= 0:
        return []
    sigma = max(1.0, 18.0 * int(width) / 1920.0)
    return ["[%s]hqdn3d=1.5:1.5:3:3,format=gbrp,split[%sa][%sb]" % (source, target, target),
            "[%sb]gblur=sigma=%.1f[%sm]" % (target, sigma, target),
            "[%sa][%sm]blend=all_mode=screen:all_opacity=%.3f,format=yuv420p,unsharp=5:5:0.45:5:5:0[%s]"
            % (target, target, soft, target)]


def finish_video(project, chains, video, width=1920, height=1088):
    """The soft finish, then grain, over the whole cut, after the VFX clips. Returns the label of the picture to map."""
    soft = soft_graph(video, "cfsoft", width, soft_amount(project))
    if soft:
        chains.extend(soft)
        video = "cfsoft"
    grain = float((project.get("grade") or {}).get("grain") or 0.0)
    pieces = grain_graph(video, "cfgrain", width, height, grain)
    if not pieces:
        return video
    chains.extend(pieces)
    return "cfgrain"


# ---- matching -------------------------------------------------------------------------------------------------------
# Every clip gets a LUT that moves its colour statistics onto the reference's in Lab (Reinhard et al. 2001): the mean
# and spread of lightness and of the two colour axes. strength mixes the result with no change, so a night shot keeps
# some of its night.

def _lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


_M = None


def _matrices():
    global _M
    if _M is None:
        to_xyz = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
        _M = (to_xyz, np.linalg.inv(to_xyz), np.array([0.95047, 1.0, 1.08883]))
    return _M


def rgb_to_lab(rgb):
    to_xyz, _, white = _matrices()
    xyz = _lin(rgb) @ to_xyz.T / white
    f = np.where(xyz > 216 / 24389.0, np.cbrt(xyz), (24389 / 27.0 * xyz + 16) / 116.0)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def lab_to_rgb(lab):
    _, to_rgb, white = _matrices()
    fy = (lab[..., 0] + 16) / 116.0
    f = np.stack([fy + lab[..., 1] / 500.0, fy, fy - lab[..., 2] / 200.0], -1)
    xyz = np.where(f ** 3 > 216 / 24389.0, f ** 3, (116 * f - 16) / (24389 / 27.0)) * white
    return _srgb(xyz @ to_rgb.T)


def stats(pixels):
    """Mean and spread of Lab over pixels (an N x 3 array of 0..255 RGB), ignoring the outer 1 % of lightness."""
    lab = rgb_to_lab(np.asarray(pixels, dtype=np.float64).reshape(-1, 3) / 255.0)
    low, high = np.percentile(lab[:, 0], [1, 99])
    keep = lab[(lab[:, 0] >= low) & (lab[:, 0] <= high)]
    if len(keep) < 16:
        keep = lab
    return keep.mean(0).tolist(), np.maximum(keep.std(0), 1e-3).tolist()


def match_cube(source, reference, strength, size=LUT_SIZE):
    """A .cube that moves a clip with Lab stats source onto reference. Spreads change at most two times."""
    (ms, ss), (mr, sr) = source, reference
    ms, ss, mr, sr = (np.array(v) for v in (ms, ss, mr, sr))
    scale = np.clip(sr / ss, 0.5, 2.0)
    axis = np.linspace(0, 1, size)
    b, g, r = np.meshgrid(axis, axis, axis, indexing="ij")
    rgb = np.stack([r, g, b], -1).reshape(-1, 3)      # red changes fastest, as .cube wants
    lab = rgb_to_lab(rgb)
    moved = (lab - ms) * scale + mr
    out = lab_to_rgb(lab + (moved - lab) * strength)
    return write_cube(size, out.tolist(), "match %d%%" % int(round(strength * 100)))


def cube_name(clip_id, reference, strength, take):
    key = "%s|%s|%.3f|%s" % (clip_id, reference, strength, take)
    return "match_%s.cube" % hashlib.sha1(key.encode()).hexdigest()[:12]
