# Wan 2.2 14B (first and last frame, quality)

Video that starts on one image and ends on another. The model invents the motion in between. It is the same 14B experts and Lightning LoRAs as [the 14B image-to-video provider](../../i2v/wan22-i2v-14b/README.md), so **there is nothing extra to download**.

| File | Role |
|---|---|
| `manifest.json` | Binds the studio's parameters to node inputs; has both a `start_image` and an `end_image` input |
| `template.api.json` | API-format graph sent to ComfyUI. Generated from `source.ui.json`; do not edit by hand |
| `source.ui.json` | ComfyUI's `video_wan2_2_14B_flf2v` template with its two branches swapped: the shipped template runs a 20-step branch and keeps the 4-step Lightning LoRA branch bypassed (about 9 minutes per clip); here the LoRA branch is active and the 20-step branch is bypassed |
| `models.txt` | The same model files as the 14B image-to-video provider |

## Which image is which

The template's LoRA branch wires the loader named `video_wan2_2_14B_flf2v_end_image.png` (node 68) into the node's **start** input, and the loader named `..._start_image.png` (node 62) into its **end** input. The sample file names are mixed up, but the wiring is what counts, so the manifest follows the wiring: `start_image` is node 68 and `end_image` is node 62.

## Regenerate the template

```bash
npm run ui-to-api -- pipelines/flf2v/wan22-flf2v-14b/source.ui.json pipelines/flf2v/wan22-flf2v-14b/template.api.json
```

## Parameters

| Studio control | Node | Notes |
|---|---|---|
| Prompt | 6 `text` | Describe how the first frame becomes the last |
| Negative prompt | 7 `text` | Left empty, the template's default Wan negative prompt is used |
| Start image | 68 `image` | Uploaded to ComfyUI first |
| End image | 62 `image` | Uploaded to ComfyUI first |
| Aspect | 67 `width`, `height` | Landscape 832×480, portrait 480×832 |
| Duration | 67 `length` | Frames = 4n + 1 at 16 fps (5 s = 81 frames) |
| Seed | 57 `noise_seed` | Seeds the first (high-noise) sampler |
| Output | 61 `SaveVideo` | |
