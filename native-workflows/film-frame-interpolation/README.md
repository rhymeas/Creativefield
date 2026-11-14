# FILM frame interpolation

Local finishing pack that reads a project video, interpolates frames with the
core ComfyUI `FrameInterpolate` node and writes a new muted H.264 clip.

## Bindings

- Source clip: `LoadVideo.file` (node 1).
- Model: `frame_interpolation/film_net_fp16.safetensors`.
- Frame multiplier: `FrameInterpolate.multiplier` (node 4), 2 to 4.
- Output FPS: `CreateVideo.fps` (node 5), 8 to 60.

The output frame rate is explicit. To keep the source duration, set it to
`source FPS x multiplier`. The built-in presets cover 16 FPS to 32 FPS and
24 FPS to 48 FPS.

## Qualification 2026-10-19

The exact packaged graph ran on ComfyUI 0.37.0 / RTX 4090. Source: 320x180,
16 FPS, 17-frame testsrc2 video (SHA-256 `d877c754…`). Multiplier 2, output FPS
32. Result: H.264 MP4, 32,211 bytes, SHA-256 `656294eb…`, 33 frames, 32 FPS,
1.031 s, 4.1 s elapsed. Model file: 68,882,302 bytes, SHA-256 `f226e513…`.

This proves graph execution, frame multiplication and output structure. It does
not prove interpolation quality, artifact freedom, temporal consistency, memory
limits on long clips or offline behavior.

## Model

Download `frame_interpolation/film_net_fp16.safetensors` from
`Comfy-Org/frame_interpolation` and verify the SHA-256 pinned in the manifest.
The repository declares MIT and Apache-2.0; verify the exact model card before
commercial use.
