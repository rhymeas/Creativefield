# Qwen Image 2.1 guided edit — candidate local route

This ComfyField pack is a curated API graph converted from the installed official ComfyUI image-edit workflow. It accepts an edit target at node `470`, one required reference at node `475`, and a text instruction at `459:474.prompt`. It uses only `comfy-local` and declares no hosted provider, Higgsfield dependency, comparator, or fallback.

The original workflow's node `472` (`ImageCompare`) and its two display-only links are omitted. The node is an editor comparison surface, not part of generation, and its unconnected `compare_view` widget prevents API conversion. The graph retains both generation inputs and the saved output path. CFG remains 1, so negative prompt is deliberately not exposed. Output is 8-bit sRGB PNG from node `461`. `audioPolicies: ["mute"]` exists only because the shared manifest schema currently requires an audio-policy field; image artifacts have no audio track.

## Provenance and readiness boundary

- Installed UI workflow SHA-256: `d6dd8695469c20ca5e77b4bddf981b898ee0e034f0cfc5840c86f15b812ca081`.
- Conversion: `src/workflow/ui-to-api.ts` against the live ComfyUI 0.37.0 `object_info` inventory after removing node 472 and links 707/708; thirteen API nodes.
- The bundled graph replaces the two upstream sample filenames with explicit run-bound placeholders, clears the sample edit instruction, uses seed 42, and changes only the save prefix to `ComfyField/qwen-image-21-edit`.
- The graph and local inventory are inspected, not runtime-qualified. Do not promote the route from `experimental` until a real ComfyField run verifies upload binding, submission, output import, PostgreSQL provenance/version linkage, browser rendering, cancellation/recovery behavior, and the claimed offline boundary.

The weights are published under the Qwen Research License Agreement. It grants non-commercial research/evaluation use only; commercial use requires a separate license from the Qwen licensor. This pack does not grant that authorization.
## Qualification 2026-10-18 (reproducible)

Direct graph run against live ComfyUI 0.37.0 / RTX 4090: prompt 4af9a21-0d69-414d-a772-1b2ef1879e01, 51.2 s, 1024x1024 PNG, SHA-256 c6474b83d83d720e8a15fb40d91827e7c773faf318ce86e77c72ca11adcd7c78.

Full ComfyField run through the durable queue: two uploaded project images, run 46d4c42d-b645-4397-be35-8e9ae00772f2, 48.2 s, imported asset 7587cbad-6f29-47e2-90d5-cbfebec509ae (1024x1024 PNG, 1,789,664 B) with PostgreSQL provenance (local_comfy, workflow hash c3ee35df...). This proves upload binding, submission, output import and provenance. Perceptual quality on arbitrary content and offline behavior remain unqualified. The Qwen weights stay research-only; commercial use needs a separate license.

## Revision 0.2.0 — optional additional references

The current pack adds two optional LoadImage nodes (15 template nodes total). Compilation omits each missing optional loader and its Qwen autogrow socket, leaving the original 13-node path for ordinary single-reference editing. Present references occupy image_3/image_4; the target stays image_1. The installed TextEncodeQwenImage21 schema exposes up to 16 autogrow images. Only this reviewed optional-image link shape may be omitted; required/shared/non-image consumers fail validation. See docs/REFERENCE-EDIT.md for binding/browser evidence and outstanding real-model qualification. The original workflow hash and real two-image runs above remain historical provenance, not proof of multi-reference output quality.
