# Wan 2.2 14B (image to video, quality)

The larger Wan 2.2 model: two 14B experts (a high-noise one for the first steps and a low-noise one for the rest), run with the 4-step Lightx2v LoRAs. This template uses a lower default resolution than the 5B template; comparative output quality has not been established.

| File | Role |
|---|---|
| `manifest.json` | Binds the studio's parameters to node inputs, and lists limits and required model files |
| `template.api.json` | API-format graph sent to ComfyUI. Generated from `source.ui.json`; do not edit by hand |
| `source.ui.json` | ComfyUI's `video_wan2_2_14B_i2v` template (UI format) with one change: **turbo mode is switched on** (the last widget value of the subgraph instance), so the Lightning LoRAs and 4 steps are used. The shipped template has it off (20 steps) |
| `models.txt` | Model files and download URLs |

## Model files (about 29 GB, plus the shared text encoder)

| Folder under `ComfyUI/models/` | File | Size |
|---|---|---|
| `diffusion_models` | `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | 13.3 GB |
| `diffusion_models` | `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | 13.3 GB |
| `loras` | `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` | 1.1 GB |
| `loras` | `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` | 1.1 GB |
| `vae` | `wan_2.1_vae.safetensors` | 0.2 GB |
| `text_encoders` | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6.3 GB (shared with the 5B provider) |

```bash
bash scripts/download-models.sh pipelines/i2v/wan22-i2v-14b/models.txt
```

## Regenerate the template

```bash
npm run ui-to-api -- pipelines/i2v/wan22-i2v-14b/source.ui.json pipelines/i2v/wan22-i2v-14b/template.api.json
```

This template keeps its pipeline inside a subgraph. The converter flattens it, so nodes inside get IDs such as `129:98` (instance 129, inner node 98).

## Parameters

| Studio control | Node | Notes |
|---|---|---|
| Prompt | `129:93` `text` | |
| Negative prompt | `129:89` `text` | Left empty, the template's default Wan negative prompt is used |
| Start image | `97` `image` | Uploaded to ComfyUI first |
| Aspect | `129:98` `width`, `height` | Landscape 832×480, portrait 480×832 |
| Duration | `129:161` `value` | Seconds. The graph requests `floor(seconds × 16 + 1)` frames; the Wan latent/VAE path decodes `4 × floor((requested − 1) / 4) + 1` frames |
| Seed | `129:86` `noise_seed` | Seeds the first (high-noise) sampler |
| Output | `108` `SaveVideo` | |

Fractional durations can round down: 1.4 seconds requests 23 frames but decodes 21 at 16 fps. The storyboard planner uses the verified `wan_seconds_floor_4n1` mapping and requests 1.5 seconds (25 source frames) when needed to cover a 1.4-second cut. Ordinary generation retains its original seconds binding. The adapter rejects timing metadata if the expression, FPS, VAE, sampler chain or video output wiring changes.
