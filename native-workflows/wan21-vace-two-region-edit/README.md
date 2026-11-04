# Two-region video edit

Powers **Add edit** in the existing masked video editor. Choose two independently reviewed source-aligned masks and prompts, then explicitly queue one combined output. Admission freezes both verified receipts; execution rechecks files and approvals before upload. Pending-request recovery reuses the original idempotency key. Cancellation and explicit new takes are supported.

Both VACE branches read the same original video and share the installed model/text encoder/VAE. Each has its own prompt and mask. Composite the first generated area into the original, then the second into that result; the second area wins overlaps. One SaveVideo publishes the result using source dimensions, frames and FPS. No mask rebinding or regional-conditioning node is needed.

Actual app/native qualification on 22 October 2026: cleared fictional jacket clip, real SAM point/background masks and explicit approvals. App run 8e3c5ba4-e422-41a3-b16a-8febce732ccd, native prompt c6b762d7-095b-4807-8570-597e55f8e3e4. Output: 832 × 480, 17 frames, 16 FPS, mute, 288750 bytes, SHA-256 ed7794aa838b6d84f34890323fdf1014c258ded6975b56202b470d02c7b669b7. Inspected frames show blue garment and yellow background together. Garment structure changes and edge remnants remain; this is not identity, occlusion or three-fixture quality acceptance.

Masked media retains native transport even when SDK is configured. Weights are not bundled; licenses follow the single-mask pack. No new model download is needed for the qualified installed setup. See docs/TWO-REGION-VIDEO.md for admission, browser/recovery checks and remaining limits.
