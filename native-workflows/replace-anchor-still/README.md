# Replace character anchor still

One still of the clip's frame with each person replaced by the picture uploaded for them, so the
replacement can be approved before a video is made. Built on the Flux 2 Klein 4B FP8 model, the
Qwen 3 4B encoder and the Flux 2 VAE used by `flux2-klein-edit`.

## Bindings

- Clip: `LoadVideo.file` (node 1), or a prepared frame: `LoadImage.image` (node 4).
- Frame: `ImageFromBatch.batch_index` (node 3), default 0.
- First picture: `LoadImage.image` (node 5), required.
- Second picture: `LoadImage.image` (node 6), optional.
- Instruction: `CLIPTextEncode.text` (node 11). The compiler writes the instruction and appends
  the `prompt` control as extra words.
- Output: `SaveImage` (node 28), one PNG at the frame's own size.

The frame is scaled to about one megapixel and chained as the first reference latent, with the
pictures after it in order. The model denoises a new latent at that size, so the still follows the
frame's aspect; `ResizeImageMaskNode` puts it back on the frame's exact size.

## Qualification 2026-10-27

Real runs on the local ComfyUI 0.37.0 / RTX 4090 with the user's clip (`ec4ec0de…`, 1206×904
frame) and the two pictures (2000×1122 sheet and 800×800 portrait): three fresh stills took
8.2 s, 8.2 s and 12.4 s; an unchanged graph is served from cache in about 1 s. The still keeps
the orange wall, microphone and light; both people carry their pictures' outfits and accessories.

This proves graph execution, the three-reference wiring and output structure on this clip. It does
not prove identity fidelity on other footage, a one-picture run by eye, or memory use. Full
comparison and evidence: `docs/REPLACE-ANCHOR.md` and `docs/evidence/replace-anchor-still/`.

## Compiling

`src/capabilities/anchor-still.ts` exports `compileAnchorStill`, which removes the source branch
that was not chosen and the second picture's branch when only one is given. Until the server
calls it, a run of the raw template would keep both branches.
