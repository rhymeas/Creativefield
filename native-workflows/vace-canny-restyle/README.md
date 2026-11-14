# VACE Canny restyle

This open, local ComfyUI recipe decodes a source video, derives a Canny edge batch with the reviewed core `Canny` node, and supplies those edges to Wan VACE as structural conditioning. The first fitted source frame also reaches `WanVaceToVideo.reference_image`, so the person, clothes and pose come from the clip instead of from the prompt; the two frames that reference conditioning prepends are dropped before `CreateVideo`. One exact graph run verified execution and MP4 output structure (see below), so the local route is available when its model and node requirements are ready. Perceptual restyle quality and temporal consistency remain unqualified; the `implemented` label means the graph can execute through ComfyField.

## Why the person used to change

Edges carry outline and motion only: no face, no hair, no clothes. With no reference image connected, the words were the only thing describing who stands in the frame, so "imagine this gentleman standing in his grandpa livingroom" produced a new man and even an extra person. The graph now hands VACE the clip's own first frame as the reference image, and the prompt carries a keep-the-subject clause. Controls (2026-10-26) show the reference image is what keeps the man; the clause alone on the old graph still returned a different man.

## Real bindings

- source video â†’ `LoadVideo.file` (node 4)
- low/high edge thresholds â†’ `Canny.low_threshold` / `high_threshold` (node 6)
- prompt / negative prompt â†’ `CLIPTextEncode.text` (nodes 8 and 9)
- VACE conditioning strength â†’ `WanVaceToVideo.strength` (node 10)
- person reference â†’ `WanVaceToVideo.reference_image` (from node 19, first fitted source frame)
- seed â†’ `KSampler.seed` (node 12)

Width, height, frame count, and output FPS are derived from the decoded source. The recipe exposes no duration, trim, segment, timeline, or FPS control. Output audio is muted. One `SaveVideo` node is the only declared artifact path and is compatible with ComfyField's existing verified video ingestion and run-provenance flow after qualification.

## Qualification 2026-10-18

The exact revision ran on ComfyUI 0.37.0 / RTX 4090 with the reviewed `wan2.1_vace_1.3B_fp16.safetensors` weights and the exact `template.api.json` graph:

- Source: 160Ã—96, 16 FPS, 17 frames (testsrc2)
- Output: 21,865-byte H.264 MP4, 160Ã—96, 16 FPS, 17 frames
- Elapsed 207.8 s; ComfyUI prompt `4f3b50a8-7ace-4964-bf07-8841038d7d43`
- Output SHA-256: `7641ccb72e2b83f88b90df72097ddf0e520cc509eabe918e81aee6ddb4849124`

This proves graph execution, model loading and output structure. Perceptual restyle quality, identity preservation, temporal consistency, offline behavior and memory use are not proven by that run; masked-edit evidence does not transfer to this graph.

## Person-kept run 2026-10-26

The 0.3.0 graph ran on the reported clip (512Ã—928, 24 fps, 49 frames) with the reported words, seed 543 and strength 1: ComfyUI prompt `bdf556c0-155f-45b5-bb27-32df322d3ea0` queued straight to the local 8188 server after `compileLocal`, 95 s. Output `vace-canny-restyle_00018_.mp4` is 480Ã—864, 24 fps, 49 frames, 235,660 bytes, SHA-256 `209f0114232e8d8bc804a656a73ac74ea412d99e9afa1f75ce1b9b66250cacfd`. The same man, blue jacket, grey trousers and boots, and the same raised hand at frame 24 as the source, in a new living room. See `docs/TRANSFORM-EVIDENCE.md` for the before/after frames and the two control runs. One clip, one seed per variant: other framings, other people and long clips stay unqualified.

Primary implementation references and the weight-license source are recorded in `manifest.json` and `effect-recipe.json`. The VACE weight is declared Apache-2.0 by its publisher; the full dependency and redistribution audit remains incomplete.
