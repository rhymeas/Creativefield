# Deterministic trim and short VACE forward extension

The version0.2 local route is implemented for short forward continuation. The existing Video → Trim workspace offers **Extend ending** when a ready local VACE worker is present. The server derives the retained context and overlap, starts a durable generation child, drops generated overlap and stitches the exact requested tail into a new asset.

The native graph uses the installed VACE14B FP8 local derivative, first-clip context through `ImageFromBatch`, a zero context mask and native gray/white-mask generation padding. Context controls are server-owned. The measured profile allows at most13 generated frames; the default5-frame overlap adds8 new frames. See [the existing qualification evidence](../../docs/VIDEO-FORWARD-EVIDENCE.md) for native/app/SDK run IDs, checkpoint hashes, restart/recovery checks and exact output facts.

One fictional creature/cabin/lake fixture was qualified at832×480. Broader motion and seam quality remain open. This is temporal forward continuation; Hub VACE outpainting expands the canvas instead. Backward extension, hidden-scene reconstruction and seamless continuity are unsupported. The generation child is mute; the parent can retain source audio according to its existing audio policy. No model weights are bundled.

