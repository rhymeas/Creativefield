# Protected-subject background mask

This local pack reuses the installed `sam31-video-mask` SAM 3.1 graph and checkpoint. An `InvertMask` node turns the tracked subject into the protected black region; the background becomes the editable white region. It requires no additional model download.

In **Video → Edit**, choose a source clip, **Describe object → Background**, describe the subject to keep, then **Select background**. Review the actual decoded mask frames and explicitly select **Use this mask**. Choose **Edit ideas → Replace background** or write a background prompt, then queue the existing VACE masked editor. Selecting the mode does not submit a job.

The existing source-linked mask contract pins the source hash, geometry, timing, checkpoint and producing run. Background output admission additionally requires both protected and editable pixels in every decoded frame. A lost subject or entirely protected frame fails before the mask is published; it is not automatically retried as a new generation. This check detects empty regions, not semantic correctness. Review boundaries, occlusions and unwanted selected objects yourself.

Supported source envelope is inherited from local tracking and VACE admission: 16 FPS, 17–81 frames, up to 832×480 landscape or 480×832 portrait. Outputs are muted. Existing mask review, manual mask corrections, cancellation and idempotent recovery remain in use. Video encoding can change pixels outside the mask; preservation is not a bit-exact video promise.

Qualification and remaining limits: [VIDEO-BACKGROUND-EDITING.md](../../docs/VIDEO-BACKGROUND-EDITING.md). Software and weight terms remain those declared in `manifest.json` and the repository license inventory. No model weights or upstream implementation source are bundled here.
