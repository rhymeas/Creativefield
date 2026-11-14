# Wan 2.2 TI2V 5B (image to video)

| File | Role |
|---|---|
| `manifest.json` | Binds the studio's parameters to node inputs in the template, and lists limits and required model files |
| `template.api.json` | API-format graph that is sent to ComfyUI. Generated from `source.ui.json`; do not edit by hand |
| `source.ui.json` | ComfyUI's own `video_wan2_2_5B_ti2v` template (UI format). Open it in ComfyUI to change the graph |
| `models.txt` | Model files and download URLs |

## Model files (about 16.9 GB)

| Folder under `ComfyUI/models/` | File | Size |
|---|---|---|
| `diffusion_models` | `wan2.2_ti2v_5B_fp16.safetensors` | 9.3 GB |
| `text_encoders` | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6.3 GB |
| `vae` | `wan2.2_vae.safetensors` | 1.3 GB |

```bash
bash scripts/download-models.sh pipelines/i2v/wan22-ti2v-5b/models.txt
```

## Regenerate the template after changing the graph

1. Edit the graph in ComfyUI and save it in UI format over `source.ui.json`.
2. Start ComfyUI, then run:

```bash
npm run ui-to-api -- pipelines/i2v/wan22-ti2v-5b/source.ui.json pipelines/i2v/wan22-ti2v-5b/template.api.json --enable 56
```

`--enable 56` turns on the image loader, which the original template has bypassed (its default mode is text to video).
3. If node IDs changed, update `manifest.json`, then run `npm test`. A test checks that every binding still points at a real node and field.

## Parameters

| Studio control | Node | Notes |
|---|---|---|
| Prompt | 6 `text` | |
| Negative prompt | 7 `text` | Left empty, the template's default Wan negative prompt is used |
| Start image | 56 `image` | Uploaded to ComfyUI first |
| Aspect | 55 `width`, `height` | Landscape 1280×704, portrait 704×1280 |
| Duration | 55 `length` | Frames = 4n + 1 at 24 fps (5 s = 121 frames) |
| Seed | 3 `seed` | |
| Output | 58 `SaveVideo` | |
