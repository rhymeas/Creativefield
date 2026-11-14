# Qwen Image 2.1 text to image — qualified local route

This ComfyField pack is a curated API graph converted from the official workflow installed by `comfyui-workflow-templates-json==0.1.92`. It uses only the local `comfy-local` execution route and declares no hosted provider, Higgsfield dependency, comparator, or fallback.

The graph binds prompt, aspect ratio, megapixel budget, batch size, steps, and seed. CFG stays at the workflow's value of 1, so negative prompt is deliberately not exposed: the installed template states that negative conditioning is unused at CFG 1. Output is 8-bit sRGB PNG from node `461` (`SaveImageAdvanced`). `audioPolicies: ["mute"]` exists only because the shared manifest schema currently requires an audio-policy field; image artifacts have no audio track.

## Provenance and readiness boundary

- Installed source package: `comfyui-workflow-templates-json==0.1.92`; UI workflow SHA-256: `d33a6b36d530756e26ef4e25beb17d950daaea09d295475cd65f97f5d0af3b41`.
- Qualified packaged API graph SHA-256 (UTF-8 with LF line endings): `56820925cb5999068f70e1e0c04af040b235acb41e610d78b97fe1b46cdd7dd7`.
- Conversion: `src/workflow/ui-to-api.ts` against the live ComfyUI 0.37.0 `object_info` inventory; nine API nodes.
- Relative to the packaged UI workflow, the bundled graph replaces the long example prompt with an empty user-bound prompt, changes the default seed from `593103825222985` to `42`, and changes the save prefix to `ComfyField/qwen-image-21-t2i`.
- The exact packaged API graph completed a direct ComfyUI 0.37.0 qualification on the current RTX 4090 worker: seed `20261017`, 25 steps, 1:1 at 1 megapixel, 50.603 seconds, and a 1024×1024 PNG of 1,134,614 bytes with SHA-256 `042d9d86a4596a051ade4daaa3da3b77c497d7d228d581046704b8366570e686`. A subsequent ComfyField run verified local submission and managed output import.
- `implemented` describes this qualified local route, not every machine or ComfyUI build. Catalogue readiness currently verifies required node and model filenames; it does not re-hash model files or enforce the ComfyUI version. The manifest hashes are acceptance provenance, so another worker or changed installation requires requalification. The evidence is not a quality benchmark, offline guarantee, memory measurement, commercial-use authorization, or proof that every batch size has completed on real hardware.

The weights are published under the Qwen Research License Agreement. It grants non-commercial research/evaluation use only; commercial use requires a separate license from the Qwen licensor. This pack does not grant that authorization.
