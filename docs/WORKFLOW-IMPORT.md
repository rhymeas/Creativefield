# Saved ComfyUI workflows in ComfyField

> Historical implementation notes. Availability and supported nodes can differ in the current release.

Status: bounded v1 backend integrated in source; earlier end-to-end evidence is recorded below. The current production process has not been restarted for this checkpoint. Arbitrary workflow import is not enabled.

## What it does

- `#nodes` has a Workflow shelf above the official ComfyUI editor.
- A creator can list saved workflows from the worker's ComfyUI userdata, preview
  the conversion, and import the snapshot as an app-owned draft.
- Import converts UI JSON with `uiToApi`, enforces the reviewed local-node
  allowlist, and validates the generated capability before writing anything.
- A published revision appears in the normal workspace catalogue, so it uses the
  existing Video/Image menus, composer controls, run admission, takes, slates,
  output assets and history.
- Reimport creates a new immutable revision. Old runs keep the old pinned
  revision. ComfyUI edits never mutate an existing app revision.
- Unpublish removes the workflow from the workspace catalogue but keeps the
  revision and its runs.

## Bounded v1 rules

Supported outputs: `SaveImage`, `SaveImageAdvanced`, `SaveVideo`.
Supported input loader: `LoadImage` (zero or one in v1).
Required: one string prompt field.
Optional: one string negative-prompt field.
Scalar controls: seed, steps, cfg, width, height, batch size, frame count, only
when the value is already a literal in the graph.
Unknown node classes, unsupported outputs, multiple outputs and multiple image
inputs fail with node id, class and reason. Nothing partial is saved.

## Persistence

- `user_workflows`: workspace-scoped stable slug and label.
- `user_workflow_revisions`: immutable manifest, API graph, mapping, source name,
  source sha256, graph sha256, version and publication flag.
- One published revision per workflow; one workflow slug per workspace.
- Live readiness is computed from the selected worker and is not stored as a
  permanent status.

## Proof

- Source: saved ComfyUI workflow `Qwen Image 2.1 - Text to Image.json`.
- Converted: 9 API nodes, one `SaveImageAdvanced` image output, no image inputs.
- Controls: prompt, negative prompt, batch size, seed, steps, cfg.
- Published workflow `imported-proof-qwen-t2i` appeared in `/catalogue`.
- The normal `POST /runs` API executed it on the real worker. Run
  `[local run]` succeeded.
- Unpublishing hid it from `/catalogue`; the revision and run remain.

## Limits

- The proof workflow was text-to-image. A saved workflow with an image input is
  supported by the importer contract but was not the recorded proof run.
- One prompt, one negative prompt, one image input and one output in v1.
- No arbitrary custom-node support; the node allowlist is the behavior policy.
- Revision pinning preserves the workflow definition and declared dependencies,
  not pixel-identical results when models, nodes or the runtime change.
- Browser shelf verified at 1440 px against the built app: the saved draft
  `Proof Qwen T2I` appeared, `Import saved workflow` listed the four ComfyUI
  userdata files, and `Preview mapping` showed 9 API nodes, one
  `SaveImageAdvanced` output, prompts/controls and 12 dependencies. Screenshot:
  `.openchamber/screenshots/workflow-shelf-preview-1440-2026-10-22T10-46-49-672.jpg`.
  The 2400 px headless capture came back blank and is not claimed.


## Revision transaction verification — 22 October 2026

All reimport, publish and unpublish operations now lock the workspace-scoped parent workflow row for their transaction. Reimport reads the next version after acquiring that lock; network preview happens before it. Concurrent imports of one slug return a conflict rather than an unhandled unique-key error. Unknown workflows/revisions return 404 without changing publication.

The new authenticated-route integration fixture uses isolated real PostgreSQL and a local source server. Conversion is explicitly stubbed with an existing validated native bundle: these tests qualify lifecycle persistence and locks, not new model/converter/output quality. A held parent lock lets both reimport previews reach the transaction boundary before release. Both requests succeed with distinct versions 2 and 3; version 1 retains its manifest, template and source/graph hashes, and stays published while new revisions remain drafts. Concurrent publications and publish/unpublish complete without violating the single-publication constraint; another workflow's revision and anonymous publication are rejected. Concurrent duplicate imports leave one revision and return 200/409.

Focused result: 14 tests pass across workflow import, revision HTTP/PostgreSQL lifecycle and platform integration. Frontend/server types, staged-index types (383 indexed files, zero diagnostics) and production build pass. Frozen full checkpoint:135files/897tests passed in294.09seconds. After that checkpoint, a narrow slug-normalization fix trims separators after the64-character cutoff; final24focused lifecycle/converter checks pass, including the new long-label persistence regression. The full-suite count precedes that added test and is not a claim of898full-suite passes. No live worker/model update, app restart, inference or browser reload was performed for these backend changes. Remaining 3D navigation/shelf UI integration is a separate pending worktree group.
