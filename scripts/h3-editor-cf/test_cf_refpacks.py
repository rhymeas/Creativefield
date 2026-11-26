"""Checks for the RefPacks route. Run with any Python 3: python scripts/h3-editor-cf/test_cf_refpacks.py"""
import copy
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# cf_refs (imported by cf_refpacks) uses three helpers from the editor's prompting.py; outside the editor a stand-in.
if "prompting" not in sys.modules:
    _p = types.ModuleType("prompting")
    _p.DEFAULT_SOUND, _p.VOICE, _p.dialogue_line = "Quiet natural ambience.", "<Audio 1>", lambda *a, **k: ""
    sys.modules["prompting"] = _p
import cf_refpacks  # noqa: E402

MAYA = {"id": "p1", "name": "Maya", "kind": "person"}
KIP = {"id": "p2", "name": "Kip", "kind": "item"}
KIP_WORDS = dict(KIP, description="A golf-ball sized yellow robot that floats at chest height.")
PIER = {"id": "p3", "name": "Pier", "kind": "location"}
LOOK = {"id": "p4", "name": "Dusk", "kind": "style"}


class Editor:
    """The four editor functions the route reads, over a clip's own fields."""
    def __init__(self, shown):
        self.shown = shown

    def cast_pictures(self, project, clip):
        return self.shown

    def frame_of(self, clip, side):
        return clip.get(side)

    def clip_voice(self, project, clip):
        return clip.get("voice")

    def name_unpictured(self, text, members):
        return text


