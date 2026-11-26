"""Checks for rendering a clip again from its notes. Run with any Python 3: python scripts/h3-editor-cf/test_cf_region.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cf_region  # noqa: E402

TAKE = {"id": "t1", "file": "c_t1.mp4", "subfolder": "h3take_projects/p/clips", "frames": 124}
CLIP = {"id": "c1", "seed": 3}
NOTES = [
    {"id": "n2", "clip": "c1", "take": "t1", "frame": 40, "status": "open", "text": "a red door",
     "shape": {"type": "pin", "x": 0.5, "y": 0.5}},
    {"id": "n1", "clip": "c1", "take": "t1", "frame": 0, "status": "open", "text": "paint the cabin red",
     "shape": {"type": "rect", "x": 0.4, "y": 0.2, "w": 0.4, "h": 0.4}},
    {"id": "n3", "clip": "c1", "take": "t0", "frame": 0, "status": "open", "text": "older take", "shape": {"type": "pin", "x": 0.1, "y": 0.1}},
    {"id": "n4", "clip": "c1", "take": "t1", "frame": 0, "status": "resolved", "text": "done", "shape": {"type": "pin", "x": 0.1, "y": 0.1}},
    {"id": "n5", "clip": "c1", "take": "t1", "frame": 0, "status": "open", "text": "no mark", "shape": None},
]


def draft_graph():
    """The nodes a standard draft graph has around the take, with its refine chain (80 to 91)."""
    return {
        "10": {"class_type": "H3Take", "inputs": {"width": 1024, "height": 576, "length": 124, "prompt": "p",
                                                  "start_image": ["40", 0], "anchor": "start"}},
        "15": {"class_type": "SamplerCustomAdvanced", "inputs": {"latent_image": ["10", 1]}},
        "16": {"class_type": "VAEDecode", "inputs": {"samples": ["15", 0]}},
        "18": {"class_type": "CreateVideo", "inputs": {"images": ["91", 0]}},
        "20": {"class_type": "H3SaveHold", "inputs": {"latent": ["15", 0], "final": ["90", 0]}},
        "80": {"class_type": "EmptyMiniMaxH3LatentAV", "inputs": {"width": 1472, "height": 832, "length": 124}},
        "83": {"class_type": "H3RefineLatent", "inputs": {"take": ["80", 0]}},
        "88": {"class_type": "BasicGuider", "inputs": {"conditioning": ["10", 0]}},
        "90": {"class_type": "SamplerCustomAdvanced", "inputs": {"guider": ["88", 0], "latent_image": ["83", 0]}},
        "91": {"class_type": "VAEDecode", "inputs": {"samples": ["90", 0]}},
    }


def test_from_notes():
    edit = cf_region.from_notes({"notes": NOTES}, CLIP, TAKE)
    assert edit["notes"] == ["n1", "n2"] and edit["frame"] == 0 and edit["frames"] == 124
    assert edit["boxes"][0] == {"x": 0.4, "y": 0.2, "w": 0.4, "h": 0.4, "instruction": "paint the cabin red"}
    pin = edit["boxes"][1]
    assert abs(pin["x"] - 0.41) < 1e-9 and abs(pin["w"] - 0.18) < 1e-9   # a pin is a box around it
    assert cf_region.from_notes({"notes": NOTES[2:]}, CLIP, TAKE) is None   # nothing open and marked on this take


def test_route_holds_and_pastes_back():
    edit = cf_region.from_notes({"notes": NOTES}, CLIP, TAKE)
    graph = cf_region.route(draft_graph(), {"style": "Live-action"}, dict(CLIP, cf_region=edit))
    take = graph["10"]["inputs"]
    assert take["video_mode"] == "v2v" and take["keep"] == 0.0 and take["source_video"] == ["6", 0]
    assert take["region"][0] in graph and "Region 1: paint the cabin red." in take["prompt"]
    assert take["start_image"] == ["990", 0] and graph["990"]["inputs"]["width"] == 1024   # anchor at the take's size
    # the standard draft's refine chain is gone; the boxes go back into the source at its size
    assert not any(k in graph for k in cf_region.REFINE_CHAIN)
    assert graph["18"]["inputs"]["images"] == ["1000", 0]
    assert graph["1000"]["inputs"]["destination"] == ["6", 0] and "final" not in graph["20"]["inputs"]


def test_untouched_without_notes():
    graph = draft_graph()
    assert cf_region.route(graph, {}, CLIP) is graph and "80" in graph


if __name__ == "__main__":
    for name, test in sorted(globals().items()):
        if name.startswith("test_"):
            test()
            print("ok", name)
