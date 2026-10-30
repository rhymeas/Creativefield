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
weights. See [docs/NVIDIA-VFX.md](docs/NVIDIA-VFX.md) and
[docs/LICENSE-INVENTORY.md](docs/LICENSE-INVENTORY.md).

No release ZIP or public repository publication is established by the local
verification records. Required third-party notices must accompany any later
redistribution of dependencies.
