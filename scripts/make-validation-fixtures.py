"""Create small synthetic inputs for native workflow validation.

Use the ComfyUI Python environment (Pillow is required) and an installed
ffmpeg. This never overwrites existing files or changes the ComfyUI input dir.
"""
import argparse
import json
import shutil
import subprocess
import wave
from pathlib import Path

from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True, help="Existing directory for the new fixtures")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    options = parser.parse_args()
    directory = Path(options.directory).resolve()
    if not directory.is_dir():
        parser.error("--directory must be an existing directory")
    ffmpeg = shutil.which(options.ffmpeg)
    if not ffmpeg:
        parser.error("ffmpeg was not found")
    names = {"image": "comfyfield-fixture-image.png", "mask": "comfyfield-fixture-mask.png",
             "audio": "comfyfield-fixture-audio.wav", "video": "comfyfield-fixture-video.mp4"}
    for name in names.values():
        if (directory / name).exists():
            parser.error(f"refusing to overwrite {name}")
    for kind, color in (("image", (128, 128, 128)), ("mask", (255, 255, 255))):
        with (directory / names[kind]).open("xb") as output:
            Image.new("RGB", (512, 512), color).save(output, format="PNG")
    with (directory / names["audio"]).open("xb") as output:
        with wave.open(output, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(24000)
            audio.writeframes(b"\0\0" * 48000)
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-n", "-f", "lavfi", "-i",
                    "color=c=gray:s=512x512:r=24", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    str(directory / names["video"])], check=True, timeout=60)
    print(json.dumps(names))


if __name__ == "__main__":
    main()
