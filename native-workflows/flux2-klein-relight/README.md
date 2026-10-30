# Flux 2 Klein 4B relight

A relight pack for one reference image. It reuses
`../flux2-klein-edit/template.api.json` unchanged. The source image stays the
reference latent; a mood preset and the browser-only light guide write a
lighting instruction into the edit prompt. Every generation is a separate run
and gets its own Slate.

## Presets

Four moods: `golden-hour`, `noir`, `night`, `studio`.

## Light guide

`Flashlight` is a browser-only guide, not a render. Pointer position maps to a
direction phrase (`from the front-left`), and the wheel or Page Up/Down cycles
five temperatures: `candle`, `tungsten`, `golden`, `daylight`, `blue-hour`.
The composed prompt states the chosen direction and temperature. The result
always comes from the real run.

## Verification

- The graph is the qualified `flux2-klein-angles` copy, which was checked
  against ComfyUI 0.37.0 object_info and produced a real 1024x1024 PNG on
  2026-10-19.
- A real UI run on 2026-10-21 with the `noir` preset, `from the left` and
  `candle` succeeded through the official SDK transport:
  - run `ef968ba0-8319-4fdb-90bd-bcc6ec124f9f`, take 4
  - proxy job `c72cab34-6e3a-4c37-b8a3-9b07ab4b857d`
  - 1024x1024 output `5c51e448-a693-4dca-833c-93113a287f42`
  - visual check: black-and-white noir relight of the red cabin source.
- Identity fidelity across arbitrary sources and aspect ratios is not proven.
  Missing source images and failed runs are reported honestly; no placeholder
  output is published.

## Limits

- One mood and one light direction per Generate action.
- "Only the subject" needs `sam3-image-segment`; it is not offered here.
- The light circle is a guide. It does not alter the preview pixels.
