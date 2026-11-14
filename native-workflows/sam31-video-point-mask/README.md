# Point-selected video masks

ComfyField's Video → Edit → Select area → Click object uses the installed SAM 3.1 checkpoint. Include/exclude clicks on the paused first frame seed one object. Arrow keys move a cursor, Enter adds, Shift+Enter excludes, and Alt+arrows moves one pixel. Undo and Clear adjust the selection. Tracking starts only with **Track this object**.

The server validates 1–32 points, at least one include point, first-frame coordinates, source identity and the pinned checkpoint. `SAM3_Detect` creates the initial mask; `SAM3_VideoTrack` follows it through the source frames. The generated mask retains the existing source-linked receipt and explicit review/approval gate. A lost response retains the frozen selection and request identifier; confirmation reuses that identifier.

Supported admission envelope: one object, frame zero, 17–81 frames at constant 16 FPS, maximum 832 pixels per side and 399360 pixels per frame. No SAM 2 node, new checkpoint download, paid API or hosted route is needed. Installation/readiness checks still apply to other machines.

Local qualification on 2026-10-22: prompt `61e54018-74fc-4152-877c-03563e5b18e3`, cleared fictional jacket clip, 832×480, 17 frames, 16 FPS. Retrieved grayscale MP4: 19466 bytes; SHA-256 `512453b93efdd259cf13cadc37bb73cc84fba0f9b4318f4683aeef5a8025ca88`. Every decoded frame contains selected and protected regions. First-frame jacket selection inspected visually. This single fixture does not establish general occlusion, hair, multi-object or three-fixture quality acceptance.

ComfyUI core software and model weights have different licenses; see the manifest and repository license inventory. Model weights are not included in this pack.
