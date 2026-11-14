# Qwen Image 2.1 45° angle shots

A real camera-angle reshot of one reference image using the community
[Qwen-Image-2.1 Multiple-Angles v2 LoRA](https://huggingface.co/akhaliq/Qwen-Image-2.1-Multiple-Angles-LoRA).
The graph is the existing Qwen Image 2.1 edit template with one source image and
a `LoraLoaderModelOnly` step at strength 1.0.

## Model

- Base: `qwen_image_2.1_int8_convrot.safetensors`, `qwen3vl_8b_int8_convrot.safetensors`,
  `qwen_image_2.1_vae_bf16.safetensors` (already installed for the Qwen packs).
- Adapter: `qwen21_multiple_angles_v2.safetensors`, step 1,500, rank 64.
  318,819,792 bytes, SHA-256
  `548c57977c3f1c09c2c9e5f4e83e930cbc6f719c878a576ab8666ce29fef39b6`.
- Put the adapter under `ComfyUI/models/loras/`. The LoRA is Apache-2.0; the
  Qwen Image 2.1 base remains under the Qwen Research License
  (non-commercial research or evaluation unless separately licensed).

## Presets

Eight 45° azimuth positions at eye level, plus one high angle:

`front-left-quarter`, `left-side`, `back-left-quarter`, `back`,
`back-right-quarter`, `right-side`, `front-right-quarter`, `high-angle`.

Each preset sends an explicit `<mva> ...` instruction to the Qwen conditioning.
This is a generative reshot, not a reconstructed 3D orbit. Identity, background
and clothing are reviewed per output; the model can change the scene.

## Verification

- Graph test on 2026-10-24: source `flux2-klein-t2i_00020_.png`, prompt
  `<mva> left side view, eye-level shot...`, ComfyUI prompt
  `ee018f56-50af-4999-8be0-d4bbbcb00c24` succeeded.
- Output `ComfyField/qwen-image-21-angles_00001.png`, 1,246,161 bytes. The
  inspected result is a genuine different side of the red cabin, not the
  source view.
- Real app run and browser review are recorded after the pack is exercised
  through the normal Image Studio route.

## Limits

- One angle per Generate action.
- No 3D reconstruction, no occlusion completion guarantee, no identity
  guarantee on arbitrary people or complex props.
- Background changes are possible; use the output only after visual review.
