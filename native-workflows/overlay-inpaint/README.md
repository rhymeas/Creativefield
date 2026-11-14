# Overlay inpaint

Takes app overlays off a clip: the like/comment/share column with its counts, the avatar, the
caption line, the music ticker.

The server runs this pack itself. It is not in a picker: `clean: true` on a video source measures
the still pixels inside the picture, writes them as a mask, and runs this graph over the clip in
81-frame windows. Everything outside the mask is the source's own pixels; only the masked area is
re-painted. The prompt names the colour measured around the overlays ("A plain orange studio
wall."), the mask is fed as a hint filled with that colour, and the sampler runs 30 steps at full
denoise. A window that still shows app marks is painted once more from its own result with a new
seed. See `docs/TRANSFORM-VIDEO.md` and `server/video-overlay-mask.ts`.

Inputs are the aligned video/mask pair (`aligned_video_mask_v1`): the same frame count, size and
rate. The graph is the qualified Wan 2.1 VACE 1.3B masked edit with a removal prompt, so it needs
the same models and nodes as `wan21-vace-masked-edit`.
