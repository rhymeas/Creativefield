# Scene-reference video-frame experiment

This is the existing five-frame SCAIL control with a different reference-preparation branch.
`scene_image` is an existing image asset; no still is generated or approved by this workflow.
The image is resized in full to the same model canvas (`ImageScale`, crop disabled). That same
image feeds `WanSCAILToVideo.reference_image`, CLIP vision and reference tracking. Both colored
mask nodes use the same selected identities and the same fitted-image tracking data. Identity
masks remain correspondence hints; this pack adds no external person/portrait crop.

The installed SCAIL replacement node itself multiplies the reference by its identity mask
before VAE encoding, which makes its reference background black. CLIP vision still sees the
complete scene. Passing the correct scene image therefore does not guarantee preservation of
its background. The first seed variation reproduced both figures but lost the orange wall;
this mode is not visually qualified and must not replace the retained Flux baseline.

Version 0.1.1 exposes the existing shared `replacement_mode` boolean for a bounded
comparison. Its default stays `true`, reproducing 0.1.0. Setting it to `false`
selects Animation Mode consistently in the Wan conditioner and both colored-mask
nodes. This also changes `ref_mask_flag` and mask background colors; it is not a
matte-only switch. No installed ComfyUI source is patched.

Version 0.1.2 defaults this scene-image path to Animation Mode after the initial
seed2 case and confirmations with seeds1 and3 retained the orange scene and full
figure layout on the pinned clip/reference. These are five-frame seed checks,
not a qualification of other clips, long motion, exact likeness or photorealism.
The small triangle already in the reference remains. Replacement Mode is still
available explicitly for comparisons. Raw-reference probe defaults are unchanged.
The scene receipt context records Animation Mode so old mode results are not
silently reused as evidence for the new default; historical run assets remain.

Model, LoRAs, sampler, steps, CFG, driving-video preparation and five-frame budget are retained
from the raw-reference control. PNGs come from decoder indices 1 and 4. There is no full-video
encoder or upscale. Admission freezes the image asset ID, SHA-256, size and dimensions; native
and SDK execution refuse changed or missing reference bytes before submission.

The UI's **Use a scene frame** choice accepts an existing library image or an upload. A generated
scene candidate can also be passed with **Use for video**. These select an experimental input;
they do not approve its visual quality. Reloading restores the chosen reference and run without
submitting another job. Changing the clip/characters clears the scene selection.

Visual qualification is pending. Exact provenance and graph wiring are software checks;
identity, pose, scale and overlay cleanliness require actual model outputs. Preserve the prior
baseline, and require an initial success plus two slight-variation confirmations before

