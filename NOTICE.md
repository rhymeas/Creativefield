# License scope and external components

Copyright (c) 2026 bashpacks.

ComfyField application and integration code by bashpacks is licensed under
the root GNU GPL version 3 license (`GPL-3.0-only`). Existing third-party copyright and license notices
remain applicable. This grant does not relicense external dependencies,
ComfyUI, custom nodes, model weights, uploaded media or generated assets.

ComfyUI and the configured model library are separate installations and are
not included in this source checkout's app bundle. Consult
[the declared workflow license inventory](docs/LICENSE-INVENTORY.md) and each
upstream license before distributing a combined installation or media.
The inventory is incomplete and is not a legal clearance certificate.

The inspected Klein Edit Composite revision has no explicit source license;
it is not vendored or redistributed here. Local precision-editing execution
does not establish redistribution permission. Crop & Stitch is GPL-3.0 at
the inspected revision. Optional SolarRenderer integration remains disabled.
Do not package these external installations or model libraries as if the
application's license covered them.

The optional NVIDIA VFX pack uses ComfyUI Nvidia VFX Nodes, which is
Apache-2.0. Its `nvidia-vfx` Python runtime is NVIDIA proprietary
(`LicenseRef-NvidiaProprietary`), is installed separately from NVIDIA's package
index and is not included or relicensed here. The pack downloads no model
weights. See docs/NVIDIA-VFX.md and
[docs/LICENSE-INVENTORY.md](docs/LICENSE-INVENTORY.md).

The utility packs bg-remove-birefnet, upscale-image-esrgan, palette-transfer-image,
image-face-mosaic-sam3, scene-mesh-moge, video-trim, video-concat-2, kenburns-still
and video-bg-remove-birefnet use ComfyUI API graphs from
workingprototype/Fuobe (https://github.com/workingprototype/Fuobe, MIT License,
Copyright (c) 2026 workingprototype and the Fuobe contributors, commit c307034).
The graph structure is kept; only output prefixes, and for upscale the loader file
name, are set. Their model weights keep their own terms and are not included.
See [docs/LICENSE-INVENTORY.md](docs/LICENSE-INVENTORY.md).

No release ZIP or public repository publication is established by the local
verification records. Required third-party notices must accompany any later
redistribution of dependencies.

The seam check (scripts/seam-check-lib.mjs) ports the measurement and trim planning of
OpenField's Seam Doctor (https://github.com/wexloops/openfield, server/seam.ts, MIT License,
Copyright (c) 2026 David Wexler / Strangeloop Studios) and the join-frame ratio of Body
Double's per-segment QC (https://github.com/lucataco/open-source-higgsfield,
bodydouble/qc.py, Apache License 2.0). Each file keeps its upstream notice in its header.

Block a shot (server/stage/) ports the scene model, camera moves and CPU rasterizer of OpenField's
Stage (https://github.com/wexloops/openfield, src/stage.ts, src/stageMesh.ts and server/stageRaster.ts,
MIT License, Copyright (c) 2026 David Wexler / Strangeloop Studios). Each file keeps its upstream notice in
its header. Blocking a shot in grey boxes before rendering it is also the idea of Open Cinema Studio
(https://github.com/colinWWW/open-cinema-studio, MIT License, Copyright (c) 2026 ColinWWW); none of its code is used.

OpenJutsu character swap (native-workflows/openjutsu-h3-swap) runs Comfy's official graph from
https://github.com/Comfy-Org/comfy-openjutsu (MIT License, Copyright (c) 2026 Comfy Org), built on Akatz Labs'
H3 Character Swap. Its node pack, https://github.com/akatz-labs/h3-character-swap-tool worker_nodes/h3_character_swap
(GPL-3.0), and Comfy's patch are installed in the separate H3 ComfyUI and are not included here.
MiniMax H3 video (native-workflows/minimax-h3-video) uses the workflow of https://github.com/Kablex/ComfyUI-Ref2VA-VSA
(Apache License 2.0); its node is installed in the H3 ComfyUI and is not included here. MiniMax H3 weights keep
their own license.

Effect clips (native-workflows/h3-effects) uses the same Kablex/ComfyUI-Ref2VA-VSA workflow with the official
minimaxh3_* effect embeddings published in https://huggingface.co/Comfy-Org/MiniMax-H3; the embeddings are
installed in the H3 ComfyUI and are not included here. The preview pictures in public/examples/effects are frames
of our own renders of the Pexels test photos in fixtures/real.

Swap a thing (native-workflows/h3-object-swap) uses workflows/object.api.json of https://github.com/D3voz/openjutsu
(MIT, commit 7fe118b), filled the way its lib/object.ts does. Its node packs and models are installed in the H3
ComfyUI and are not included here.

Fibo 2.0 image edit (native-workflows/fibo2-edit) uses the official Comfy-Org workflow template
image_fibo2_edit_turbo_pe.json (MIT). The Fibo 2.0 weights (Bria, CC BY-NC 4.0, non-commercial use only) are
installed in the local ComfyUI and are not included here.

MiniMax H3 text to video, image to video and first and last frame (native-workflows/h3-t2v, h3-i2v, h3-flf2v),
Upscale to 2K creative (native-workflows/z-image-2k-upscale) and Upscale video quality (native-workflows/seedvr2-video-upscale)
use official Comfy-Org workflow templates (MIT). Their model weights are installed in the local ComfyUI and are not included here.

Grey-block to video (native-workflows/previs-to-video) uses the local MiniMax H3 core of the Comfy hub workflow
"Minimax H3 Video Restyling" by Comfy Org; its paid API nodes are not used.

License texts for the integrated third-party components listed above are preserved in third-party-licenses/.

The older Wan pipelines in pipelines/ contain adapted ComfyUI workflow templates;
see their README files and the workflow-templates license above. The Real-ESRGAN
video graph in pipelines/enhance/realesrgan-x4 was authored for this app.
Their separately installed model weights have their own terms. Some older
manifest formats do not record machine-readable provenance or license fields;
those records should not be treated as a complete model-license inventory.

The lockfile also names separately installed npm dependencies. Among them,
Sharp platform packages declare Apache-2.0 and LGPL-3.0-or-later components;
caniuse-lite declares CC-BY-4.0, and the bundled Fontsource packages declare
OFL-1.1. Their packages and upstream projects provide their license texts and
notices. These dependencies are not bundled in this source export; review their
terms and notices before redistributing a built package with dependencies.
