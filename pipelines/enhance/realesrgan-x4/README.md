# Real-ESRGAN upscale (enhance)

Takes a finished clip and returns a larger one with the same length and frame rate. It is not a generator, so its manifest has `"kind": "enhance"` and different inputs from the generation providers.

| File | Role |
|---|---|
| `manifest.json` | The source-video and scale bindings, the factors offered (2× and 4×), and the model it needs |
| `template.api.json` | The graph sent to ComfyUI. **Written by hand**: ComfyUI ships no video-upscale template, so there is no `source.ui.json` |
| `models.txt` | The model file and where to get it |

## The graph

```
LoadVideo → GetVideoComponents ─┬─ images → ImageUpscaleWithModel (Real-ESRGAN x4plus) → ImageScaleBy → CreateVideo → SaveVideo
                                 ├─ fps ────────────────────────────────────────────────────────────────┘
                                 └─ audio ──────────────────────────────────────────────────────────────┘
```

The model always enlarges by 4×. `ImageScaleBy` brings that down to the factor asked for, so **2×** is `scale_by = 0.5` and **4×** is `scale_by = 1`. Frame rate and audio are taken from the source, so they carry over.

## How the studio uses it

The studio downloads the finished clip from ComfyUI's output folder and uploads it into the input folder (the video loader only reads from there), then queues this graph. The 4× option is not offered when the result would be larger than `maxOutputEdge` (4096 px on the longer side), which H.264 cannot encode. A 832×480 clip can go to 4× (3328×1920); a 1280×704 clip can only go to 2×.

## Parameters

| Studio control | Node | Notes |
|---|---|---|
| Source clip | 1 `file` | Uploaded to ComfyUI's input folder first |
| Enlargement | 5 `scale_by` | `factor ÷ 4` |
| Output | 7 `SaveVideo` | |

## Measured

A 2 s, 832×480 clip (33 frames) upscaled to 1664×960 in about 40 s on the RTX 4090.

## Qualification 2026-10-18 (reproducible)

Exact `template.api.json` graph submitted to live ComfyUI 0.37.0 (`:8188/prompt`), factor 2× (`scale_by = 0.5`):

- Source: `ffmpeg testsrc2` 160×90, 16 fps, 17 frames, H.264
- Output: 320×180, 16 fps, 17 frames, 32,700 B, SHA-256 `08e2aa3b582caaad6e1f0e676056fc2771cf903429378ab764f64e0b6be34460`
- Elapsed 4.1 s on RTX 4090; ComfyUI prompt `53ccd25f-e4fe-43a2-b6cf-62faf386c3e8`
- Model: `upscale_models/RealESRGAN_x4plus.pth` (67,040,989 B)

This proves model load, graph execution and dimension/frame/fps preservation. It does not prove perceptual quality on real footage.
