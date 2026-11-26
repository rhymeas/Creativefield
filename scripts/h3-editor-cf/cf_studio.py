"""CreativeField additions to the H3 Editor's sound: fade in and fade out on extra sounds.

Installed beside the editor by scripts/h3-editor-cf/apply.py, which adds small checked hooks to project.py.
Kept in its own module so the upstream files change as little as possible (GPL-3.0, like the editor).
"""

FADE_FIELDS = ("fade_in", "fade_out")
FADE_LIMIT = 30.0   # seconds


def clean_fades(fields, seconds):
    """fade_in and fade_out are seconds, from 0 up to 30 and never longer than the file."""
    out = {}
    for key in FADE_FIELDS:
        if key not in fields:
            continue
        value = fields[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= min(FADE_LIMIT, float(seconds)):
            raise ValueError("%s is seconds, from 0 to %g and no longer than the sound" % (key, min(FADE_LIMIT, float(seconds))))
        out[key] = round(float(value), 2)
    return out


def fade_chain(row, fps):
    """The ffmpeg filters for a sound's fades, to follow its volume filter. Empty when it has none.

    The two fades together never take more than the part of the file that plays: each is cut down to fit.
    """
    playing = max(0.0, float(row.get("frames") or 0) / float(fps))
    fade_in = float(row.get("fade_in") or 0.0)
    fade_out = float(row.get("fade_out") or 0.0)
    if fade_in + fade_out > playing:   # shared out in the ratio they were asked for
        share = playing / (fade_in + fade_out)
        fade_in, fade_out = fade_in * share, fade_out * share
    chain = ""
    if fade_in > 0:
        chain += ",afade=t=in:st=0:d=%.3f" % fade_in
    if fade_out > 0:
        chain += ",afade=t=out:st=%.3f:d=%.3f" % (playing - fade_out, fade_out)
    return chain


def fade_summary(row):
    """The fades as the project summary lists them."""
    return {key: row.get(key, 0.0) for key in FADE_FIELDS}


def latent_upscaler(name, available=None):
    """The installed copy of the editor's latent upscaler: it asks for the bf16 file, ComfyUI installs may hold the
    same model as fp16. None when neither is installed; the name itself when nothing is known (as the editor does)."""
    if not name:
        return None
    if available is None or name in available:
        return name
    for other in (name.replace("_bf16.", "_fp16."), name.replace("_fp16.", "_bf16.")):
        if other in available:
            return other
    return None


# The standard draft: a Film Studio draft takes the app's chosen video route (,)
# instead of the editor's 640x352 sketch. It is sampled at about 1024 px with the final's steps, then enlarged by
# MiniMax's latent upscaler and redrawn from sigma 0.42, the app's finish (about 100 s). A straight 1024 render
# (63 s) was tried and turned down by the user (2026-11-25): the sharper refined draft is worth the seconds.
# Small and medium stay as quick previews.
STANDARD = "standard"
STANDARD_SIZES = {   # format: (sampled at, comes out at); every side a multiple of 32, as H3's latent needs
    "16:9": ((1024, 576), (1472, 832)),
    "9:16": ((576, 1024), (832, 1472)),
    "1:1": ((768, 768), (1088, 1088)),
}
STANDARD_TAIL = "0.42, 0.0"


def standard_out(project):
    """The size a standard draft comes out at in this project's format."""
    shape = project.get("format") if project.get("format") in STANDARD_SIZES else "16:9"
    return STANDARD_SIZES[shape][1]


# Inputs that make a take hold something at its own size (pinned pictures, held video or sound, a carried latent).
# The refine needs those again at the larger size, so a take with any of them keeps its second take.
HELD_INPUTS = ("start_image", "end_image", "mid_images", "mid_image", "source_video", "end_video", "end_audio",
               "source_hold", "end_hold", "carry", "source_audio", "ref_videos", "ref_video", "ref_video_audios",
               "ref_video_audio")


def reuse_first_encode(graph):
    """A refined draft whose take holds nothing redraws with the first pass's conditioning.

    add_refine builds a second take at the refine size, which encodes the prompt and pictures again and, with the
    32B text encoder and the video model not fitting together, reloads the video model twice. With nothing held,
    that take only gives the same conditioning and an empty latent, so it becomes an empty latent at that size and
    the redraw reads node 10's conditioning: the same picture (SSIM 0.98) about 20 s sooner. Returns True if used."""
    take, second = graph.get("10", {}), graph.get("80", {})
    if take.get("class_type") != "H3Take" or second.get("class_type") != "H3Take" or "88" not in graph:
        return False
    inputs = take["inputs"]
    # Growable inputs arrive dotted, as ref_images.ref_image_0 or mid_images.mid_image_0: the name before the dot counts.
    if any(name.split(".")[0] in HELD_INPUTS for name in inputs) or inputs.get("video_mode", "off") != "off":
        return False
    size = {name: second["inputs"][name] for name in ("width", "height", "length")}
    graph["80"] = {"class_type": "EmptyMiniMaxH3LatentAV", "inputs": size}
    graph["83"]["inputs"]["take"] = ["80", 0]
    graph["88"]["inputs"]["conditioning"] = ["10", 0]
    return True


def shot_from_footage(project, clip_id):
    """Imported footage becomes a shot that renders like any clip (user, 2026-11-25: "should always work").

    The footage stays as a take, marked footage, so it keeps playing until a render replaces it and the Takes list
    can always switch back. The editor puts the clip's first frame on the timeline into its "first" before the
    first render, so a re-render starts where the footage starts; prompt and cast are written like any shot's."""
    clip = next((c for c in project.get("clips", []) if c.get("id") == clip_id), None)
    if clip is None:
        raise ValueError("there is no clip %s" % clip_id)
    if clip.get("kind") != "footage":
        raise ValueError("%s is already a shot" % clip.get("name", "this clip"))
    for take in clip.get("takes", []):
        take["footage"] = True
    del clip["kind"]
    return {"clip": clip_id}
