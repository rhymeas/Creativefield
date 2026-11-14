# Wan Animate 2, distilled (motion control)

Gives a **character image** the **movement of a driving video**. The model copies identity from the image and motion from the video's raw frames (no pose extraction). Background and camera come from the prompt.

| File | Role |
|---|---|
| `manifest.json` | Binds the studio's controls to node inputs; has a `motion_video` and a `motion_prompt` input, and no `length` (the template fixes it at 81 frames) |
| `template.api.json` | API-format graph sent to ComfyUI. Generated from `source.ui.json`; do not edit by hand |
| `source.ui.json` | ComfyUI's `video_wan_animate2_distilled` template with three changes, listed below |
| `models.txt` | Model files and where to get them |

## Changes made to the shipped template

1. **VAE:** the template names `Wan2_1_VAE_bf16.safetensors`. The installed `wan_2.1_vae.safetensors` (the one the Wan 2.2 14B providers use, the same size) is used instead, so there is no extra download.
2. **Comparison output muted:** the template also saves a side-by-side of the driving clip and the result (the `Video Stitch` subgraph and its `SaveVideo`). Both are bypassed to save time. The frame-count preview nodes are bypassed too.
3. Nothing else: the 10-step LCM sampler and the second (bypassed) copy of the motion subgraph for longer clips are as shipped.

## Model files (about 16.7 GB new)

| Folder under `ComfyUI/models/` | File | Size |
|---|---|---|
| `diffusion_models` | `wan_animate_2_distill_int8_convrot.safetensors` | 15.5 GB |
| `clip_vision` | `clip_vision_h.safetensors` | 1.2 GB |
| `text_encoders` | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6.3 GB (shared with the Wan 2.2 providers) |
| `vae` | `wan_2.1_vae.safetensors` | 0.2 GB (shared with the Wan 2.2 14B providers) |

```bash
bash scripts/download-models.sh pipelines/motion/wan-animate2-distilled/models.txt
```

## Parameters

| Studio control | Node | Notes |
|---|---|---|
| Character and background | `605` `value` | A multi-line text node feeding the main prompt. Describe looks and background only, no motion words |
| Motion description | `604` `value` | A multi-line text node feeding the pose prompt. Describe the movement, for example "a person dancing" |
| Negative prompt | `261:4` `text` | Left empty, the template's default is used |
| Character image | `189` `image` | Uploaded to ComfyUI first |
| Motion video | `240` `file` | Uploaded to ComfyUI's input folder first |
| Aspect | `261:243` `resize_type.width`, `resize_type.height` | Portrait 482×854, landscape 854×482. The reference image and the output size follow from this node |
| Seed | `261:19` `noise_seed` | |
| Output | `246` `SaveVideo` | The frame rate is the driving video's |

## Qualification 2026-10-18 (reproducible)

Exact `template.api.json` graph submitted to live ComfyUI 0.37.0 (`:8188/prompt`), portrait defaults:

- Character image: synthetic 482×854 gradient PNG; driving video: `testsrc2` 320×400, 24 fps, 81 frames
- Output: 480×848, 24 fps, 81 frames, 101,351 B, SHA-256 `78d801790ddff4d977db3118411955bf5d1c815ccfdb7f29abdd20087605cd9f`
- Elapsed 205.8 s on RTX 4090; ComfyUI prompt `74aff839-b45d-4518-aae4-950034a8f362`
- The nominal 482×854 resize request yields 480×848 output (latent dimensions round to multiples of 16)

This proves model load, graph execution and frame/fps/dimension behaviour with synthetic inputs. It does **not** prove perceptual motion quality, identity preservation or lip accuracy on real footage. The route is therefore `implemented` for execution, with that quality boundary stated in the manifest evidence.

## Limits

- One pass makes **81 frames**. At a driving video's own frame rate that is about 3 s at 24-30 fps. Longer clips need several chained passes, which this provider does not do yet.
- Frames are taken 1:1 from the driving video, so a video with a high frame rate moves faster per second of output. Resample the video to 16-24 fps if the motion looks too fast or slow.
- Keep the framing of the character image and the driving video similar (full body to full body). A mismatch is the usual cause of bad results.
