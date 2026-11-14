# Local single-speaker portrait animation

This modular app is a bounded adaptation of the official ComfyUI Hub workflow
recorded in `manifest.json` (`video_wan2_1_infinitetalk-b95499a55c9f`). It was
imported and adjusted through native ComfyUI nodes for ComfyField's explicit
inputs, duration window and artifact contract; it was not rebuilt as a separate
feature-only graph.

The pack uses native Wan InfiniteTalk, one portrait, mono PCM16 WAV and the
official Lightx2v I2V adapter. The voice contract freezes permission and inputs,
validates the bounded audio source and uses one trim window for both conditioning
and output audio. CFG1 avoids the doubled audio-conditioning batch; the negative
prompt is intentionally not exposed. Output supports480x832/832x480 at25fps,
with requested1–3.2second windows mapped to native4n+1 frames.

Actual81-frame app output with matching3.24s video/audio and native transport is
documented in docs/LIP-SYNC-EVIDENCE.md. Mouth movement worked on the close-up
fixture; full-body motion was weak. Exact phoneme/identity/background fidelity,
physical microphone quality and other hardware remain unqualified. Weights stay
external on the operator's model volume; the manifest pins sources and hashes.
