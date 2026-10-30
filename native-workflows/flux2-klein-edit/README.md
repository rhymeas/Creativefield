# Flux 2 Klein 4B image edit

Local single-image edit that uses the installed Flux 2 Klein 4B FP8 model and the
same Qwen 3 4B encoder and Flux 2 VAE as the text-to-image pack.

## Bindings

- Source image: `LoadImage.image` (node 76), required.
- Edit prompt: `CLIPTextEncode.text` (node 75:74).
- Steps: `Flux2Scheduler.steps` (node 75:62), default 4.
- Reference megapixels: `ImageScaleToTotalPixels.megapixels` (node 75:80),
  default 1.
- Seed: `RandomNoise.noise_seed` (node 75:73).
- Output: `SaveImage` (node 9), 1024x1024 for a square one-megapixel source.

The source image is scaled to roughly one megapixel, encoded, and attached as a
reference latent to both the positive and negative conditioning. The model then
denoises a new latent at that size, so output geometry follows the scaled source
aspect rather than a separate width/height control.

## Qualification 2026-10-19

The exact packaged graph ran on ComfyUI 0.37.0 / RTX 4090 with a 1024x1024
testsrc2 source (SHA-256 `ef819bfb…`). Prompt: "Change the background to a snowy
mountain at dusk, keep the foreground unchanged". Result: 1024x1024 PNG,
1,425,159 bytes, SHA-256 `0d751b60…`, 2.1 s on a warm worker (prompt
`6e57dadf-c129-4ddf-95af-2f2d28d70afb`).

This proves graph execution and output structure. It does not prove edit
fidelity, identity preservation, perceptual quality, arbitrary-aspect behavior
or offline operation.

The full ComfyField path also passed through `npm run e2e:flux-edit`: run
`d70f6035`, workflow hash `e3a21cc4`, imported `Flux2-Klein_00001_.png` at
1024x1024 in 6.1 s.

## Models

The pack requires the same files as `flux2-klein-t2i`:
`diffusion_models/flux-2-klein-4b-fp8.safetensors`,
`text_encoders/qwen_3_4b.safetensors` and `vae/flux2-vae.safetensors`.
Verify the SHA-256 pins in the manifest before use.
