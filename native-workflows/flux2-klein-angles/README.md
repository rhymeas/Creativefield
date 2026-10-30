# Flux 2 Klein 4B camera angles

A camera-angle pack for one reference image. It reuses
`../flux2-klein-edit/template.api.json` unchanged. The reference image is the
same scaled latent, and each preset appends one viewing direction to the edit
prompt. No image is overwritten: every picked angle is a separate run and gets
its own Slate.

## Recipe 0.2.0 — first visual fixture failed

The default note now preserves the source scene rather than requesting an
unrelated snowy-mountain background. Presets explicitly move the camera around
a stationary scene, describe the newly visible surfaces and foreground/background
parallax, and retain identities, poses and object placement. This is a candidate
prompt change, not a measured quality improvement. The unchanged graph has
no geometric camera-pose input.

The preceding 0.1.0 left/right batch executed and exported successfully but
failed opposing45-degree visual acceptance on a complex chess-courtyard scene:
see `../../docs/F01-REAL-ACCEPTANCE.md`. An approved two-job0.2.0 comparison
through official SDK0.5.0 also succeeded but failed the same visual criterion.
Neither recipe is qualified for opposing45-degree viewpoint fidelity. Further
prompt-only retries on this fixture are stopped; investigate a dedicated angle
mechanism before broader quality acceptance. No paid API or model download was
used in the comparison.
The version change prevents saved0.1.0 batches from silently resuming with new
instructions. Compatible old receipts and outputs remain visible. Recover saved
request replays only a possibly accepted request, retaining its original version,
note and key. Unsent angles are left alone. After that outcome and any accepted
runs resolve, New angle batch explicitly clears the receipt before a fresh
selection. No runtime was restarted or model downloaded for this source change.

The candidate uses concrete narrative editing instructions, consistent with
[BFL's Klein prompting guidance](https://help.bfl.ai/articles/7592221790-how-do-i-generate-quickly-with-flux-2-klein).
That guidance is not evidence that the candidate achieves the requested angles.

Source validation: nine focused angle-batch/action/sheet checks and
`npx tsc --noEmit` pass. The compiled-graph regression checks fresh defaults,
distinct viewpoint binding, unchanged source/step binding and rejection of an
old-revision batch. No new visual output is claimed by these checks.

## Presets

Eight directions: `high-left`, `high`, `high-right`, `left-45`, `right-45`,
`low-left`, `low`, `low-right`. Every instruction asks to keep the subject,
wardrobe and setting from the reference.

## Verification

- 2026-10-21, local ComfyUI 0.37.0 / RTX 4090, warm worker.
- Run `f8e59d5f-b610-4ee0-af3f-9b0bbb143bca`, preset `high-left`, source
  `flux2-klein-t2i_00020_.png`.
- Succeeded in 9.9 s, one 1,500,574-byte PNG, asset
  `c05444f5-628d-4842-8249-365e4d3ef06e`, scene 1 / shot 1 / take 1.
- This proves the graph, preset composition and Slate path. It does not prove
  identity fidelity on every face, wardrobe or set; review each angle.

## Limits

- The single selector runs one angle per Generate action. The existing studio
  also supports a multi-angle batch and cross-run PNG export; see
  ../../docs/FILMMAKING-S28-S30.md for actual SDK runs, interrupted-response
  recovery and source-hash evidence. Batch request recovery uses this browser
  session; individual server runs remain durable.
- Missing source images and incomplete batches are reported in the studio; no
  placeholder output is published.
