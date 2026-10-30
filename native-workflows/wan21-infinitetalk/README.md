# Local single-speaker portrait animation

This pack uses native Wan InfiniteTalk, one portrait, mono PCM16 WAV and the
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
