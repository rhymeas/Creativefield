# VACE preprocessed-depth restyle — local execution MVP

This open, local ComfyUI graph is a FIN-03 structural-restyling candidate. It accepts a source video and a separately preprocessed, frame-aligned depth video. The graph does not estimate or derive depth from the source.

The source video supplies output geometry, frame count and frame rate. The depth video's decoded frames feed `WanVaceToVideo.control_video` directly. Prompt, negative prompt, seed and VACE conditioning strength are the only exposed controls, and each binds to a real graph field. There is no duration, FPS, segment or timeline control. Output is mute.

Both inputs use ComfyField's existing workspace video-asset path. Before queueing, the server verifies both stored hashes, the grayscale depth encoding, dimensions, decoded frame count and every 16 FPS frame timestamp. A server-derived receipt freezes both input asset IDs/hashes and the validated timing facts into run provenance. The caller remains responsible for semantic alignment: matching timestamps cannot prove that a depth frame describes the same scene instant as its source frame.

## Qualification 2026-10-19

The exact graph ran on ComfyUI 0.37.0 / RTX 4090 with a 160×96, 16 FPS, 17-frame testsrc2 source and an aligned grayscale testsrc2 depth video. Output: 24,468-byte H.264 MP4, 160×96, 16 FPS, 17 frames, 9.0 s, prompt `aa79567e-a8f4-4b76-beb3-719f9d7ae2b0`, SHA-256 `df22aa5b986c7dd93bf5ba6a43a6a730ad9e4c8a0462c2433b31f94e479d91a6`.

This proves graph execution and output structure with a caller-supplied aligned grayscale depth video. The app now enforces the measurable media envelope, but not semantic frame correspondence. Effect quality, depth adherence, preservation, temporal consistency, hardware requirements, offline behavior or platform compatibility remain unqualified.

Sources and license declarations are versioned in `manifest.json` and `effect-recipe.json`. The Wan 2.1 VACE weight declaration follows the upstream Apache-2.0 license file; the dependency audit is incomplete.
