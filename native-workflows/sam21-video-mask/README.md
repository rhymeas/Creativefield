# SAM 2.1 one-object video mask

This is an **experimental, unavailable** local workflow candidate for EDT-01. It propagates one object through an exact 16 FPS source from include and exclude points placed on frame zero. It does not provide later-frame corrections, boxes, multiple objects, discovery, normalization, identity replacement, or verified tracking quality.

The graph is mapped to Kijai's `ComfyUI-segment-anything-2` at commit `0c35fff5f382803e2310103357b5e985f5437f32`. That repository calls itself work in progress and for testing only. Its loader downloads missing weights automatically; ComfyField must check the model inventory and fail closed before submission, so the auto-download branch is never the installation mechanism.

The graph passes the pinned loader selector `sam2.1_hiera_tiny.safetensors` with `precision: fp16`. At commit `0c35fff5f382803e2310103357b5e985f5437f32`, the loader resolves that pair to the installed checkpoint `sam2.1_hiera_tiny-fp16.safetensors`. The resolved file is pinned to repository revision `f885607d88bb3f9145efa49c3e3c50a9e5bf13eb`, 77,980,668 bytes, SHA-256 `974d84a2a54080b3d00ef3d6be08da48635389834e02ad4793c6404b2dd2e851`. It belongs under `ComfyUI/models/sam2` on G: according to the project storage policy. No weight has been downloaded by this repository change.

The workflow output uses `source_linked_mask_v1`, separate from the VACE editor's `aligned_video_mask_v1` input-pair contract. Server ingestion freezes the source snapshot, validates decoded geometry/FPS/frame count and polarity, recomputes media hashes, records workflow/route and required-checkpoint provenance, publishes atomically, and requires explicit user review before attaching the mask. Worker inventory currently confirms the required model filename; it does not attest the hash of the model actually executed.

No local run, offline test, temporal-quality evaluation, restart recovery, cancellation behavior, or browser flow has been qualified. The manifest remains `experimental`; the working editor therefore renders no tracking action.
