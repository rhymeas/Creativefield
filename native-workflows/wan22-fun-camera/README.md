# Wan 2.2 Fun Camera

This bundle maps ComfyField's Camera/Cinema capability to the native ComfyUI Wan 2.2 Fun Camera nodes. It has one local route and no hosted provider.

The implemented graph controls nine exact camera trajectory presets, speed, prompt, negative prompt, seed, duration, and a required start image. Output is fixed to 640×640 at 16 FPS for this first qualification slice. Lens, focus, framing, subject lock, arbitrary paths, combined moves, drone/crane labels, and prompt suggestions are outside this graph's control contract.

The local route is implemented after both pinned FP8 models were installed and
SHA-verified onG:, a native17-frame Pan Right trial succeeded, and an actual app/SDK
81-frame Zoom In run was imported with provenance. The default is a short one-second
trial. Other hardware, every preset/speed's visual quality and air-gapped operation
remain unqualified. A local graph does not establish that network access was disabled.

See `docs/CAMERA-CONTROL-EVIDENCE.md` for the evidence boundary and promotion gate.
