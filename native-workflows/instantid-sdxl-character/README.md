# InstantID SDXL character references

This bundle replaces the planned `elements` catalogue placeholder with an **experimental, unavailable** local workflow candidate. It accepts one face reference and produces one candidate SDXL character-reference image. It does not create or prove a consistent identity, reference pack, consent record, or production-ready character by itself.

The graph is mapped from cubiq's official `ComfyUI_InstantID` README and `InstantID_basic.json` example at commit `72495e806bc2ab9c41581e15ccaa1bcf83c477e8`. The exact custom nodes are `InstantIDModelLoader`, `InstantIDFaceAnalysis`, and `ApplyInstantID`. The reviewed upstream instructions require:

- `ip-adapter.bin` in `ComfyUI/models/instantid`;
- `diffusion_pytorch_model.safetensors` in `ComfyUI/models/controlnet/instantid`;
- the complete `antelopev2` pack in `ComfyUI/models/insightface/models/antelopev2` (not `buffalo_l`);
- an SDXL checkpoint; this template retains the example's `sdxl/AlbedoBaseXL.safetensors` name so a checkpoint change requires an explicit bundle revision and review.

No checksums are asserted because the reviewed sources do not provide checksums for these exact files. No weights are downloaded or redistributed. The custom-node project declares Apache-2.0 and maintenance-only status; the InstantX model repository declares Apache-2.0. The antelopev2 and example-checkpoint terms remain operator-verification requirements.

The local route stays `experimental`, so readiness remains unsupported even when a worker reports every named node and model. `compileLocal` refuses the route, and the custom nodes have not been added to ComfyField's executable allowlist. No graph run, identity-consistency evaluation, output-quality evaluation, offline test, restart recovery, cancellation behavior, or hardware profile has been completed. The hosted status is separately `planned`; there is no selected hosted provider or adapter.

If this candidate is later qualified, outputs must still be ingested as immutable, project-scoped assets and attached to a server-authorized character record with frozen source and workflow provenance. A multi-image reference pack and identity-consistency evaluation are later gates, not properties of this graph.
