# Flux 2 Klein precision still edit

This workflow extends the existing editor and installed Klein4B image-edit graph.
It does not implement or vendor the Klein Edit Composite algorithm. Version0.1.2
adds a pre-submission crop-geometry budget to the tested0.1.1 graph; it does not
change the upstream image algorithms. Manual aligned PNG masks work without SAM.

## External dependencies

Install into the existing ComfyUI custom_nodes directory, outside ComfyField:

- https://github.com/supermansundies/comfyui-klein-edit-composite at
  `1505bc58d38abf5411457804ed4923e83f986eee`.
- https://github.com/comfyorg/comfyui-crop-and-stitch at
  `2abf837822d761110ac383d9a1cdffcc7ebfab36`.
- The tested portable Python used OpenCV headless5.0.0.93 with its existing
  NumPy2.5.2/Torch2.13+cu130. No NumPy/Torch upgrade or weight download was needed.
  Existing installed Klein4B/Qwen3-4B encoder/Flux2 VAE files are required.

Check `/object_info/KleinEditComposite`, `/object_info/InpaintCrop` and
`/object_info/InpaintStitch` after activating the nodes. Requirements hide the
Preserve original controls when the route is unavailable. The original worker
was not restarted during this run: automatic approval rejected that action.
A temporary worker from the same installation was used for actual verification.
The original worker needs a normal restart before it can discover these nodes.
Do not change preview launch flags for this workflow.

Klein's inspected revision has no explicit source license file. It is not bundled
in this repository or a redistributed installer; local installation does not
establish redistribution permission. Crop & Stitch carries GPLv3. Weight licenses
remain separate; see manifest.json and docs/LICENSE-INVENTORY.md. No commercial
compatibility or redistribution clearance is claimed for the combined dependency set.

## Actual data path

Original PNG + same-size manual PNG mask → upstream InpaintCrop → existing
Klein4B image edit → upstream InpaintStitch → upstream KleinEditComposite →
final PNG, full-size candidate PNG, effective-mask PNG and PreviewAny text report.
Original/mask inputs, outputs, lineage, report, declared dependency commits and
pixel measurement are retained in the durable run/artifact records.

The generated crop goes directly back to Stitch at the crop's own dimensions.
An extra megapixel resize in the initial integration was removed after visual
QA showed incorrect framing. No upstream node source was modified.

Default manual mask mode is replace. Add/subtract are the installed upstream
modes and can expand/change the effective mask. The review shows the effective
mask, not a promise that it equals the painted mask. Crop mask blur/blend are0;
Klein feather defaults to0.5% of the image diagonal. Candidate and final stay
separate so additional blending or reverted edits can be inspected.

## Limits and measurement

- One still per run; aligned dimensions divisible by8, maximum2048 per side.
- All-white/all-black manual masks are rejected before queueing. Tiny selections
  are rejected if the conservative forced-crop estimate exceeds16,777,216
  upscaled pixels. Increase Context in Advanced or enlarge the selection. This
  is a geometry bound, not measured RAM/VRAM consumption.
- QA compares decoded sRGB8 RGB channels. Effective-mask values above0/255,
  including its feather band, are excluded. A protected pixel changes when any
  RGB-channel delta exceeds2/255. Tolerance is0.1% of protected pixels. Alpha is
  not measured. An all-covering effective mask reports no measurable protection.
- QA observes pixels; it never composites, aligns, repairs or rewrites them.
  Keeping a candidate is an explicit user action and adds an undoable editor layer.
- Global relight, angles, camera and teleport controls do not receive this switch.
- The current multi-artifact transport is native local ComfyUI; the existing SDK
  path remains available for supported ordinary image runs. Full SDK artifact
  transport is tracked separately; this pack does not claim SDK execution.

## Real evidence · 2026-10-21

Sources were generated locally from plain prompts with no named people, brands or
third-party characters. Three independent runs used an explicit existing project
and temporary local worker; no project or product duplicate was created.

| Fixture | Tested0.1.1 run | Protected pixels | Changed >2/255 | Maximum protected-channel delta |
|---|---|---:|---:|---:|
| Jacket red→blue | b894a82e-00c7-4c16-b30e-d76b3132d3eb |121868|0|1/255|
| Mug red→blue | fb0ebf89-b8a6-4f82-9122-509d8b91109f |219788|0|1/255|
| Plant→lamp |74b13f0b-71af-4088-885e-7d6fe0419139 |229058|0|1/255|

The initial rectangle-mask cases had poor framing/incomplete object coverage;
their immutable runs are retained. Corrected color-wand masks were used for the
red jacket/mug; the background used a corrected local rectangle. Visual review
confirms the intended changes in the corrected cases. The lamp still has a
visible light boundary inside the mask. Color-wand edges retain small original
highlights. Zero out-of-mask threshold exceedances do not establish semantic or
photoreal quality. The candidate-vs-final ablation found0/1/0 changed core pixels
returning below threshold in jacket/mug/background; this is a diagnostic count,
not proof against all forms of edit reversion or double feathering.


Each receipt records source/edit run IDs and exports original, input mask,
candidate, effective mask, final, drift, report, workflow and provenance. The
ablation-summary.json contains the declared core/band measurements.

## Re-run explicitly

Use `scripts/precision-edit-e2e.mjs` with COMFYFIELD_PRECISION_QA=1 and explicit
COMFYFIELD_WORKSPACE_ID, COMFYFIELD_PROJECT_ID, COMFYFIELD_QA_WORKER_ID. Choose

Existing receipts resume existing jobs; unknown, failed and timed-out jobs are
not automatically resubmitted. `--refine-mask` explicitly requests the corrected
fixture mask and retains the previous attempt's identity. No model is downloaded.

Final acceptance: version0.1.2 UI admission/cancel run2a333179-96a8-4224-ba8f-77ed4776e210 recorded Context64px and Feather0.2% from actual keyboard slider actions. Retake824d7cc8-e073-4e97-9917-c59dacfc2626 preserved the original inputs/seed, received a new ledger take, and was canceled through the real UI. Comparison height468px and its slider remained within900px-high viewports at1280/1440/2400. PNG download matched the published215058 bytes; saved JSON included the measured receipt. Keeping a candidate added a layer; Undo removed it. Full suite105 files/743 tests passed; the final changed-contract checks26/26 and TypeScript/build/browser checks passed.
