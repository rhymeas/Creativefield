"""Stage an isolated Flash graph for a three-person positional tracking experiment."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
from shutil import copyfile


POSITION_CUES = (
    r"\b(?:on (?:the )?left|far left|leftmost)\b",
    r"\b(?:in the (?:center|centre|middle)|(?:center|centre|middle) (?:person|dancer|figure|performer|subject))\b",
    r"\b(?:on (?:the )?right|far right|rightmost)\b",
)


def ordered_roles(text):
    roles = text.splitlines()
    if len(roles) != 3:
        raise ValueError("Give exactly three source roles with explicit left, center and right positions")
    slots = {}
    for index, line in enumerate(roles, 1):
        cue = line.partition(" - ")[2]
        positions = [position for position, pattern in enumerate(POSITION_CUES) if re.search(pattern, cue, re.I)]
        if len(positions) != 1 or positions[0] in slots:
            raise ValueError("Each source role needs its own explicit left, center or right position")
        slots[positions[0]] = index
    return [slots[i] for i in range(3)]


def stage(graph, fingerprint):
    expected = {"20": "H3AdvancedSwapPlan", "35": "MiniMaxH3ChainPlanModern", "44": "SAM3_VideoTrack",
                "45": "H3TrackCrops", "47": "H3TrackRoles", "72": "HyperFlowSigmas"}
    if any(graph.get(key, {}).get("class_type") != name for key, name in expected.items()):
        raise ValueError("Expected the compiled local OpenJutsu Flash graph")
    plan = graph["35"]["inputs"]
    guide_fingerprint = plan.get("generation_fingerprint", "")
    guided = (isinstance(guide_fingerprint, str) and re.fullmatch(r"[0-9a-f]{64}", guide_fingerprint)
              and plan.get("run_name") == f"swap_scene_guide_{guide_fingerprint[:24]}"
              and graph.get("65", {}).get("inputs", {}).get("ref_images.ref_image_3") == ["cf-openjutsu-scene-guide", 0])
    if (graph["47"]["inputs"].get("segments") != ["45", 1]
            or graph["45"]["inputs"].get("track_data") != ["44", 0]
            or (plan.get("run_name") != ["20", 3] and not guided)):
        raise ValueError("The native role matcher inputs have changed")
    masks = [node for node in graph.values() if node["class_type"] == "H3RoleMask"]
    resolver = "cf-openjutsu-resolve-roles"
    preview = "cf-openjutsu-resolved-role-preview"
    if len(masks) != 3 or any(node["inputs"].get("labels") != ["47", 0] for node in masks) or resolver in graph or preview in graph:
        raise ValueError("Expected the three original mask consumers")
    order = ordered_roles(graph["20"]["inputs"]["roles"])
    graph[resolver] = {"class_type": "CreativeFieldOpenJutsuResolveRoles", "inputs": {
        "track_data": ["44", 0], "segments": ["45", 1], "labels": ["47", 0], "left_to_right": json.dumps(order),
    }}
    graph[preview] = {"class_type": "PreviewAny", "inputs": {"source": [resolver, 0]},
                      "_meta": {"title": "Track labels after positional repair"}}
    for node in masks:
        node["inputs"]["labels"] = [resolver, 0]
    graph["35"]["inputs"].update(run_name=f"swap_role_repair_{fingerprint[:24]}", generation_fingerprint=fingerprint)
    return graph


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("compiled_graph", type=Path)
    parser.add_argument("output_graph", type=Path)
    parser.add_argument("--isolated-worker", type=Path, help="Optional separate worker directory for the experiment node")
    args = parser.parse_args()

    source = args.compiled_graph.read_bytes()
    plugin = Path(__file__).with_name("__init__.py")
    fingerprint = sha256(source + plugin.read_bytes()).hexdigest()
    graph = stage(json.loads(source), fingerprint)
    if args.output_graph.exists():
        parser.error("Choose a new graph file")
    if args.isolated_worker:
        worker = args.isolated_worker.resolve(strict=True)
        target = worker / "custom_nodes" / "creativefield_openjutsu_track_roles"
        if worker not in target.resolve().parents:
            parser.error("The node directory must be inside the isolated worker")
        target.mkdir()
        copyfile(plugin, target / "__init__.py")
    with args.output_graph.open("x", encoding="utf-8") as output:
        json.dump(graph, output, indent=2)
        output.write("\n")


if __name__ == "__main__":
    main()
