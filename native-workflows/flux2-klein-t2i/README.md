# Flux 2 Klein 4B text to image — qualified local route

This ComfyField pack is a curated API graph converted from the official workflow installed by `comfyui-workflow-templates-json` (`image_flux2_klein_text_to_image.json`). It uses only the local `comfy-local` execution route and declares no hosted provider, Higgsfield dependency, comparator, or fallback.

The graph binds prompt, width, height, batch size, steps, and seed. Output is PNG from node `9` (`SaveImage`). `audioPolicies: ["mute"]` exists only because the shared manifest schema requires an audio-policy field; image artifacts have no audio track.

## Provenance and readiness boundary

- Installed source UI workflow SHA-256: `f5b2e75448e1ef44ab3d08da00900000f0258f8f963934370c6a1c329d1328c2`.
- Qualified packaged API graph SHA-256 (UTF-8 with LF line endings): `5fadfac55a4abe10e6fdbf5ff83bbd94ad1152e732ffc02a6fdc385a936a10ca`.
- Conversion: `src/workflow/ui-to-api.ts` against the live ComfyUI 0.37.0 `object_info` inventory; 16 API nodes. Relative to the packaged UI workflow, the bundled graph replaces the example prompt with an empty user-bound prompt, changes the default seed to `42`, sets width/height to 1024, and changes the save prefix to `ComfyField/flux2-klein-t2i`.
- The exact packaged API graph completed a direct ComfyUI 0.37.0 qualification on the current RTX 4090 worker: seed `20261018`, 20 steps, 1024×1024, 18.1 seconds, and a 1024×1024 PNG of 1,944,013 bytes with SHA-256 `98df53a08727d6fc8ebbc1a7f9b45ff5a734fe1393a822b2cc04d6ac0be2b4f8`.
- `implemented` describes this qualified local route, not every machine or ComfyUI build. Catalogue readiness currently verifies required node and model filenames; it does not re-hash model files or enforce the ComfyUI version. Another worker or changed installation requires requalification. The evidence is not a quality benchmark, offline guarantee, memory measurement, or commercial-use authorization.

The Klein 4B weights are released by Black Forest Labs under Apache-2.0; the Qwen 3 encoder follows its upstream license. Verify the exact license files in the source repositories before commercial use.
