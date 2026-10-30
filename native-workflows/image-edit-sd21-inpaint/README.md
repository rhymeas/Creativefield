# Stable Diffusion 2.1 image inpainting — experimental local route

This reviewed API-format graph accepts a source PNG and a separate aligned grayscale PNG mask. White mask pixels are edited; black pixels preserve the source through an explicit final composite. The output is a bounded PNG image artifact with ordered source and mask parent relationships.

The graph uses only the declared ComfyUI core nodes: `LoadImage`, `ImageToMask`, `CheckpointLoaderSimple`, `CLIPTextEncode`, `VAEEncodeForInpaint`, `KSampler`, `VAEDecode`, `ImageCompositeMasked`, and `SaveImage`. It has no hosted route and no independent API fallback.

## Pinned checkpoint

- File: `ComfyUI/models/checkpoints/512-inpainting-ema.safetensors`
- Size: 5,214,662,094 bytes
- SHA-256: `b29e2ed9a8fe58e76f7e801bda091d23738bd74c1da3f339bcbe2d40922fcb`
- Comfy-Org revision: `ec5db49993ae0a935f32ff9f36c1cfbd5f94cca6`
- Declared weight license: CreativeML Open RAIL++-M; review the full upstream license before distribution or use.

The file identity and required local node inventory were verified on 2026-10-17. That does not qualify generation behavior, offline operation, or output quality. The route was enabled on 2026-10-18 at the owner's request because the checkpoint is installed locally. A captured, independently verified real run is still outstanding.

## Boundaries

The output contract permits PNG alpha but the graph does not promise to generate or preserve alpha. This workflow does not provide relighting, segmentation, layer decomposition, identity consistency, recovery of hidden geometry, or reconstruction of proprietary internals. Its final composite is an editable derived operation; soft masks and model output can change pixels in the edit region, and no bit-exact preservation claim is made.
