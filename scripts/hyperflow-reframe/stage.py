"""Stage a reviewed TwoAbove outpaint variant in an isolated ComfyUI worker.

Source: https://github.com/TwoAbove/ComfyUI-H3VideoOutpaint/tree/59b51eff76e58ff06e9908c98d1d2df22c465a1e
The worker also needs the positioned FL2VA keyframes from ComfyUI PR 16184.
"""

import argparse
import ast
from hashlib import sha256
from pathlib import Path
from shutil import copyfile


SOURCE_DIGESTS = {
    "nodes.py": "c70e9793a89894d00878181c2e60df08f8ff3fd6d722fc48b349e0a6db4239d3",
    "__init__.py": "4c0f96b0f0006df5a559d09d44b8d521a32d7992383223310b5ba2a3f88e3e42",
    "LICENSE": "1126322e2cc8d165adc4c792eeb195717de2bcc7b39be1ce77959d78e87ef685",
}


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError(f"Unexpected upstream source near {old[:80]!r}")
    return source.replace(old, new, 1)


def adapt(source):
    change = replace_once
    source = change(source, 'import node_helpers\n',
                    'import node_helpers\nfrom nodes import NODE_CLASS_MAPPINGS as COMFY_NODES\n'
                    'from .geometry import CANVASES, fit_frame, plan_geometry\n')
    source = change(source, 'def _iter_video_frames(video, skip_first_frames, frame_load_cap, crop=None):',
                    'def _iter_video_frames(video, skip_first_frames, frame_load_cap, geometry=None):')
    source = change(source, '''            image = frame.to_ndarray(format="rgb24")
            if crop is not None:
                left, top, width, height = crop
                image = image[top : top + height, left : left + width]
            yield image''', '''            if geometry is None:
                yield frame.to_ndarray(format="rgb24")
            else:
                yield fit_frame(frame, geometry)''')
    source = change(source, 'frame_count, width, height, crop=None', 'frame_count, width, height, geometry=None')
    source = change(source, 'frame_load_cap, crop=crop)', 'frame_load_cap, geometry=geometry)')
    start = source.index('        (\n            self.width,\n            self.height,')
    end = source.index('        self.composite_source =', start)
    source = source[:start] + '''        self.geometry = plan_geometry(self.input_width, self.input_height, self.target_aspect)
        self.width, self.height = self.geometry.width, self.geometry.height
        self.source_width, self.source_height = self.geometry.guide_width, self.geometry.guide_height
        self.left, self.top = self.geometry.left, self.geometry.top
        self.right, self.bottom = self.geometry.right, self.geometry.bottom
''' + source[end:]
    source = change(source, '''            crop=(
                self.crop_left,
                self.crop_top,
                self.source_width,
                self.source_height,
            ),''', '            geometry=self.geometry,')
    source = change(source, '    committed_video_stop = 0\n',
                    '    sigmas, = COMFY_NODES["HyperFlowSigmas"]().sigmas(model, steps)\n'
                    '    committed_video_stop = 0\n')
    source = change(source, '            denoise=1.0,\n', '            denoise=1.0,\n            sigmas=sigmas,\n')
    # The generation trajectory may need repeated tail frames. Deliver only
    # the original frame interval and preserve the audio duration it covers.
    start = source.index('        output_audio = None\n', source.index('    def save_to('))
    end = source.index('        self.audio_vae = None\n', start)
    source = source[:start] + '''        output_sample_count = round(actual_count / float(self.source_frame_rate) * AUDIO_SAMPLE_RATE)
        output_audio = _fit_waveform(source_audio, output_sample_count) if source_audio is not None else None
''' + source[end:]
    source = change(source, '            for generated_frame in decoded_frames:',
                    '            for generated_frame in decoded_frames[:actual_count]:')
    source = change(source, '        if encoded_count != aligned_count:', '        if encoded_count != actual_count:')
    source = change(source, 'f"{aligned_count}-frame H3 trajectory."', 'f"{actual_count}-frame source interval."')
    source = change(source, '                    ["9:12 portrait", "source"],\n                    {"default": "9:12 portrait"},',
                    '                    list(CANVASES),\n                    {"default": "16:9 landscape"},')
    source = source.replace('self.frame_count = temporal_shape(source_count)[0]', 'self.frame_count = source_count')
    source = source.replace('self.frame_count = temporal_shape(actual_count)[0]', 'self.frame_count = actual_count')
    source = source.replace('"MiniMaxH3SimpleVideoOutpaint":', '"CreativeFieldHyperFlowReframe":')
    source = change(source, '"MiniMax H3 Video Outpaint",', '"HyperFlow Flash Video Reframe",')
    source = change(source, 'f"{video.frame_count} H3-aligned output frames; "',
                    'f"{video.frame_count} delivered frames; "')
    ast.parse(source)
    return source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("upstream", type=Path, help="Reviewed local upstream checkout")
    parser.add_argument("comfy_core", type=Path, help="Isolated ComfyUI checkout")
    parser.add_argument("target", type=Path, help="New plugin directory in the isolated worker")
    args = parser.parse_args()

    files = {name: (args.upstream / name).read_text(encoding="utf-8-sig") for name in SOURCE_DIGESTS}
    for name, content in files.items():
        if sha256(content.encode()).hexdigest() != SOURCE_DIGESTS[name]:
            raise ValueError(f"Unreviewed upstream file: {name}")
    core = (args.comfy_core / "comfy/ldm/minimax/model.py").read_text(encoding="utf-8")
    if 'kf.get("latent_y", 0)' not in core or 'kf.get("latent_x", 0)' not in core:
        raise ValueError("This ComfyUI checkout lacks positioned FL2VA keyframes.")

    files["nodes.py"] = adapt(files["nodes.py"])
    args.target.mkdir(exist_ok=False)
    for name, content in files.items():
        (args.target / name).write_text(content, encoding="utf-8", newline="\n")
    copyfile(Path(__file__).with_name("geometry.py"), args.target / "geometry.py")


if __name__ == "__main__":
    main()
