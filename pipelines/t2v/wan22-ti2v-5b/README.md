# Wan 2.2 TI2V 5B (text to video)

The same model as [the image-to-video provider](../../i2v/wan22-ti2v-5b/README.md), run without a start image. Wan 2.2 TI2V is one model that does both, so **the model files are shared**: nothing extra to download.

| File | Role |
|---|---|
| `manifest.json` | Parameter bindings. No `start_image` input, which is what makes it a text-to-video provider |
| `template.api.json` | Generated from `source.ui.json` with the image loader left bypassed (ComfyUI's own default mode for this template) |
| `source.ui.json` | ComfyUI's `video_wan2_2_5B_ti2v` template. Identical to the image-to-video copy |
| `models.txt` | The same three model files |

## Regenerate the template

```bash
npm run ui-to-api -- pipelines/t2v/wan22-ti2v-5b/source.ui.json pipelines/t2v/wan22-ti2v-5b/template.api.json
```

No `--enable`: node 56 (the image loader) stays out of the graph, so the latent node gets no start image.

## Prompting

With no image to anchor it, the model invents the whole scene, so the prompt has to describe the subject, the setting, the light, and what moves. Avoid camera words such as "camera pushes in" unless a camera should appear in the scene; the model can draw one.
