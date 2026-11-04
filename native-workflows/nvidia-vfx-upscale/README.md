# Sharpen and upscale

Local finishing pack for NVIDIA RTX Video Super Resolution. It reads a project
video, processes its frames, and rebuilds the clip with the source audio and
frame rate.

## Bindings

- Source clip: `LoadVideo.file` (node 1).
- Scale: `RTXVideoSuperResolution.resize_type.scale` (node 3), 2 or 4.
- Mode: `RTXVideoSuperResolution.quality` (node 3). `ULTRA` upscales and
  sharpens. `DENOISE_HIGH` and `DEBLUR_HIGH` keep the source size.
- Output size is rounded to a multiple of 8 by the node.
- Audio and frame rate come from `GetVideoComponents` and go into
  `CreateVideo`, so the result keeps both.

## Install

The node pack is Apache-2.0. Its `nvidia-vfx` runtime is an NVIDIA proprietary
wheel installed separately and not redistributed. Follow the exact steps and
GPU requirements in [docs/NVIDIA-VFX.md](../../docs/NVIDIA-VFX.md), then
restart ComfyUI.

ComfyUI was not running on `127.0.0.1:8188` during this setup, so the local
`/object_info` check could not run live. The installed Python module was
imported directly and exposed `RTXVideoSuperResolution`, `RTXTrueHDR` and
`RTXVideoFrameGeneration`.

## Status

The graph follows the pack's `example_workflows/rtx_video_upscale.json` shape.
No GPU run has qualified this template yet. ComfyField also needs
`RTXVideoSuperResolution` in its local node allowlist before the route can
queue.