def take_graph(refine=False, frames=()):
    """The nodes of an editor take graph the route touches, with three stills: Maya twice, then Kip, then Pier."""
    graph = {
        "2": {"class_type": "CLIPLoader", "inputs": {}},
        "3": {"class_type": "VAELoader", "inputs": {}},
        "5": {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": ["1", 0]}},
        "9": {"class_type": "H3LivePreview", "inputs": {"model": ["5", 0]}},
        "10": {"class_type": "H3Take", "inputs": {"prompt": "editor prompt", "width": 640, "height": 352, "length": 121,
                                                  "checkpoint": "ref2va", "ref_images.ref_image_0": ["50", 0]}},
        "12": {"class_type": "H3HyperFlowSigmas", "inputs": {"model": ["5", 0], "steps": 4}},
        "13": {"class_type": "BasicGuider", "inputs": {"model": ["9", 0], "conditioning": ["10", 0]}},
        "15": {"class_type": "SamplerCustomAdvanced", "inputs": {"guider": ["13", 0], "latent_image": ["10", 1]}},
    }
    for n in range(4):
        graph[str(50 + n)] = {"class_type": "H3LoadStill", "inputs": {"file": "s%s.png" % n}}
    for side in frames:
        graph["40" if side == "first" else "41"] = {"class_type": "H3LoadStill", "inputs": {"file": side + ".png"}}
    if refine:
        graph["80"] = copy.deepcopy(graph["10"])
        graph["80"]["inputs"].update(width=1344, height=768)
        graph["83"] = {"class_type": "H3RefineLatent", "inputs": {"take": ["80", 1]}}
        graph["88"] = {"class_type": "BasicGuider", "inputs": {"model": ["9", 0], "conditioning": ["80", 0]}}
    return graph


SHOWN = [(MAYA, ["a", "b"]), (KIP, ["c"]), (PIER, ["d"])]
CLIP = {"action": "@Maya walks along @Pier with @Kip.", "camera": "Low wide shot, @Kip in front.", "cast": ["p1", "p2", "p3"]}


def routed(clip=CLIP, shown=SHOWN, refine=False, project=None):
    cf_refpacks.installed = lambda: True
    frames = [side for side in ("first", "last") if clip.get(side)]
    return cf_refpacks.route(take_graph(refine, frames), project or {"style": "Live-action, cinematic"}, clip, Editor(shown))


def test_roles_and_text():
    rows = cf_refpacks.roles(SHOWN)
    assert [r["tag"] for r in rows] == ["<Character 1>", "<Item 1>", "<Location 1>"]
    text = cf_refpacks.shot_text({"style": "Live-action, cinematic"}, CLIP, rows, Editor(SHOWN))
    assert text == ("<Character 1> walks along <Location 1> with <Item 1>. Low wide shot, <Item 1> in front. "
                    "The look is Live-action, cinematic.")
    # a member the text never names is still brought into the shot
    text = cf_refpacks.shot_text({}, dict(CLIP, action="She walks.", camera=""), rows, Editor(SHOWN))
    assert text == ("<Character 1> appears in the shot. <Item 1> appears in the shot. "
                    "The shot takes place in <Location 1>. She walks.")


def test_route_rewires_the_take():
    graph = routed()
    take = graph["10"]
    assert take["class_type"] == "BExplainsRefPackToH3"
    assert take["inputs"]["model"] == ["5", 0] and take["inputs"]["width"] == 640 and take["inputs"]["length"] == 121
    assert take["inputs"]["checkpoint"] == "ref2va"          # the take's record reads it
    assert graph["13"]["inputs"]["conditioning"] == ["10", 1]  # positive
    assert graph["15"]["inputs"]["latent_image"] == ["10", 3]  # latent
    assert graph["9"]["inputs"]["model"] == ["10", 0] and graph["12"]["inputs"]["model"] == ["10", 0]
    # Maya's two pictures are one pack; one encoder and one role per member, chained in cast order
    assert graph["200"]["inputs"] == {"image1": ["50", 0], "image2": ["51", 0]}
    assert graph["300"]["inputs"]["images"] == ["200", 0] and graph["301"]["inputs"]["images"] == ["52", 0]
    assert graph["300"]["inputs"]["reference_megapixels"] == round(640 * 352 / 1e6, 4)
    assert [graph[k]["inputs"]["role"] for k in ("320", "321", "322")] == ["character", "item", "location"]
    assert "references" not in graph["320"]["inputs"] and graph["322"]["inputs"]["references"] == ["321", 0]
    assert take["inputs"]["references"] == ["322", 0]


def test_route_rewires_the_refine_pass():
    graph = routed(refine=True)
    assert graph["80"]["class_type"] == "BExplainsRefPackToH3" and graph["80"]["inputs"]["width"] == 1344
    assert graph["83"]["inputs"]["take"] == ["80", 3] and graph["88"]["inputs"]["conditioning"] == ["80", 1]
    assert graph["88"]["inputs"]["model"] == ["9", 0]


def test_route_after_the_draft_reuses_its_encode():
    import cf_studio
    graph = take_graph(refine=True)
    graph["83"]["inputs"]["upscaled"] = ["82", 0]
    assert cf_studio.reuse_first_encode(graph)
    cf_refpacks.installed = lambda: True
    graph = cf_refpacks.route(graph, {"style": "Live-action, cinematic"}, CLIP, Editor(SHOWN))
    assert graph["80"]["class_type"] == "EmptyMiniMaxH3LatentAV" and graph["80"]["inputs"]["width"] == 1344
    assert graph["83"]["inputs"]["take"] == ["80", 0]          # the empty latent, untouched by the route
    assert graph["88"]["inputs"]["conditioning"] == ["10", 1]  # the first pack's positive


def test_descriptions_stay_out():
    rows = cf_refpacks.roles([(MAYA, ["a"]), (KIP_WORDS, ["c"])])
    text = cf_refpacks.shot_text({}, dict(CLIP, camera=""), rows, Editor([]))
    assert "golf-ball" not in text and text.startswith("<Character 1> walks")


def test_pinned_frames():
    clip = dict(CLIP, first={"file": "first.png"}, last={"file": "last.png"})
    graph = routed(clip, refine=True)
    # the frames are the first two packs, before the cast, and the text points at them
    assert graph["340"]["inputs"]["images"] == ["40", 0] and graph["341"]["inputs"]["images"] == ["41", 0]
    assert graph["345"]["inputs"]["role"] == "reference" and "references" not in graph["345"]["inputs"]
    assert graph["320"]["inputs"]["references"] == ["346", 0]
    prompt = graph["10"]["inputs"]["prompt"]
    assert prompt.startswith("The shot begins exactly on <Picture 1>.") and prompt.endswith("The shot ends exactly on <Picture 2>.")
    # guides at frame 0 and the last frame, on both passes, between RefPacks and the guiders
    assert graph["350"]["inputs"]["positive"] == ["10", 1] and graph["350"]["inputs"]["frame_idx"] == 0
    assert graph["351"]["inputs"]["positive"] == ["350", 0] and graph["351"]["inputs"]["frame_idx"] == 120
    assert graph["351"]["inputs"]["latent"] == ["10", 3] and graph["13"]["inputs"]["conditioning"] == ["351", 0]
    assert graph["355"]["inputs"]["positive"] == ["80", 1] and graph["88"]["inputs"]["conditioning"] == ["356", 0]
    # one frame alone is <Picture 1>, and the clip without frames has no guide
    only_last = routed(dict(CLIP, last={"file": "last.png"}))
    assert only_last["10"]["inputs"]["prompt"].endswith("The shot ends exactly on <Picture 1>.")
    assert not any(n["class_type"] == "MiniMaxH3AddGuide" for n in routed().values())


def test_clips_that_keep_h3_take():
    for clip, shown in [
        (dict(CLIP, link={"mode": "extend_after"}), SHOWN),     # extends another clip
        (dict(CLIP, voice={"name": "Maya"}), SHOWN),            # speaks with a cast voice
        (dict(CLIP, dialogue="Hi."), SHOWN),
        (dict(CLIP, music="Strings."), SHOWN),
        (dict(CLIP, track={"file": "t.wav"}), SHOWN),
        (CLIP, SHOWN + [(LOOK, ["e"])]),                        # a style: RefPacks has no role for it
        (CLIP, []),                                             # no pictures
    ]:
        assert routed(clip, shown)["10"]["class_type"] == "H3Take", clip
    cf_refpacks.installed = lambda: False
    assert cf_refpacks.route(take_graph(), {}, CLIP, Editor(SHOWN))["10"]["class_type"] == "H3Take"


if __name__ == "__main__":
    for name, test in sorted(globals().items()):
        if name.startswith("test_"):
            test()
            print("ok", name)
